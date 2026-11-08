// Delivery: priority queues with time-to-live, quiet hours, daily budgets, merging and Telegram rate limits.
// Telegram allows ~30 msg/s overall, ~1 msg/s per chat and 20 msg/min per group; we stay under those.

import type { Alert } from './alerts.js';
import type { Store } from './db.js';
import { inQuietHours, localParts } from './time.js';
import { esc } from './format.js';

export interface SendResult {
    message_id: number;
}

export type SendFn = (chatId: number | string, html: string, markup?: unknown) => Promise<SendResult>;
export type KeyboardFn = (deliveryId: string, alert: Alert) => unknown;

interface Queued {
    alert: Alert;
    deliveryId: string;
}

interface RawQueued {
    html: string;
    priority: number;
    expiresAt: number;
    markup?: unknown;
}

export interface DeliveryStats {
    sent: number;
    merged: number;
    expired: number;
    held: number;
    dropped: number;
    failed: number;
}

export class Dispatcher {
    store: Store;
    send: SendFn;
    keyboard: KeyboardFn;
    perSecond: number;
    queues = new Map<number, Queued[]> ();
    raw = new Map<string, RawQueued[]> (); // channels and other non-user targets
    lastSent = new Map<string, number> ();
    groupWindow = new Map<string, number[]> ();
    tokens: number;
    lastRefill: number;
    pausedUntil = 0;
    timer?: NodeJS.Timeout;
    busy = false;
    stats: DeliveryStats = { sent: 0, merged: 0, expired: 0, held: 0, dropped: 0, failed: 0 };
    now: () => number = () => Date.now ();

    constructor (store: Store, send: SendFn, keyboard: KeyboardFn, perSecond = 25) {
        this.store = store;
        this.send = send;
        this.keyboard = keyboard;
        this.perSecond = perSecond;
        this.tokens = perSecond;
        this.lastRefill = Date.now ();
    }

    start (everyMs = 50): void {
        this.timer = setInterval (() => {
            void this.pump ();
        }, everyMs);
    }

    stop (): void {
        if (this.timer) {
            clearInterval (this.timer);
        }
    }

    // Admission control: paused users, quiet hours and the daily budget are decided when an alert is queued.
    enqueue (alert: Alert): 'queued' | 'held' | 'dropped' {
        const user = this.store.getUser (alert.chatId);
        const now = this.now ();
        if (!user || user.status !== 'active') {
            this.stats.dropped += 1;
            return 'dropped';
        }
        if (user.pausedUntil > now) {
            this.store.insertDelivery ({ chatId: alert.chatId, ruleId: alert.ruleId, eventKey: alert.eventKey, status: 'paused' });
            this.stats.dropped += 1;
            return 'dropped';
        }
        if (alert.countsAgainstBudget) {
            const quiet = !alert.breakQuiet && inQuietHours (user.quietStart, user.quietEnd, user.tz, now);
            const budget = quiet ? { ok: false } : this.store.takeAlertBudget (alert.chatId, localParts (user.tz, now).date);
            if (!budget.ok) {
                this.store.addDigestItem (alert.chatId, alert.summary);
                this.store.insertDelivery ({ chatId: alert.chatId, ruleId: alert.ruleId, eventKey: alert.eventKey, status: 'held' });
                this.stats.held += 1;
                return 'held';
            }
        }
        const deliveryId = this.store.insertDelivery ({ chatId: alert.chatId, ruleId: alert.ruleId, eventKey: alert.eventKey, status: 'queued', context: alert.context });
        let q = this.queues.get (alert.chatId);
        if (!q) {
            q = [];
            this.queues.set (alert.chatId, q);
        }
        q.push ({ alert, deliveryId });
        return 'queued';
    }

    // Channels and other targets that are not users (no budget, no quiet hours).
    enqueueRaw (target: string | number, html: string, priority = 2, ttlMs = 30 * 60_000, markup?: unknown): void {
        const key = String (target);
        let q = this.raw.get (key);
        if (!q) {
            q = [];
            this.raw.set (key, q);
        }
        q.push ({ html, priority, expiresAt: this.now () + ttlMs, markup });
    }

    pending (): number {
        let n = 0;
        for (const q of this.queues.values ()) {
            n += q.length;
        }
        for (const q of this.raw.values ()) {
            n += q.length;
        }
        return n;
    }

    private refill (now: number): void {
        const elapsed = (now - this.lastRefill) / 1000;
        this.tokens = Math.min (this.perSecond, this.tokens + elapsed * this.perSecond);
        this.lastRefill = now;
    }

    private chatGapMs (chatId: number | string): number {
        return (typeof chatId === 'number' && chatId > 0) ? 1000 : 3000; // DMs 1/s, groups/channels 20/min
    }

    private groupAllows (key: string, now: number): boolean {
        const w = (this.groupWindow.get (key) || []).filter ((t) => now - t < 60_000);
        this.groupWindow.set (key, w);
        return w.length < 20;
    }

    // One pump: send as many messages as tokens allow, highest priority first.
    async pump (): Promise<void> {
        if (this.busy) {
            return;
        }
        this.busy = true;
        try {
            const now = this.now ();
            if (now < this.pausedUntil) {
                return;
            }
            this.refill (now);
            const candidates: Array<{ key: string, priority: number, createdAt: number, isRaw: boolean }> = [];
            for (const [ chatId, q ] of this.queues) {
                this.expire (q, now);
                if (q.length === 0) {
                    this.queues.delete (chatId);
                    continue;
                }
                const best = q.reduce ((a, b) => (b.alert.priority < a.alert.priority ? b : a));
                candidates.push ({ key: String (chatId), priority: best.alert.priority, createdAt: best.alert.createdAt, isRaw: false });
            }
            for (const [ key, q ] of this.raw) {
                const kept = q.filter ((r) => r.expiresAt > now);
                this.stats.expired += q.length - kept.length;
                if (kept.length === 0) {
                    this.raw.delete (key);
                    continue;
                }
                this.raw.set (key, kept);
                candidates.push ({ key, priority: Math.min (...kept.map ((r) => r.priority)), createdAt: 0, isRaw: true });
            }
            candidates.sort ((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
            for (const c of candidates) {
                if (this.tokens < 1) {
                    break;
                }
                const gap = this.chatGapMs (c.isRaw ? c.key : Number (c.key));
                if (now - (this.lastSent.get (c.key) || 0) < gap) {
                    continue;
                }
                const isGroupLike = c.isRaw || Number (c.key) < 0;
                if (isGroupLike && !this.groupAllows (c.key, now)) {
                    continue;
                }
                this.tokens -= 1;
                this.lastSent.set (c.key, now);
                if (isGroupLike) {
                    this.groupWindow.get (c.key)!.push (now);
                }
                if (c.isRaw) {
                    await this.sendRaw (c.key);
                } else {
                    await this.sendChat (Number (c.key));
                }
                if (this.now () < this.pausedUntil) {
                    break;
                }
            }
        } finally {
            this.busy = false;
        }
    }

    private expire (q: Queued[], now: number): void {
        for (let i = q.length - 1; i >= 0; i--) {
            const a = q[i].alert;
            if (now - a.createdAt > a.ttlMs) {
                this.store.markDelivery (q[i].deliveryId, 'expired');
                this.stats.expired += 1;
                q.splice (i, 1);
            }
        }
    }

    // Everything queued for one chat goes out as one message: the most important alert in full, the rest as a list.
    private async sendChat (chatId: number): Promise<void> {
        const q = this.queues.get (chatId);
        if (!q || q.length === 0) {
            return;
        }
        q.sort ((a, b) => a.alert.priority - b.alert.priority || a.alert.createdAt - b.alert.createdAt);
        const batch = q.splice (0, q.length);
        this.queues.delete (chatId);
        const first = batch[0];
        let html = first.alert.html;
        if (batch.length > 1) {
            const rest = batch.slice (1);
            html = '<b>' + batch.length + ' of your alerts fired</b>\n\n' + html + '\n\n<b>Also:</b>\n' + rest.map ((r) => '• ' + esc (r.alert.summary)).join ('\n');
        }
        const markup = first.alert.buttons === 'alert' ? this.keyboard (first.deliveryId, first.alert) : undefined;
        try {
            const res = await this.send (chatId, html, markup);
            this.store.markDelivery (first.deliveryId, 'sent', res.message_id);
            this.stats.sent += 1;
            for (const r of batch.slice (1)) {
                this.store.markDelivery (r.deliveryId, 'merged', res.message_id);
                this.stats.merged += 1;
            }
        } catch (e: any) {
            this.handleError (e, chatId, batch);
        }
    }

    private async sendRaw (key: string): Promise<void> {
        const q = this.raw.get (key);
        if (!q || q.length === 0) {
            return;
        }
        q.sort ((a, b) => a.priority - b.priority);
        const item = q.shift ()!;
        if (q.length === 0) {
            this.raw.delete (key);
        }
        const target: string | number = /^-?\d+$/.test (key) ? Number (key) : key;
        try {
            await this.send (target, item.html, item.markup);
            this.stats.sent += 1;
        } catch (e: any) {
            const retry = e?.parameters?.retry_after;
            if (e?.error_code === 429 && retry) {
                this.pausedUntil = this.now () + retry * 1000;
                q.unshift (item);
                this.raw.set (key, q);
                return;
            }
            this.stats.failed += 1;
            console.error ('[delivery] channel ' + key + ' failed: ' + (e?.description || e?.message || e));
        }
    }

    private handleError (e: any, chatId: number, batch: Queued[]): void {
        const code = e?.error_code;
        const retry = e?.parameters?.retry_after;
        if (code === 429 && retry) {
            // Honour Telegram's backoff for everyone, then retry this chat.
            this.pausedUntil = this.now () + retry * 1000;
            const q = this.queues.get (chatId) || [];
            this.queues.set (chatId, [ ...batch, ...q ]);
            return;
        }
        if (code === 403) {
            // The user blocked the bot (or removed it from the group): stop sending and pause their rules.
            this.store.updateUser (chatId, { status: 'blocked' });
        }
        for (const r of batch) {
            this.store.markDelivery (r.deliveryId, 'failed');
        }
        this.stats.failed += batch.length;
        if (code !== 403) {
            console.error ('[delivery] chat ' + chatId + ' failed: ' + (e?.description || e?.message || e));
        }
    }
}
