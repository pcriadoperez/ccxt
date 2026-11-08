// Periodic jobs: Daily Briefs at each user's local time, macro releases with BTC reaction,
// channel boards, and the daily retention purge.

import type { Store } from './db.js';
import type { MarketState } from './market/state.js';
import type { NewsDesk } from './news.js';
import type { MacroCalendar } from './calendar.js';
import type { Dispatcher } from './delivery.js';
import type { EventBus } from './events.js';
import type { Channels } from './channels.js';
import type { Config } from './config.js';
import { buildBrief } from './views.js';
import { localParts, parseHHMM } from './time.js';
import { fmtPct } from './format.js';

export interface SchedulerDeps {
    cfg: Config;
    store: Store;
    state: MarketState;
    news: NewsDesk;
    calendar: MacroCalendar;
    dispatcher: Dispatcher;
    bus: EventBus;
    channels?: Channels;
}

export class Scheduler {
    deps: SchedulerDeps;
    lastPurgeDate = '';
    lastChannelBriefDate = '';
    timer?: NodeJS.Timeout;

    constructor (deps: SchedulerDeps) {
        this.deps = deps;
    }

    start (everyMs = 30_000): void {
        this.timer = setInterval (() => this.run (), everyMs);
    }

    stop (): void {
        if (this.timer) {
            clearInterval (this.timer);
        }
    }

    run (now = Date.now ()): void {
        try {
            this.briefs (now);
            this.macro (now);
            this.deps.channels?.periodic (now);
            this.channelBrief (now);
            const today = new Date (now).toISOString ().slice (0, 10);
            if (today !== this.lastPurgeDate) {
                this.lastPurgeDate = today;
                this.deps.store.purge (now);
            }
        } catch (e) {
            console.error ('[scheduler] failed', e);
        }
    }

    // Send each user's brief once per local day, within 30 minutes after their chosen time.
    briefs (now: number): void {
        const { store, state, news, calendar, dispatcher } = this.deps;
        for (const user of store.activeUsers ()) {
            if (!user.briefTime || user.pausedUntil > now) {
                continue;
            }
            const due = parseHHMM (user.briefTime);
            if (due === undefined) {
                continue;
            }
            const lp = localParts (user.tz, now);
            if (lp.minutes < due || lp.minutes - due > 30 || user.settings.lastBriefDate === lp.date) {
                continue;
            }
            const held = store.takeDigestItems (user.chatId);
            const html = buildBrief ({ state, store, news, calendar }, user, now, held);
            store.updateUser (user.chatId, { settings: { ...user.settings, lastBriefDate: lp.date } });
            dispatcher.enqueue ({ chatId: user.chatId, priority: 3, ttlMs: 30 * 60_000, html, summary: 'Daily Brief', countsAgainstBudget: false, buttons: 'none', createdAt: now });
        }
    }

    channelBrief (now: number): void {
        const { cfg, store, state, news, calendar, dispatcher } = this.deps;
        if (!cfg.channels.brief) {
            return;
        }
        const lp = localParts ('UTC', now);
        if (lp.minutes < 7 * 60 || lp.minutes > 7 * 60 + 30 || this.lastChannelBriefDate === lp.date) {
            return;
        }
        this.lastChannelBriefDate = lp.date;
        dispatcher.enqueueRaw (cfg.channels.brief, buildBrief ({ state, store, news, calendar }, undefined, now), 3);
    }

    // 15 minutes after a CPI/FOMC release, post it with BTC's measured reaction.
    macro (now: number): void {
        const { calendar, state, bus } = this.deps;
        for (const e of calendar.upcoming (now - 2 * 3_600_000, now - 15 * 60_000)) {
            const ring = state.history.get ('median|BTC');
            let reaction: string | undefined;
            if (ring) {
                const before = ring.at (e.at - 60_000);
                const after = ring.latest ();
                if (before && after && after.t > e.at) {
                    reaction = fmtPct ((after.v - before.v) / before.v * 100, 2, true) + ' (median of major venues)';
                }
            }
            bus.emit ({ key: 'macro:' + e.id, type: 'macro', data: { title: e.title, at: e.at, source: e.source, reaction }, ts: now });
        }
    }
}
