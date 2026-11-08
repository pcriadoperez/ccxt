// Storage on Node's built-in SQLite (node:sqlite). One file, no external database needed for testing.
// Tables follow the spec's data model; Redis/Postgres can replace this module later behind the same interface.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Rule, RuleSpec } from './rules.js';

export function newId (prefix: string): string {
    return prefix + '_' + randomBytes (5).toString ('base64url');
}

export interface UserSettings {
    watchlist: string[];
    breaking: string[];
    postCap?: number; // groups: max posts per hour
    preset?: string; // groups
    lastBriefDate?: string;
    persona?: string;
    tzConfirmed?: boolean;
}

export interface UserRow {
    chatId: number;
    kind: 'dm' | 'group' | 'channel';
    tgUserId: number | null;
    lang: string | null;
    tz: string;
    briefTime: string | null; // 'HH:MM' local, null = off
    quietStart: number | null; // minutes since local midnight
    quietEnd: number | null;
    dailyBudget: number;
    pausedUntil: number;
    status: 'active' | 'blocked' | 'inactive';
    aiDate: string;
    aiUsed: number;
    alertsDate: string;
    alertsSent: number;
    onboarding: Record<string, unknown> | null;
    settings: UserSettings;
    createdAt: number;
}

export interface DeliveryContext {
    kind: string;
    venue?: string;
    symbol?: string;
    base?: string;
    code?: string;
    [key: string]: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    chat_id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'dm',
    tg_user_id INTEGER,
    lang TEXT,
    tz TEXT NOT NULL DEFAULT 'UTC',
    brief_time TEXT,
    quiet_start INTEGER,
    quiet_end INTEGER,
    daily_budget INTEGER NOT NULL DEFAULT 10,
    paused_until INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    ai_date TEXT NOT NULL DEFAULT '',
    ai_used INTEGER NOT NULL DEFAULT 0,
    alerts_date TEXT NOT NULL DEFAULT '',
    alerts_sent INTEGER NOT NULL DEFAULT 0,
    onboarding TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    spec TEXT NOT NULL,
    mode TEXT NOT NULL,
    cooldown_s INTEGER NOT NULL,
    expires_at INTEGER,
    paused INTEGER NOT NULL DEFAULT 0,
    break_quiet INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS rules_chat ON rules (chat_id);
CREATE TABLE IF NOT EXISTS rule_state (
    rule_id TEXT NOT NULL,
    key TEXT NOT NULL,
    armed INTEGER NOT NULL DEFAULT 1,
    last_value REAL,
    last_fired_at INTEGER,
    cooldown_until INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (rule_id, key)
);
CREATE TABLE IF NOT EXISTS events (
    natural_key TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    rule_id TEXT,
    event_key TEXT,
    status TEXT NOT NULL,
    queued_at INTEGER NOT NULL,
    sent_at INTEGER,
    tg_message_id INTEGER,
    context TEXT
);
CREATE INDEX IF NOT EXISTS deliveries_chat ON deliveries (chat_id, queued_at);
CREATE TABLE IF NOT EXISTS digest_items (
    chat_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    spec TEXT NOT NULL,
    mode TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    delivery_id TEXT,
    chat_id INTEGER,
    snapshot TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_turns (
    chat_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    intent TEXT,
    ok INTEGER NOT NULL,
    transcript TEXT
);
`;

function utcDate (ts: number): string {
    return new Date (ts).toISOString ().slice (0, 10);
}

export class Store {
    db: DatabaseSync;

    constructor (path: string) {
        if (path !== ':memory:') {
            mkdirSync (dirname (path), { recursive: true });
        }
        this.db = new DatabaseSync (path);
        this.db.exec ('PRAGMA journal_mode = WAL;');
        this.db.exec (SCHEMA);
    }

    close (): void {
        this.db.close ();
    }

    // ---------------------------------------------------------------- users

    private rowToUser (r: any): UserRow {
        return {
            chatId: Number (r.chat_id),
            kind: r.kind,
            tgUserId: r.tg_user_id === null ? null : Number (r.tg_user_id),
            lang: r.lang,
            tz: r.tz,
            briefTime: r.brief_time,
            quietStart: r.quiet_start,
            quietEnd: r.quiet_end,
            dailyBudget: r.daily_budget,
            pausedUntil: Number (r.paused_until),
            status: r.status,
            aiDate: r.ai_date,
            aiUsed: r.ai_used,
            alertsDate: r.alerts_date,
            alertsSent: r.alerts_sent,
            onboarding: r.onboarding ? JSON.parse (r.onboarding) : null,
            settings: { watchlist: [], breaking: [], ...JSON.parse (r.settings || '{}') },
            createdAt: Number (r.created_at),
        };
    }

    getUser (chatId: number): UserRow | undefined {
        const r = this.db.prepare ('SELECT * FROM users WHERE chat_id = ?').get (chatId);
        return r ? this.rowToUser (r) : undefined;
    }

    ensureUser (chatId: number, init: { kind: UserRow['kind'], tgUserId?: number | null, lang?: string | null, dailyBudget: number }): UserRow {
        const existing = this.getUser (chatId);
        if (existing) {
            if (existing.status !== 'active') {
                this.db.prepare ('UPDATE users SET status = ? WHERE chat_id = ?').run ('active', chatId);
                existing.status = 'active';
            }
            return existing;
        }
        this.db.prepare ('INSERT INTO users (chat_id, kind, tg_user_id, lang, daily_budget, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run (chatId, init.kind, init.tgUserId ?? null, init.lang ?? null, init.dailyBudget, Date.now ());
        return this.getUser (chatId)!;
    }

    updateUser (chatId: number, patch: Partial<Pick<UserRow, 'tz' | 'briefTime' | 'quietStart' | 'quietEnd' | 'dailyBudget' | 'pausedUntil' | 'status' | 'onboarding' | 'settings' | 'lang'>>): void {
        const cols: string[] = [];
        const vals: any[] = [];
        const map: Record<string, string> = { tz: 'tz', briefTime: 'brief_time', quietStart: 'quiet_start', quietEnd: 'quiet_end', dailyBudget: 'daily_budget', pausedUntil: 'paused_until', status: 'status', onboarding: 'onboarding', settings: 'settings', lang: 'lang' };
        for (const [ k, v ] of Object.entries (patch)) {
            const col = map[k];
            if (!col) {
                continue;
            }
            cols.push (col + ' = ?');
            vals.push ((k === 'onboarding' || k === 'settings') ? (v === null ? null : JSON.stringify (v)) : (v === undefined ? null : v));
        }
        if (cols.length === 0) {
            return;
        }
        vals.push (chatId);
        this.db.prepare ('UPDATE users SET ' + cols.join (', ') + ' WHERE chat_id = ?').run (...vals);
    }

    activeUsers (): UserRow[] {
        return (this.db.prepare ("SELECT * FROM users WHERE status = 'active'").all () as any[]).map ((r) => this.rowToUser (r));
    }

    // Counts an AI request against the user's daily quota. Returns false if the quota is exhausted.
    takeAiQuota (chatId: number, limit: number, now = Date.now ()): { ok: boolean, used: number, limit: number } {
        const user = this.getUser (chatId);
        if (!user) {
            return { ok: false, used: 0, limit };
        }
        const today = utcDate (now);
        const used = user.aiDate === today ? user.aiUsed : 0;
        if (used >= limit) {
            return { ok: false, used, limit };
        }
        this.db.prepare ('UPDATE users SET ai_date = ?, ai_used = ? WHERE chat_id = ?').run (today, used + 1, chatId);
        return { ok: true, used: used + 1, limit };
    }

    aiUsedToday (chatId: number, now = Date.now ()): number {
        const user = this.getUser (chatId);
        return (user && user.aiDate === utcDate (now)) ? user.aiUsed : 0;
    }

    // Counts a push alert against the daily budget, using the user's local date.
    takeAlertBudget (chatId: number, localDate: string): { ok: boolean, sent: number, budget: number } {
        const user = this.getUser (chatId);
        if (!user) {
            return { ok: false, sent: 0, budget: 0 };
        }
        const sent = user.alertsDate === localDate ? user.alertsSent : 0;
        if (sent >= user.dailyBudget) {
            return { ok: false, sent, budget: user.dailyBudget };
        }
        this.db.prepare ('UPDATE users SET alerts_date = ?, alerts_sent = ? WHERE chat_id = ?').run (localDate, sent + 1, chatId);
        return { ok: true, sent: sent + 1, budget: user.dailyBudget };
    }

    forgetUser (chatId: number): void {
        const ids = (this.db.prepare ('SELECT id FROM rules WHERE chat_id = ?').all (chatId) as any[]).map ((r) => r.id);
        for (const id of ids) {
            this.db.prepare ('DELETE FROM rule_state WHERE rule_id = ?').run (id);
        }
        this.db.prepare ('DELETE FROM rules WHERE chat_id = ?').run (chatId);
        this.db.prepare ('DELETE FROM proposals WHERE chat_id = ?').run (chatId);
        this.db.prepare ('DELETE FROM digest_items WHERE chat_id = ?').run (chatId);
        this.db.prepare ('DELETE FROM ai_turns WHERE chat_id = ?').run (chatId);
        this.db.prepare ('UPDATE deliveries SET chat_id = 0, context = NULL WHERE chat_id = ?').run (chatId);
        this.db.prepare ('DELETE FROM users WHERE chat_id = ?').run (chatId);
    }

    // ---------------------------------------------------------------- rules

    private rowToRule (r: any): Rule {
        return {
            id: r.id,
            chatId: Number (r.chat_id),
            spec: JSON.parse (r.spec) as RuleSpec,
            mode: r.mode,
            cooldownS: r.cooldown_s,
            expiresAt: r.expires_at === null ? null : Number (r.expires_at),
            paused: !!r.paused,
            breakQuiet: !!r.break_quiet,
            source: r.source,
            createdAt: Number (r.created_at),
        };
    }

    insertRule (rule: Omit<Rule, 'id' | 'createdAt'> & { id?: string }): Rule {
        const id = rule.id || newId ('r');
        const createdAt = Date.now ();
        this.db.prepare ('INSERT INTO rules (id, chat_id, kind, spec, mode, cooldown_s, expires_at, paused, break_quiet, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run (id, rule.chatId, rule.spec.kind, JSON.stringify (rule.spec), rule.mode, rule.cooldownS, rule.expiresAt, rule.paused ? 1 : 0, rule.breakQuiet ? 1 : 0, rule.source, createdAt);
        return { ...rule, id, createdAt };
    }

    getRule (id: string): Rule | undefined {
        const r = this.db.prepare ('SELECT * FROM rules WHERE id = ? AND deleted_at IS NULL').get (id);
        return r ? this.rowToRule (r) : undefined;
    }

    rulesForChat (chatId: number): Rule[] {
        return (this.db.prepare ('SELECT * FROM rules WHERE chat_id = ? AND deleted_at IS NULL ORDER BY created_at').all (chatId) as any[]).map ((r) => this.rowToRule (r));
    }

    countRules (chatId: number): number {
        const r = this.db.prepare ('SELECT COUNT(*) AS n FROM rules WHERE chat_id = ? AND deleted_at IS NULL').get (chatId) as any;
        return Number (r.n);
    }

    activeRules (): Rule[] {
        const sql = "SELECT r.* FROM rules r JOIN users u ON u.chat_id = r.chat_id WHERE r.deleted_at IS NULL AND r.paused = 0 AND u.status = 'active'";
        return (this.db.prepare (sql).all () as any[]).map ((r) => this.rowToRule (r));
    }

    setRulePaused (id: string, paused: boolean): void {
        this.db.prepare ('UPDATE rules SET paused = ? WHERE id = ?').run (paused ? 1 : 0, id);
    }

    deleteRule (id: string): void {
        this.db.prepare ('UPDATE rules SET deleted_at = ? WHERE id = ?').run (Date.now (), id);
        this.db.prepare ('DELETE FROM rule_state WHERE rule_id = ?').run (id);
    }

    updateRuleSpec (id: string, spec: RuleSpec): void {
        this.db.prepare ('UPDATE rules SET spec = ?, kind = ? WHERE id = ?').run (JSON.stringify (spec), spec.kind, id);
        this.db.prepare ('DELETE FROM rule_state WHERE rule_id = ?').run (id);
    }

    // ---------------------------------------------------------------- rule state

    getRuleState (ruleId: string, key: string): { armed: boolean, lastValue: number | null, lastFiredAt: number | null, cooldownUntil: number } | undefined {
        const r = this.db.prepare ('SELECT * FROM rule_state WHERE rule_id = ? AND key = ?').get (ruleId, key) as any;
        if (!r) {
            return undefined;
        }
        return { armed: !!r.armed, lastValue: r.last_value, lastFiredAt: r.last_fired_at === null ? null : Number (r.last_fired_at), cooldownUntil: Number (r.cooldown_until) };
    }

    setRuleState (ruleId: string, key: string, s: { armed: boolean, lastValue: number | null, lastFiredAt: number | null, cooldownUntil: number }): void {
        this.db.prepare ('INSERT INTO rule_state (rule_id, key, armed, last_value, last_fired_at, cooldown_until) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (rule_id, key) DO UPDATE SET armed = excluded.armed, last_value = excluded.last_value, last_fired_at = excluded.last_fired_at, cooldown_until = excluded.cooldown_until')
            .run (ruleId, key, s.armed ? 1 : 0, s.lastValue, s.lastFiredAt, s.cooldownUntil);
    }

    // ---------------------------------------------------------------- proposals (awaiting Save)

    saveProposal (chatId: number, spec: RuleSpec, mode: 'once' | 'repeat', source: Rule['source']): string {
        const id = newId ('p');
        this.db.prepare ('INSERT INTO proposals (id, chat_id, spec, mode, source, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run (id, chatId, JSON.stringify (spec), mode, source, Date.now ());
        return id;
    }

    getProposal (id: string): { id: string, chatId: number, spec: RuleSpec, mode: 'once' | 'repeat', source: Rule['source'] } | undefined {
        const r = this.db.prepare ('SELECT * FROM proposals WHERE id = ?').get (id) as any;
        if (!r) {
            return undefined;
        }
        return { id: r.id, chatId: Number (r.chat_id), spec: JSON.parse (r.spec), mode: r.mode, source: r.source };
    }

    updateProposal (id: string, spec: RuleSpec, mode: 'once' | 'repeat'): void {
        this.db.prepare ('UPDATE proposals SET spec = ?, mode = ? WHERE id = ?').run (JSON.stringify (spec), mode, id);
    }

    deleteProposal (id: string): void {
        this.db.prepare ('DELETE FROM proposals WHERE id = ?').run (id);
    }

    // ---------------------------------------------------------------- events, deliveries, digest, kv

    // Returns true if this global event is new (natural-key dedupe).
    recordEvent (key: string, type: string, payload: unknown): boolean {
        const r = this.db.prepare ('INSERT OR IGNORE INTO events (natural_key, type, payload, created_at) VALUES (?, ?, ?, ?)')
            .run (key, type, JSON.stringify (payload), Date.now ());
        return Number (r.changes) > 0;
    }

    recentEvents (type: string, sinceMs: number): Array<{ key: string, payload: any, createdAt: number }> {
        return (this.db.prepare ('SELECT * FROM events WHERE type = ? AND created_at >= ? ORDER BY created_at DESC').all (type, Date.now () - sinceMs) as any[])
            .map ((r) => ({ key: r.natural_key, payload: JSON.parse (r.payload), createdAt: Number (r.created_at) }));
    }

    insertDelivery (d: { chatId: number, ruleId?: string, eventKey?: string, status: string, context?: DeliveryContext }): string {
        const id = newId ('d');
        this.db.prepare ('INSERT INTO deliveries (id, chat_id, rule_id, event_key, status, queued_at, context) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run (id, d.chatId, d.ruleId ?? null, d.eventKey ?? null, d.status, Date.now (), d.context ? JSON.stringify (d.context) : null);
        return id;
    }

    markDelivery (id: string, status: string, tgMessageId?: number): void {
        this.db.prepare ('UPDATE deliveries SET status = ?, sent_at = ?, tg_message_id = ? WHERE id = ?')
            .run (status, status === 'sent' ? Date.now () : null, tgMessageId ?? null, id);
    }

    getDelivery (id: string): { id: string, chatId: number, ruleId: string | null, status: string, context: DeliveryContext | null, queuedAt: number, sentAt: number | null } | undefined {
        const r = this.db.prepare ('SELECT * FROM deliveries WHERE id = ?').get (id) as any;
        if (!r) {
            return undefined;
        }
        return { id: r.id, chatId: Number (r.chat_id), ruleId: r.rule_id, status: r.status, context: r.context ? JSON.parse (r.context) : null, queuedAt: Number (r.queued_at), sentAt: r.sent_at === null ? null : Number (r.sent_at) };
    }

    lastDeliveryWithContext (chatId: number): { id: string, context: DeliveryContext } | undefined {
        const r = this.db.prepare ("SELECT id, context FROM deliveries WHERE chat_id = ? AND context IS NOT NULL AND status = 'sent' ORDER BY queued_at DESC LIMIT 1").get (chatId) as any;
        return r ? { id: r.id, context: JSON.parse (r.context) } : undefined;
    }

    addDigestItem (chatId: number, text: string): void {
        this.db.prepare ('INSERT INTO digest_items (chat_id, text, created_at) VALUES (?, ?, ?)').run (chatId, text, Date.now ());
    }

    takeDigestItems (chatId: number): string[] {
        const rows = this.db.prepare ('SELECT text FROM digest_items WHERE chat_id = ? ORDER BY created_at').all (chatId) as any[];
        this.db.prepare ('DELETE FROM digest_items WHERE chat_id = ?').run (chatId);
        return rows.map ((r) => r.text);
    }

    addReport (deliveryId: string, chatId: number, reason: string): void {
        const d = this.getDelivery (deliveryId);
        this.db.prepare ('INSERT INTO reports (id, delivery_id, chat_id, snapshot, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run (newId ('rp'), deliveryId, chatId, d ? JSON.stringify (d) : null, reason, Date.now ());
    }

    logAiTurn (chatId: number, intent: string, ok: boolean, transcript: string): void {
        this.db.prepare ('INSERT INTO ai_turns (chat_id, created_at, intent, ok, transcript) VALUES (?, ?, ?, ?, ?)').run (chatId, Date.now (), intent, ok ? 1 : 0, transcript.slice (0, 8000));
    }

    kvGet<T> (key: string): T | undefined {
        const r = this.db.prepare ('SELECT value FROM kv WHERE key = ?').get (key) as any;
        return r ? JSON.parse (r.value) as T : undefined;
    }

    kvSet (key: string, value: unknown): void {
        this.db.prepare ('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run (key, JSON.stringify (value));
    }

    // Retention policy from the spec: deliveries 30 days, AI transcripts 7 days, events 12 months, proposals 1 day.
    purge (now = Date.now ()): void {
        const day = 86_400_000;
        this.db.prepare ('DELETE FROM deliveries WHERE queued_at < ?').run (now - 30 * day);
        this.db.prepare ('UPDATE ai_turns SET transcript = NULL WHERE created_at < ?').run (now - 7 * day);
        this.db.prepare ('DELETE FROM ai_turns WHERE created_at < ?').run (now - 90 * day);
        this.db.prepare ('DELETE FROM events WHERE created_at < ?').run (now - 365 * day);
        this.db.prepare ('DELETE FROM proposals WHERE created_at < ?').run (now - day);
        this.db.prepare ('DELETE FROM digest_items WHERE created_at < ?').run (now - 2 * day);
    }
}
