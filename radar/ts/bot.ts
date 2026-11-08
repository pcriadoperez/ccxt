// Telegram bot (grammY): onboarding, commands, confirmation cards, alert buttons, AI chat, groups.

import { Bot, InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Config } from './config.js';
import { CORE_VENUES, MAJORS } from './config.js';
import type { Store, UserRow, DeliveryContext } from './db.js';
import type { MarketState } from './market/state.js';
import { to8h, toApr } from './market/state.js';
import type { Engine } from './engine.js';
import type { Assistant } from './ai/assistant.js';
import type { NewsDesk } from './news.js';
import type { MacroCalendar } from './calendar.js';
import type { Alert } from './alerts.js';
import type { ExchangeGetter } from './backtest.js';
import { backtest } from './backtest.js';
import { KIND_DEFAULTS, describeSpec, parseSpec } from './rules.js';
import type { Rule, RuleSpec, BreakingType } from './rules.js';
import { parseShorthand, venueAlias } from './parse.js';
import { snippet, INSTALL, ruleScript } from './snippets.js';
import type { Lang } from './snippets.js';
import { buildBrief, fundingView, listingsView, priceView, statusView, walletView } from './views.js';
import { DISCLAIMER, esc, fmtDuration, fmtFundingRate, fmtPct, fmtPrice, venueName } from './format.js';
import { isValidZone, localParts, minutesToHHMM, parseHHMM, zoneForOffset } from './time.js';

export interface BotDeps {
    cfg: Config;
    store: Store;
    state: MarketState;
    engine: Engine;
    assistant: Assistant;
    news: NewsDesk;
    calendar: MacroCalendar;
    getExchange: ExchangeGetter;
}

const ANON_ADMIN_ID = 1087968824; // GroupAnonymousBot
const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

const PERSONAS: Array<[string, string]> = [
    [ 'moves', 'Big moves on my coins' ],
    [ 'listings', 'New listings' ],
    [ 'funding', 'Funding extremes' ],
    [ 'brief', 'Daily Brief only' ],
    [ 'own', 'Let me type what I want' ],
];

const LOUDNESS: Record<string, { label: string, pct: number, windowMin: number }> = {
    calm: { label: 'Calm ±7%/24h', pct: 7, windowMin: 1440 },
    normal: { label: 'Normal ±5%/4h', pct: 5, windowMin: 240 },
    twitchy: { label: 'Twitchy ±3%/1h', pct: 3, windowMin: 60 },
};

const BREAKING_LABELS: Record<BreakingType, string> = {
    listing: 'Major listings',
    status: 'Outages & stablecoin withdrawal halts',
    macro: 'CPI / FOMC releases',
    exploit: 'Verified exploits',
    bigmove: 'BTC/ETH ±4% in 15 min',
};

const HELP = [
    '<b>CCXT Radar</b> · free market alerts from the major exchanges, built on the open-source CCXT library.',
    '',
    '<b>Create alerts</b> (or just type them, or describe them in words)',
    '<code>/alert btc &gt; 100k</code> · price level (fires once)',
    '<code>/alert sol 5% 4h</code> · % move in a window',
    '<code>/alert eth -10% from 3400</code> · % from your reference',
    '<code>/alert funding eth &gt; 0.1%</code> · funding (8h-equivalent)',
    '<code>/alert funding any</code> · extremes on any top perp',
    '<code>/alert gap btc 20%</code> · funding gap between venues (APR)',
    '<code>/alert settle btc</code> · reminder before funding settles',
    '<code>/alert oi btc 8% 1h</code> · open interest change',
    '<code>/alert listings binance upbit</code> · new markets',
    '<code>/alert wallet usdt</code> · deposit/withdrawal pauses',
    '<code>/alert status</code> · exchange outages',
    '<code>/alert depeg</code> · stablecoins off the dollar',
    'Add a venue (<code>bybit</code>), <code>perp</code>, <code>mark</code>, <code>once</code> or <code>repeat</code> to any of them.',
    '',
    '<b>Look things up</b>: /p btc · /funding eth · /status · /listings · /wallet usdt',
    '<b>Manage</b>: /list · /pause · /resume · /brief 08:00 · /quiet 23-07 · /budget 15 · /tz · /watch · /breaking · /code',
    '<b>Ask</b>: type a question, or /ask in groups (AI, limited per day)',
    '<b>Privacy</b>: /about · /forget',
].join ('\n');

function shortAge (ts: number): string {
    return fmtDuration (Date.now () - ts);
}

export function alertKeyboard (deliveryId: string, alert: Alert): InlineKeyboard {
    const kb = new InlineKeyboard ()
        .text ('Reproduce with CCXT', 'al:rp:' + deliveryId + ':py')
        .text ('Why might this be?', 'al:why:' + deliveryId)
        .row ();
    if (alert.ruleId) {
        kb.text ('Mute 4h', 'al:mu:' + alert.ruleId + ':4').text ('My alerts', 'l:pg:0');
    }
    kb.text ('Looks wrong', 'al:bad:' + deliveryId);
    return kb;
}

export function createBot (token: string, deps: BotDeps, botInfo?: UserFromGetMe): Bot {
    const { cfg, store, state, engine, assistant, news, calendar } = deps;
    const bot = new Bot (token, botInfo ? { botInfo } : undefined);
    const memberCooldown = new Map<string, number> ();

    const ensure = (ctx: Context): UserRow => {
        const chat = ctx.chat!;
        const isDm = chat.type === 'private';
        return store.ensureUser (chat.id, {
            kind: isDm ? 'dm' : 'group',
            tgUserId: ctx.from?.id ?? null,
            lang: ctx.from?.language_code ?? null,
            dailyBudget: isDm ? cfg.limits.defaultDailyBudget : 48,
        });
    };

    const reply = async (ctx: Context, html: string, markup?: InlineKeyboard) => {
        return ctx.reply (html, { ...HTML, reply_markup: markup });
    };

    const edit = async (ctx: Context, html: string, markup?: InlineKeyboard) => {
        try {
            await ctx.editMessageText (html, { ...HTML, reply_markup: markup });
        } catch (e: any) {
            if (!String (e?.description || e?.message).includes ('not modified')) {
                await reply (ctx, html, markup);
            }
        }
    };

    const isGroup = (ctx: Context) => ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

    // Groups: one command per member per 30s (the 20 msg/min group limit is shared by everyone).
    const groupThrottle = (ctx: Context): boolean => {
        if (!isGroup (ctx) || !ctx.from) {
            return false;
        }
        const key = ctx.chat!.id + '|' + ctx.from.id;
        const last = memberCooldown.get (key) || 0;
        if (Date.now () - last < cfg.limits.groupMemberCooldownMs) {
            return true;
        }
        memberCooldown.set (key, Date.now ());
        return false;
    };

    // ------------------------------------------------------------ proposals (confirmation cards)

    const currentLine = (spec: RuleSpec): string | undefined => {
        if (spec.kind === 'price') {
            if (spec.venue === 'median') {
                const m = state.medianPrice (spec.base);
                return m ? 'Now: <code>' + esc (fmtPrice (m.price)) + '</code> USD (median of ' + m.venues.length + ' venues)' : undefined;
            }
            const r = state.resolve (spec.venue, spec.base, spec.market, spec.quote);
            const p = r ? state.price (spec.venue, r.symbol, spec.field) : undefined;
            return p && r ? 'Now: <code>' + esc (fmtPrice (p.value / r.multiplier)) + '</code> on ' + esc (venueName (spec.venue)) + ' (' + esc (r.symbol) + ')' : undefined;
        }
        if (spec.kind === 'move') {
            const key = spec.venue === 'median' ? 'median|' + spec.base : spec.venue + '|' + (state.resolve (spec.venue, spec.base, spec.market)?.symbol || '');
            const ch = state.change (key, spec.windowMin * 60_000);
            if (ch) {
                return 'Now: ' + fmtPct (ch.pct, 2, true) + ' over the last ' + (spec.windowMin % 60 ? spec.windowMin + 'm' : spec.windowMin / 60 + 'h');
            }
            const m = state.medianPrice (spec.base);
            return m ? 'Now: <code>' + esc (fmtPrice (m.price)) + '</code> USD. Move history builds up while the bot runs.' : undefined;
        }
        if (spec.kind === 'funding' && spec.base !== '*') {
            const rows = state.fundingAcross (spec.base).filter ((r) => spec.venues.length === 0 || spec.venues.indexOf (r.venue) !== -1);
            if (rows.length) {
                return 'Now (8h-eq): ' + rows.slice (0, 4).map ((r) => esc (venueName (r.venue)) + ' ' + fmtFundingRate (to8h (r.f))).join (' · ');
            }
        }
        if (spec.kind === 'fundinggap') {
            const rows = state.fundingAcross (spec.base);
            if (rows.length >= 2) {
                const aprs = rows.map ((r) => toApr (r.f));
                return 'Now: gap ' + fmtPct ((Math.max (...aprs) - Math.min (...aprs)) * 100, 1) + ' APR across ' + rows.length + ' venues';
            }
        }
        return undefined;
    };

    const proposalText = (spec: RuleSpec, mode: 'once' | 'repeat', assumptions: string[], extra?: string): string => {
        const d = KIND_DEFAULTS[spec.kind];
        const modeText = mode === 'once' ? 'Fires once, then removes itself' : 'Repeats' + (d.cooldownS ? ' · ' + fmtDuration (d.cooldownS * 1000) + ' cooldown' : '');
        const lines = [ '<b>Here\'s the alert I understood:</b>', esc (describeSpec (spec)), '<i>' + modeText + '</i>' ];
        const now = currentLine (spec);
        if (now) {
            lines.push (now);
        }
        for (const a of assumptions) {
            lines.push ('<i>Assumed: ' + esc (a) + '</i>');
        }
        if (extra) {
            lines.push (extra);
        }
        return lines.join ('\n');
    };

    const proposalKeyboard = (pid: string, mode: 'once' | 'repeat') => new InlineKeyboard ()
        .text ('Save', 'pr:save:' + pid)
        .text (mode === 'once' ? 'Make it repeat' : 'Make it once', 'pr:mode:' + pid)
        .text ('Cancel', 'pr:x:' + pid);

    const sendProposal = async (ctx: Context, spec: RuleSpec, mode: 'once' | 'repeat', source: Rule['source'], assumptions: string[] = [], footerNote?: string) => {
        const chatId = ctx.chat!.id;
        if (store.countRules (chatId) >= cfg.limits.maxRulesPerUser) {
            await reply (ctx, 'You have ' + cfg.limits.maxRulesPerUser + ' alerts, the maximum. Remove some with /list first.');
            return;
        }
        const pid = store.saveProposal (chatId, spec, mode, source);
        const base = proposalText (spec, mode, assumptions, footerNote);
        const msg = await reply (ctx, base + '\n<i>Checking the last 30 days…</i>', proposalKeyboard (pid, mode));
        const bt = await backtest (spec, state, deps.getExchange);
        const btLine = bt ? '<i>Backtest: would have fired ' + bt.count + '× in the last ' + bt.days + ' days (' + esc (venueName (bt.venue)) + ' data)</i>' : undefined;
        try {
            await ctx.api.editMessageText (chatId, msg.message_id, base + (btLine ? '\n' + btLine : ''), { ...HTML, reply_markup: proposalKeyboard (pid, mode) });
        } catch {
            // the user may already have tapped a button
        }
    };

    // ------------------------------------------------------------ onboarding

    const personaKeyboard = () => {
        const kb = new InlineKeyboard ();
        PERSONAS.forEach (([ id, label ], i) => {
            kb.text (label, 'ob:p:' + id);
            if (i % 2 === 1) {
                kb.row ();
            }
        });
        return kb;
    };

    const coinsKeyboard = (selected: string[]) => {
        const kb = new InlineKeyboard ();
        const coins = [ ...new Set ([ ...MAJORS, ...selected ]) ];
        coins.forEach ((c, i) => {
            kb.text ((selected.indexOf (c) !== -1 ? '✓ ' : '') + c, 'ob:c:' + c);
            if (i % 4 === 3) {
                kb.row ();
            }
        });
        return kb.row ().text ('+ Other coin', 'ob:c:+').text ('Done', 'ob:c:done');
    };

    const loudKeyboard = () => {
        const kb = new InlineKeyboard ();
        for (const [ id, l ] of Object.entries (LOUDNESS)) {
            kb.text (l.label, 'ob:l:' + id);
        }
        return kb;
    };

    const tzKeyboard = () => {
        const kb = new InlineKeyboard ();
        const now = Date.now ();
        const offsets = [ -8, -7, -6, -5, -4, -3, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 ];
        offsets.forEach ((h, i) => {
            const t = new Date (now + h * 3_600_000);
            const label = String (t.getUTCHours ()).padStart (2, '0') + ':' + String (t.getUTCMinutes ()).padStart (2, '0');
            kb.text (label, 'ob:t:' + h * 60);
            if (i % 6 === 5) {
                kb.row ();
            }
        });
        return kb.row ().text ('India 5:30', 'ob:t:330').text ('UTC', 'ob:t:0');
    };

    const briefKeyboard = () => new InlineKeyboard ().text ('07:00', 'ob:b:07:00').text ('08:00', 'ob:b:08:00').text ('09:00', 'ob:b:09:00').text ('No brief', 'ob:b:off');

    const startOnboarding = async (ctx: Context, pending?: string) => {
        const user = ensure (ctx);
        store.updateUser (user.chatId, { onboarding: { step: 'persona', coins: [], pending: pending || null } });
        await reply (ctx, [
            '<b>Free market alerts from the major exchanges, built on the open-source CCXT library.</b>',
            'I never ask for API keys, seed phrases or money. My only handle is @' + esc (cfg.botUsername) + '.',
            '',
            'What do you want to follow?',
        ].join ('\n'), personaKeyboard ());
    };

    const finishOnboarding = async (ctx: Context) => {
        const chatId = ctx.chat!.id;
        const user = store.getUser (chatId)!;
        const ob: any = user.onboarding || {};
        const created: string[] = [];
        const add = (spec: unknown) => {
            const r = parseSpec (spec);
            if (r.ok) {
                const d = KIND_DEFAULTS[r.spec.kind];
                store.insertRule ({ chatId, spec: r.spec, mode: d.mode, cooldownS: d.cooldownS, expiresAt: null, paused: false, breakQuiet: false, source: 'preset' });
                created.push (describeSpec (r.spec));
            }
        };
        const coins: string[] = ob.coins && ob.coins.length ? ob.coins : [ 'BTC', 'ETH' ];
        if (ob.persona === 'moves') {
            const l = LOUDNESS[ob.loud || 'normal'];
            for (const c of coins) {
                add ({ kind: 'move', base: c, venue: 'median', pct: l.pct, windowMin: l.windowMin, direction: 'both' });
            }
        } else if (ob.persona === 'listings') {
            add ({ kind: 'listing', venues: [ 'binance', 'coinbase', 'okx', 'bybit', 'upbit', 'kraken' ], markets: [ 'spot', 'perp' ], removals: true });
        } else if (ob.persona === 'funding') {
            add ({ kind: 'funding', base: '*', venues: [], high: 0.001, low: -0.0005 });
        }
        engine.markDirty ();
        const settings = { ...user.settings, watchlist: ob.persona === 'moves' ? coins : (user.settings.watchlist.length ? user.settings.watchlist : [ 'BTC', 'ETH', 'SOL' ]), persona: ob.persona, tzConfirmed: true };
        store.updateUser (chatId, { onboarding: null, settings, quietStart: 23 * 60, quietEnd: 7 * 60 });
        const fresh = store.getUser (chatId)!;
        const lines = [ '<b>Done.</b>' ];
        if (created.length) {
            lines.push (...created.map ((c) => '• ' + esc (c)));
        }
        lines.push ('Daily Brief: ' + (fresh.briefTime ? fresh.briefTime + ' (' + esc (fresh.tz) + ')' : 'off') + ' · quiet 23:00–07:00 · max ' + fresh.dailyBudget + ' alerts a day');
        const first = coins[0];
        const m = state.medianPrice (first);
        if (m) {
            const ch = state.change ('median|' + first, 4 * 3_600_000);
            lines.push ('Right now: ' + esc (first) + ' <code>' + esc (fmtPrice (m.price)) + '</code> USD' + (ch ? ' · ' + fmtPct (ch.pct, 1, true) + ' in 4h' : '') + ' (median, ' + m.venues.length + ' venues)');
        }
        lines.push ('', 'Type an alert in your own words any time, e.g. <i>"ping me if ETH funding on Bybit goes crazy"</i>.', '/list to change · /pause to stop everything · /breaking for breaking events · /help');
        await reply (ctx, lines.join ('\n'));
        if (ob.pending) {
            await handleDeepLink (ctx, String (ob.pending));
        }
    };

    const onboardingCallback = async (ctx: Context, parts: string[]) => {
        const chatId = ctx.chat!.id;
        const user = ensure (ctx);
        const ob: any = user.onboarding || { step: 'persona', coins: [] };
        const [ , what, value, value2 ] = parts;
        if (what === 'p') {
            ob.persona = value;
            if (value === 'moves') {
                ob.step = 'coins';
                store.updateUser (chatId, { onboarding: ob });
                await edit (ctx, 'Pick coins (tap to toggle):', coinsKeyboard (ob.coins || []));
                return;
            }
            ob.step = 'tz';
            store.updateUser (chatId, { onboarding: ob });
            await edit (ctx, 'What time is it for you now? (for quiet hours and your brief)', tzKeyboard ());
            return;
        }
        if (what === 'c') {
            if (value === 'done') {
                if (!ob.coins || ob.coins.length === 0) {
                    ob.coins = [ 'BTC', 'ETH' ];
                }
                ob.step = 'loud';
                store.updateUser (chatId, { onboarding: ob });
                await edit (ctx, 'How loud? Big moves are checked against the median price across major venues.', loudKeyboard ());
                return;
            }
            if (value === '+') {
                ob.step = 'customcoin';
                store.updateUser (chatId, { onboarding: ob });
                await reply (ctx, 'Type the coin symbol (for example <code>PEPE</code>):');
                return;
            }
            const coins: string[] = ob.coins || [];
            const i = coins.indexOf (value);
            if (i === -1) {
                coins.push (value);
            } else {
                coins.splice (i, 1);
            }
            ob.coins = coins;
            store.updateUser (chatId, { onboarding: ob });
            await edit (ctx, 'Pick coins (tap to toggle):', coinsKeyboard (coins));
            return;
        }
        if (what === 'l') {
            ob.loud = value;
            ob.step = 'tz';
            store.updateUser (chatId, { onboarding: ob });
            await edit (ctx, 'What time is it for you now? (for quiet hours and your brief)', tzKeyboard ());
            return;
        }
        if (what === 't') {
            const tz = zoneForOffset (Number (value), Date.now ());
            store.updateUser (chatId, { tz, onboarding: { ...ob, step: 'brief' } });
            await edit (ctx, 'Timezone set to <b>' + esc (tz) + '</b> (change with /tz).\nWhen should your Daily Brief arrive?', briefKeyboard ());
            return;
        }
        if (what === 'b') {
            const time = value === 'off' ? null : value + ':' + (value2 || '00');
            store.updateUser (chatId, { briefTime: time, onboarding: { ...ob, step: 'done' } });
            await edit (ctx, 'Daily Brief: ' + (time ? time : 'off') + '.');
            await finishOnboarding (ctx);
        }
    };

    // Deep links: t.me/<bot>?start=funding_btc | move_sol | listings | brief | depeg | status
    const handleDeepLink = async (ctx: Context, payload: string) => {
        const [ kind, arg ] = payload.toLowerCase ().split ('_');
        const coin = (arg || 'btc').toUpperCase ();
        const specs: Record<string, unknown> = {
            funding: { kind: 'funding', base: coin, venues: [], high: 0.001, low: -0.0005 },
            move: { kind: 'move', base: coin, venue: 'median', pct: 5, windowMin: 240, direction: 'both' },
            listings: { kind: 'listing', venues: [], markets: [ 'spot', 'perp' ], removals: true },
            depeg: { kind: 'depeg', codes: [ 'USDT', 'USDC' ] },
            status: { kind: 'status', venues: [] },
            wallet: { kind: 'wallet', code: coin, venues: [] },
        };
        if (kind === 'brief') {
            store.updateUser (ctx.chat!.id, { briefTime: '08:00' });
            await reply (ctx, 'Daily Brief on at 08:00 your time. Change with <code>/brief 07:30</code>.');
            return;
        }
        const s = specs[kind];
        if (!s) {
            return;
        }
        const r = parseSpec (s);
        if (r.ok) {
            await sendProposal (ctx, r.spec, KIND_DEFAULTS[r.spec.kind].mode, 'button');
        }
    };

    // ------------------------------------------------------------ AI

    const aiLimit = (chatId: number) => (store.countRules (chatId) > 0 ? cfg.ai.dailyPerUser : cfg.ai.newUserAllowance);

    const runAssistant = async (ctx: Context, text: string) => {
        const chatId = ctx.chat!.id;
        if (!assistant.enabled) {
            await reply (ctx, 'I didn\'t recognise that. Examples: <code>btc &gt; 100k</code>, <code>sol 5% 4h</code>, <code>funding eth &gt; 0.1%</code>. See /help.');
            return;
        }
        const limit = aiLimit (chatId);
        const q = store.takeAiQuota (chatId, limit);
        if (!q.ok) {
            const extra = store.countRules (chatId) === 0 ? ' Save your first alert to unlock ' + cfg.ai.dailyPerUser + ' a day.' : '';
            await reply (ctx, 'You\'ve used today\'s AI messages (' + q.used + '/' + q.limit + ').' + extra + ' Commands and buttons keep working: /help.');
            return;
        }
        await ctx.replyWithChatAction ('typing').catch (() => undefined);
        const res = await assistant.handle (chatId, text);
        const quota = '<i>AI ' + q.used + '/' + q.limit + ' today</i>';
        if (res.kind === 'proposal') {
            await sendProposal (ctx, res.spec, res.mode, 'ai', res.assumptions, quota);
            return;
        }
        await reply (ctx, res.html + '\n' + quota);
    };

    // ------------------------------------------------------------ list

    const listPage = (chatId: number, page: number): { html: string, kb: InlineKeyboard } => {
        const rules = store.rulesForChat (chatId);
        const per = 6;
        const pages = Math.max (1, Math.ceil (rules.length / per));
        const p = Math.min (Math.max (0, page), pages - 1);
        const slice = rules.slice (p * per, p * per + per);
        const kb = new InlineKeyboard ();
        const lines = [ '<b>Your alerts</b> (' + rules.length + '/' + cfg.limits.maxRulesPerUser + ')' ];
        if (rules.length === 0) {
            lines.push ('None yet. Type one, e.g. <code>btc &gt; 100k</code>, or see /help.');
        }
        slice.forEach ((r, i) => {
            const n = p * per + i + 1;
            const muted = engine.isMuted (r.id);
            lines.push (n + '. ' + esc (describeSpec (r.spec)) + (r.paused ? ' <i>(paused)</i>' : '') + (muted ? ' <i>(muted)</i>' : '') + (r.mode === 'once' ? ' <i>· once</i>' : ''));
            kb.text ((r.paused ? '▶ ' : '⏸ ') + n, 'l:p:' + r.id).text ('🗑 ' + n, 'l:d:' + r.id);
            if (ruleScript (r, 'py')) {
                kb.text ('Script ' + n, 'l:s:' + r.id);
            }
            kb.row ();
        });
        if (pages > 1) {
            if (p > 0) {
                kb.text ('‹ Prev', 'l:pg:' + (p - 1));
            }
            if (p < pages - 1) {
                kb.text ('Next ›', 'l:pg:' + (p + 1));
            }
        }
        return { html: lines.join ('\n'), kb };
    };

    // ------------------------------------------------------------ breaking toggles

    const breakingRule = (chatId: number) => store.rulesForChat (chatId).find ((r) => r.spec.kind === 'breaking');

    const breakingKeyboard = (chatId: number) => {
        const r = breakingRule (chatId);
        const on = new Set (r && r.spec.kind === 'breaking' ? r.spec.types : []);
        const kb = new InlineKeyboard ();
        for (const [ t, label ] of Object.entries (BREAKING_LABELS)) {
            kb.text ((on.has (t as BreakingType) ? '✓ ' : '○ ') + label, 'br:' + t).row ();
        }
        return kb;
    };

    // ------------------------------------------------------------ commands

    bot.command ('start', async (ctx) => {
        const user = ensure (ctx);
        const payload = (ctx.match || '').trim ();
        if (isGroup (ctx)) {
            await reply (ctx, 'Hi! Group admins can set me up with /setup. Members can use /p, /funding, /status and /ask.');
            return;
        }
        if (user.settings.tzConfirmed && payload) {
            await handleDeepLink (ctx, payload);
            return;
        }
        if (user.settings.tzConfirmed) {
            await reply (ctx, 'Welcome back. /list shows your alerts, /help shows everything. Want to redo setup?', new InlineKeyboard ().text ('Redo setup', 'ob:redo'));
            return;
        }
        await startOnboarding (ctx, payload || undefined);
    });

    bot.command ('help', async (ctx) => {
        await reply (ctx, HELP);
    });

    bot.command ('about', async (ctx) => {
        await reply (ctx, [
            '<b>CCXT Radar</b> is the official CCXT alert bot. My only handle is @' + esc (cfg.botUsername) + '. Anyone else asking you for keys, seed phrases or payments is a scam.',
            '',
            '• I never ask for API keys, never trade and never move funds.',
            '• Every number comes from an exchange via CCXT (github.com/ccxt/ccxt). Tap "Reproduce with CCXT" on any alert to get the code.',
            '• News is linked to its publishers. The AI only condenses and explains; its numbers are checked against the data.',
            '• Stored: your Telegram id, language, timezone, alerts and a 30-day delivery log. AI chats are kept 7 days. /forget deletes everything.',
            '',
            DISCLAIMER,
        ].join ('\n'));
    });

    bot.command ('alert', async (ctx) => {
        ensure (ctx);
        if (groupThrottle (ctx)) {
            return;
        }
        if (isGroup (ctx) && !(await isAdmin (ctx))) {
            await reply (ctx, 'Only group admins can add alerts here. Members can DM me for personal alerts.');
            return;
        }
        const text = ctx.match || '';
        if (!text.trim ()) {
            await reply (ctx, HELP);
            return;
        }
        const parsed = parseShorthand (text);
        if (parsed) {
            await sendProposal (ctx, parsed.spec, parsed.mode, 'shorthand');
            return;
        }
        await runAssistant (ctx, text);
    });

    bot.command ('list', async (ctx) => {
        ensure (ctx);
        const { html, kb } = listPage (ctx.chat.id, 0);
        await reply (ctx, html, kb);
    });

    bot.command ('pause', async (ctx) => {
        ensure (ctx);
        const arg = (ctx.match || '').trim ().toLowerCase ();
        if (!arg) {
            await reply (ctx, 'Pause all alerts for:', new InlineKeyboard ().text ('1h', 'pa:1').text ('8h', 'pa:8').text ('24h', 'pa:24').text ('Until I resume', 'pa:0'));
            return;
        }
        const h = arg === 'off' ? -1 : Number (arg.replace (/h$/, ''));
        await doPause (ctx, Number.isFinite (h) ? h : 1);
    });

    const doPause = async (ctx: Context, hours: number) => {
        const chatId = ctx.chat!.id;
        if (hours < 0) {
            store.updateUser (chatId, { pausedUntil: 0 });
            await reply (ctx, 'Alerts resumed.');
            return;
        }
        const until = hours === 0 ? Date.now () + 10 * 365 * 86_400_000 : Date.now () + hours * 3_600_000;
        store.updateUser (chatId, { pausedUntil: until });
        await reply (ctx, hours === 0 ? 'All alerts paused until you send /resume.' : 'All alerts paused for ' + hours + 'h. /resume to restart now.');
    };

    bot.command ('resume', async (ctx) => {
        ensure (ctx);
        await doPause (ctx, -1);
    });

    bot.command ('brief', async (ctx) => {
        const user = ensure (ctx);
        const arg = (ctx.match || '').trim ().toLowerCase ();
        if (arg === 'now' || arg === '') {
            const held = arg === 'now' ? store.takeDigestItems (user.chatId) : [];
            await reply (ctx, buildBrief ({ state, store, news, calendar }, user, Date.now (), held) + (arg === '' ? '\n\n<i>Your brief time: ' + (user.briefTime || 'off') + '. Set with /brief 08:00 or /brief off.</i>' : ''));
            return;
        }
        if (arg === 'off') {
            store.updateUser (user.chatId, { briefTime: null });
            await reply (ctx, 'Daily Brief off.');
            return;
        }
        const m = parseHHMM (arg);
        if (m === undefined) {
            await reply (ctx, 'Use <code>/brief 08:00</code>, <code>/brief now</code> or <code>/brief off</code>.');
            return;
        }
        store.updateUser (user.chatId, { briefTime: minutesToHHMM (m) });
        await reply (ctx, 'Daily Brief at ' + minutesToHHMM (m) + ' (' + esc (user.tz) + ').');
    });

    bot.command ('quiet', async (ctx) => {
        const user = ensure (ctx);
        const arg = (ctx.match || '').trim ().toLowerCase ();
        if (arg === 'off') {
            store.updateUser (user.chatId, { quietStart: null, quietEnd: null });
            await reply (ctx, 'Quiet hours off.');
            return;
        }
        const m = arg.match (/^(\d{1,2}(?::\d{2})?)\s*-\s*(\d{1,2}(?::\d{2})?)$/);
        const a = m ? parseHHMM (m[1]) : undefined;
        const b = m ? parseHHMM (m[2]) : undefined;
        if (a === undefined || b === undefined) {
            const cur = user.quietStart !== null && user.quietEnd !== null ? minutesToHHMM (user.quietStart) + '–' + minutesToHHMM (user.quietEnd) : 'off';
            await reply (ctx, 'Quiet hours: ' + cur + ' (' + esc (user.tz) + '). Set with <code>/quiet 23-07</code> or <code>/quiet off</code>. Alerts during quiet hours go into your next Brief.');
            return;
        }
        store.updateUser (user.chatId, { quietStart: a, quietEnd: b });
        await reply (ctx, 'Quiet hours ' + minutesToHHMM (a) + '–' + minutesToHHMM (b) + ' (' + esc (user.tz) + ').');
    });

    bot.command ('budget', async (ctx) => {
        const user = ensure (ctx);
        const n = Number ((ctx.match || '').trim ());
        if (!Number.isFinite (n) || n < 5 || n > cfg.limits.maxDailyBudget) {
            await reply (ctx, 'Daily alert budget: ' + user.dailyBudget + '. Set 5–' + cfg.limits.maxDailyBudget + ' with <code>/budget 20</code>. Alerts over budget go into your next Brief.');
            return;
        }
        store.updateUser (user.chatId, { dailyBudget: Math.round (n) });
        await reply (ctx, 'Daily alert budget set to ' + Math.round (n) + '.');
    });

    bot.command ('tz', async (ctx) => {
        const user = ensure (ctx);
        const arg = (ctx.match || '').trim ();
        if (!arg) {
            const lp = localParts (user.tz, Date.now ());
            await reply (ctx, 'Your timezone: <b>' + esc (user.tz) + '</b> (local time ' + lp.hhmm + '). Change with <code>/tz Europe/Madrid</code>, or pick your current time:', tzKeyboard ());
            return;
        }
        if (!isValidZone (arg)) {
            await reply (ctx, 'Unknown timezone. Use a name like <code>Europe/Madrid</code> or <code>America/New_York</code>.');
            return;
        }
        store.updateUser (user.chatId, { tz: arg, settings: { ...user.settings, tzConfirmed: true } });
        await reply (ctx, 'Timezone set to ' + esc (arg) + '.');
    });

    bot.command ('watch', async (ctx) => {
        const user = ensure (ctx);
        const [ action, coin ] = (ctx.match || '').trim ().split (/\s+/);
        const list = [ ...user.settings.watchlist ];
        if ((action === 'add' || action === 'remove') && coin) {
            const c = coin.toUpperCase ();
            const next = action === 'add' ? [ ...new Set ([ ...list, c ]) ].slice (0, 12) : list.filter ((x) => x !== c);
            store.updateUser (user.chatId, { settings: { ...user.settings, watchlist: next } });
            await reply (ctx, 'Watchlist: ' + (next.length ? next.join (', ') : 'empty') + '. It drives your Daily Brief.');
            return;
        }
        await reply (ctx, 'Watchlist: ' + (list.length ? list.join (', ') : 'empty') + '. Use <code>/watch add sol</code> or <code>/watch remove sol</code>.');
    });

    bot.command ('breaking', async (ctx) => {
        ensure (ctx);
        await reply (ctx, '<b>Breaking events</b> (opt-in, each one confirmed by an official source or 2+ publishers):', breakingKeyboard (ctx.chat.id));
    });

    bot.command ('p', async (ctx) => {
        ensure (ctx);
        if (groupThrottle (ctx)) {
            return;
        }
        const [ coin, v ] = (ctx.match || '').trim ().split (/\s+/);
        if (!coin) {
            await reply (ctx, 'Usage: <code>/p btc</code> or <code>/p eth okx</code>');
            return;
        }
        await reply (ctx, priceView (state, coin.toUpperCase (), v ? venueAlias (v) : undefined));
    });

    bot.command ('funding', async (ctx) => {
        ensure (ctx);
        if (groupThrottle (ctx)) {
            return;
        }
        const coin = (ctx.match || 'btc').trim ().split (/\s+/)[0] || 'btc';
        await reply (ctx, fundingView (state, coin.toUpperCase ()));
    });

    bot.command ('status', async (ctx) => {
        ensure (ctx);
        if (groupThrottle (ctx)) {
            return;
        }
        const v = venueAlias ((ctx.match || '').trim ());
        await reply (ctx, statusView (state, v ? [ v ] : cfg.venues));
    });

    bot.command ('wallet', async (ctx) => {
        ensure (ctx);
        if (groupThrottle (ctx)) {
            return;
        }
        const coin = ((ctx.match || 'usdt').trim ().split (/\s+/)[0] || 'usdt').toUpperCase ();
        await reply (ctx, walletView (state, coin, cfg.venues));
    });

    bot.command ('listings', async (ctx) => {
        ensure (ctx);
        if (groupThrottle (ctx)) {
            return;
        }
        const args = (ctx.match || '').trim ().split (/\s+/);
        const days = args.indexOf ('7d') !== -1 ? 7 : 1;
        const venue = args.map ((a) => venueAlias (a)).find (Boolean);
        await reply (ctx, listingsView (store, days * 86_400_000, venue));
    });

    bot.command ('code', async (ctx) => {
        ensure (ctx);
        const last = store.lastDeliveryWithContext (ctx.chat.id);
        if (!last) {
            await reply (ctx, 'No alert yet. Once one fires, /code gives you the CCXT code behind it.');
            return;
        }
        await sendSnippet (ctx, last.id, last.context, 'py', false);
    });

    bot.command ('ask', async (ctx) => {
        ensure (ctx);
        if (groupThrottle (ctx)) {
            return;
        }
        const q = (ctx.match || '').trim ();
        if (!q) {
            await reply (ctx, 'Ask me about prices, funding, exchange status or listings, e.g. <code>/ask where is SOL cheapest right now?</code>');
            return;
        }
        await runAssistant (ctx, q);
    });

    bot.command ('forget', async (ctx) => {
        ensure (ctx);
        await reply (ctx, 'Delete all your alerts, settings and history? This cannot be undone.', new InlineKeyboard ().text ('Yes, delete everything', 'fg:yes').text ('Cancel', 'fg:no'));
    });

    // ------------------------------------------------------------ groups

    const isAdmin = async (ctx: Context): Promise<boolean> => {
        if (!isGroup (ctx)) {
            return true;
        }
        if (!ctx.from || ctx.from.id === ANON_ADMIN_ID) {
            return false;
        }
        try {
            const m = await ctx.getChatMember (ctx.from.id);
            return m.status === 'creator' || m.status === 'administrator';
        } catch {
            return false;
        }
    };

    const GROUP_PRESETS: Record<string, { label: string, specs: unknown[] }> = {
        majors: { label: 'Majors ±5% in 1h', specs: [ 'BTC', 'ETH', 'SOL' ].map ((b) => ({ kind: 'move', base: b, venue: 'median', pct: 5, windowMin: 60, direction: 'both' })) },
        listings: { label: 'Major listings', specs: [ { kind: 'listing', venues: [ 'binance', 'coinbase', 'okx', 'bybit', 'upbit' ], markets: [ 'spot' ], removals: false } ] },
        funding: { label: 'Funding extremes', specs: [ { kind: 'funding', base: '*', venues: [], high: 0.0015, low: -0.001 } ] },
        status: { label: 'Outages', specs: [ { kind: 'status', venues: [] } ] },
    };

    const setupKeyboard = (user: UserRow) => {
        const on = new Set (Object.keys ((user.settings as any).presetRules || {}));
        const kb = new InlineKeyboard ();
        for (const [ id, p ] of Object.entries (GROUP_PRESETS)) {
            kb.text ((on.has (id) ? '✓ ' : '○ ') + p.label, 'gs:' + id).row ();
        }
        kb.text ((user.briefTime ? '✓ ' : '○ ') + 'Daily Brief 08:00 UTC', 'gs:brief').row ();
        const cap = (user.settings as any).postCap || 6;
        for (const c of [ 3, 6, 12 ]) {
            kb.text ((cap === c ? '● ' : '') + c + '/hour', 'gs:cap:' + c);
        }
        return kb;
    };

    bot.command ('setup', async (ctx) => {
        if (!isGroup (ctx)) {
            await reply (ctx, '/setup is for groups. In a DM, use /start or just type an alert.');
            return;
        }
        if (ctx.from?.id === ANON_ADMIN_ID) {
            await reply (ctx, 'I can\'t verify anonymous admins. Please run /setup from your own account (turn off "Remain anonymous" briefly).');
            return;
        }
        if (!(await isAdmin (ctx))) {
            await reply (ctx, 'Only group admins can run /setup.');
            return;
        }
        const user = ensure (ctx);
        await reply (ctx, '<b>Group setup</b>\nPick what this group receives. Members can use /p, /funding, /status and /ask.\n<i>Keep me as a regular member (not admin) so I can\'t read ordinary messages.</i>', setupKeyboard (user));
    });

    // Replies to the bot in groups are treated as /ask.
    bot.on ('message:text', async (ctx, next) => {
        const text = ctx.message.text;
        if (text.startsWith ('/')) {
            return next ();
        }
        if (isGroup (ctx)) {
            if (ctx.message.reply_to_message?.from?.id === ctx.me.id) {
                ensure (ctx);
                if (!groupThrottle (ctx)) {
                    await runAssistant (ctx, text);
                }
            }
            return;
        }
        const user = ensure (ctx);
        const ob: any = user.onboarding;
        if (ob && ob.step === 'customcoin') {
            const coin = text.trim ().toUpperCase ().replace (/[^A-Z0-9]/g, '').slice (0, 15);
            ob.coins = [ ...new Set ([ ...(ob.coins || []), coin ]) ].filter (Boolean);
            ob.step = 'coins';
            store.updateUser (user.chatId, { onboarding: ob });
            await reply (ctx, 'Added ' + esc (coin) + '. Pick coins (tap to toggle):', coinsKeyboard (ob.coins));
            return;
        }
        const parsed = parseShorthand (text);
        if (parsed) {
            await sendProposal (ctx, parsed.spec, parsed.mode, 'shorthand');
            return;
        }
        if (/^[a-z0-9]{2,10}$/i.test (text.trim ()) && state.medianPrice (text.trim ().toUpperCase ())) {
            await reply (ctx, priceView (state, text.trim ().toUpperCase ()));
            return;
        }
        await runAssistant (ctx, text);
    });

    // ------------------------------------------------------------ snippets

    const snippetKeyboard = (did: string, lang: Lang) => {
        const kb = new InlineKeyboard ();
        for (const l of [ 'py', 'js', 'go', 'cli' ] as Lang[]) {
            kb.text ((l === lang ? '● ' : '') + ({ py: 'Python', js: 'JS', go: 'Go', cli: 'CLI' } as any)[l], 'sn:' + did + ':' + l);
        }
        return kb;
    };

    const snippetHtml = (ctx2: DeliveryContext, lang: Lang) => {
        const code = snippet (ctx2, lang);
        const cls = ({ py: 'python', js: 'javascript', go: 'go', cli: 'bash' } as any)[lang];
        return '<b>Reproduce with CCXT</b>\n<pre><code class="language-' + cls + '">' + esc (code) + '</code></pre>\n<i>' + esc (INSTALL[lang]) + ' · returns current values · docs.ccxt.com</i>';
    };

    const sendSnippet = async (ctx: Context, did: string, c: DeliveryContext, lang: Lang, inPlace: boolean) => {
        const html = snippetHtml (c, lang);
        if (inPlace) {
            await edit (ctx, html, snippetKeyboard (did, lang));
        } else {
            await reply (ctx, html, snippetKeyboard (did, lang));
        }
    };

    // ------------------------------------------------------------ callbacks

    bot.on ('callback_query:data', async (ctx) => {
        const data = ctx.callbackQuery.data;
        const parts = data.split (':');
        const chatId = ctx.chat?.id;
        if (chatId === undefined) {
            await ctx.answerCallbackQuery ();
            return;
        }
        try {
            switch (parts[0]) {
                case 'ob':
                    if (parts[1] === 'redo') {
                        await ctx.answerCallbackQuery ();
                        await startOnboarding (ctx);
                        return;
                    }
                    if (parts[1] === 't' && store.getUser (chatId)?.onboarding === null) {
                        // /tz picker outside onboarding
                        const tz = zoneForOffset (Number (parts[2]), Date.now ());
                        const u = store.getUser (chatId)!;
                        store.updateUser (chatId, { tz, settings: { ...u.settings, tzConfirmed: true } });
                        await ctx.answerCallbackQuery ({ text: 'Timezone: ' + tz });
                        await edit (ctx, 'Timezone set to <b>' + esc (tz) + '</b>.');
                        return;
                    }
                    await ctx.answerCallbackQuery ();
                    await onboardingCallback (ctx, parts);
                    return;
                case 'pr': {
                    const p = store.getProposal (parts[2]);
                    if (!p || p.chatId !== chatId) {
                        await ctx.answerCallbackQuery ({ text: 'This card expired. Create the alert again.' });
                        return;
                    }
                    if (parts[1] === 'x') {
                        store.deleteProposal (p.id);
                        await ctx.answerCallbackQuery ({ text: 'Cancelled' });
                        await edit (ctx, '<s>' + esc (describeSpec (p.spec)) + '</s>\nCancelled.');
                        return;
                    }
                    if (parts[1] === 'mode') {
                        const mode = p.mode === 'once' ? 'repeat' : 'once';
                        store.updateProposal (p.id, p.spec, mode);
                        await ctx.answerCallbackQuery ({ text: mode === 'once' ? 'Fires once' : 'Repeats' });
                        await edit (ctx, proposalText (p.spec, mode, []), proposalKeyboard (p.id, mode));
                        return;
                    }
                    if (parts[1] === 'save') {
                        if (isGroup (ctx) && !(await isAdmin (ctx))) {
                            await ctx.answerCallbackQuery ({ text: 'Only group admins can save alerts here.' });
                            return;
                        }
                        if (store.countRules (chatId) >= cfg.limits.maxRulesPerUser) {
                            await ctx.answerCallbackQuery ({ text: 'Alert limit reached. Remove some in /list.' });
                            return;
                        }
                        const d = KIND_DEFAULTS[p.spec.kind];
                        const rule = store.insertRule ({ chatId, spec: p.spec, mode: p.mode, cooldownS: d.cooldownS, expiresAt: null, paused: false, breakQuiet: false, source: p.source });
                        store.deleteProposal (p.id);
                        engine.markDirty ();
                        await ctx.answerCallbackQuery ({ text: 'Saved' });
                        const kb = new InlineKeyboard ();
                        if (ruleScript (rule, 'py')) {
                            kb.text ('Get it as a CCXT script', 'l:s:' + rule.id);
                        }
                        kb.text ('My alerts', 'l:pg:0');
                        await edit (ctx, '✓ <b>Saved:</b> ' + esc (describeSpec (rule.spec)) + (rule.mode === 'once' ? ' <i>(once)</i>' : ''), kb);
                        return;
                    }
                    break;
                }
                case 'l': {
                    if (parts[1] === 'pg') {
                        await ctx.answerCallbackQuery ();
                        const { html, kb } = listPage (chatId, Number (parts[2]));
                        if (ctx.callbackQuery.message?.text?.startsWith ('Your alerts')) {
                            await edit (ctx, html, kb);
                        } else {
                            await reply (ctx, html, kb);
                        }
                        return;
                    }
                    const rule = store.getRule (parts[2]);
                    if (!rule || rule.chatId !== chatId) {
                        await ctx.answerCallbackQuery ({ text: 'Alert not found' });
                        return;
                    }
                    if (isGroup (ctx) && parts[1] !== 's' && !(await isAdmin (ctx))) {
                        await ctx.answerCallbackQuery ({ text: 'Only group admins can change alerts here.' });
                        return;
                    }
                    if (parts[1] === 'p') {
                        store.setRulePaused (rule.id, !rule.paused);
                        engine.markDirty ();
                        await ctx.answerCallbackQuery ({ text: rule.paused ? 'Resumed' : 'Paused' });
                    } else if (parts[1] === 'd') {
                        store.deleteRule (rule.id);
                        engine.markDirty ();
                        await ctx.answerCallbackQuery ({ text: 'Deleted' });
                    } else if (parts[1] === 's') {
                        await ctx.answerCallbackQuery ();
                        const py = ruleScript (rule, 'py');
                        const js = ruleScript (rule, 'js');
                        if (py && js) {
                            await reply (ctx, '<b>Your alert as a CCXT script</b>\n<b>Python</b>\n<pre><code class="language-python">' + esc (py) + '</code></pre>\n<b>JavaScript</b>\n<pre><code class="language-javascript">' + esc (js) + '</code></pre>\n<i>pip install ccxt · npm install ccxt</i>');
                        }
                        return;
                    }
                    const { html, kb } = listPage (chatId, 0);
                    await edit (ctx, html, kb);
                    return;
                }
                case 'al': {
                    if (parts[1] === 'mu') {
                        engine.mute (parts[2], Number (parts[3]) * 3_600_000);
                        await ctx.answerCallbackQuery ({ text: 'Muted for ' + parts[3] + 'h' });
                        return;
                    }
                    const d = store.getDelivery (parts[2]);
                    if (!d || d.chatId !== chatId) {
                        await ctx.answerCallbackQuery ({ text: 'This alert is too old (deliveries are kept 30 days).' });
                        return;
                    }
                    if (parts[1] === 'rp' && d.context) {
                        await ctx.answerCallbackQuery ();
                        await sendSnippet (ctx, d.id, d.context, (parts[3] as Lang) || 'py', false);
                        return;
                    }
                    if (parts[1] === 'bad') {
                        store.addReport (d.id, chatId, 'looks wrong');
                        await ctx.answerCallbackQuery ({ text: 'Thanks, reported. We review every report.' });
                        return;
                    }
                    if (parts[1] === 'why' && d.context) {
                        const limit = aiLimit (chatId);
                        const q = assistant.enabled ? store.takeAiQuota (chatId, limit) : { ok: true, used: 0, limit };
                        if (!q.ok) {
                            await ctx.answerCallbackQuery ({ text: 'No AI messages left today (' + q.used + '/' + q.limit + ').' });
                            return;
                        }
                        await ctx.answerCallbackQuery ({ text: 'Looking…' });
                        const html = await assistant.explain (chatId, d.context);
                        await reply (ctx, html + (assistant.enabled ? '\n<i>AI ' + q.used + '/' + q.limit + ' today</i>' : ''));
                        return;
                    }
                    break;
                }
                case 'sn': {
                    const d = store.getDelivery (parts[1]);
                    if (!d || !d.context || d.chatId !== chatId) {
                        await ctx.answerCallbackQuery ({ text: 'Snippet expired' });
                        return;
                    }
                    await ctx.answerCallbackQuery ();
                    await sendSnippet (ctx, d.id, d.context, parts[2] as Lang, true);
                    return;
                }
                case 'br': {
                    const type = parts[1] as BreakingType;
                    const existing = breakingRule (chatId);
                    const current = existing && existing.spec.kind === 'breaking' ? existing.spec.types : [];
                    const next = current.indexOf (type) !== -1 ? current.filter ((t) => t !== type) : [ ...current, type ];
                    if (existing) {
                        if (next.length === 0) {
                            store.deleteRule (existing.id);
                        } else {
                            store.updateRuleSpec (existing.id, { kind: 'breaking', types: next });
                        }
                    } else if (next.length) {
                        store.insertRule ({ chatId, spec: { kind: 'breaking', types: next }, mode: 'repeat', cooldownS: 0, expiresAt: null, paused: false, breakQuiet: false, source: 'button' });
                    }
                    engine.markDirty ();
                    await ctx.answerCallbackQuery ({ text: next.indexOf (type) !== -1 ? 'On' : 'Off' });
                    await edit (ctx, '<b>Breaking events</b> (opt-in, each one confirmed by an official source or 2+ publishers):', breakingKeyboard (chatId));
                    return;
                }
                case 'pa':
                    await ctx.answerCallbackQuery ();
                    await doPause (ctx, Number (parts[1]));
                    return;
                case 'fg':
                    await ctx.answerCallbackQuery ();
                    if (parts[1] === 'yes') {
                        store.forgetUser (chatId);
                        engine.markDirty ();
                        await edit (ctx, 'Done. Everything about you is deleted. /start to begin again.');
                    } else {
                        await edit (ctx, 'Nothing deleted.');
                    }
                    return;
                case 'gs': {
                    if (!(await isAdmin (ctx))) {
                        await ctx.answerCallbackQuery ({ text: 'Only group admins can change this.' });
                        return;
                    }
                    const user = ensure (ctx);
                    const settings: any = { ...user.settings, presetRules: { ...((user.settings as any).presetRules || {}) } };
                    if (parts[1] === 'cap') {
                        settings.postCap = Number (parts[2]);
                        store.updateUser (chatId, { settings, dailyBudget: Number (parts[2]) * 24 });
                    } else if (parts[1] === 'brief') {
                        store.updateUser (chatId, { briefTime: user.briefTime ? null : '08:00', tz: 'UTC' });
                    } else if (GROUP_PRESETS[parts[1]]) {
                        const id = parts[1];
                        if (settings.presetRules[id]) {
                            for (const rid of settings.presetRules[id]) {
                                store.deleteRule (rid);
                            }
                            delete settings.presetRules[id];
                        } else {
                            settings.presetRules[id] = GROUP_PRESETS[id].specs.map ((s) => {
                                const r = parseSpec (s);
                                if (!r.ok) {
                                    return '';
                                }
                                const d = KIND_DEFAULTS[r.spec.kind];
                                return store.insertRule ({ chatId, spec: r.spec, mode: 'repeat', cooldownS: d.cooldownS, expiresAt: null, paused: false, breakQuiet: false, source: 'preset' }).id;
                            }).filter (Boolean);
                        }
                        store.updateUser (chatId, { settings });
                        engine.markDirty ();
                    }
                    await ctx.answerCallbackQuery ({ text: 'Updated' });
                    await edit (ctx, '<b>Group setup</b>\nPick what this group receives.', setupKeyboard (store.getUser (chatId)!));
                    return;
                }
            }
            await ctx.answerCallbackQuery ();
        } catch (e) {
            console.error ('[bot] callback failed', data, e);
            await ctx.answerCallbackQuery ({ text: 'Something went wrong. Please try again.' }).catch (() => undefined);
        }
    });

    bot.on ('my_chat_member', async (ctx) => {
        const status = ctx.myChatMember.new_chat_member.status;
        if (status === 'left' || status === 'kicked') {
            const u = store.getUser (ctx.chat.id);
            if (u) {
                store.updateUser (ctx.chat.id, { status: 'inactive' });
                engine.markDirty ();
            }
        }
    });

    bot.catch ((err) => {
        console.error ('[bot] error in update', err.ctx?.update?.update_id, err.error);
    });

    return bot;
}

export const BOT_COMMANDS = [
    { command: 'start', description: 'Set up your alerts' },
    { command: 'alert', description: 'Create an alert, e.g. /alert btc > 100k' },
    { command: 'list', description: 'Your alerts' },
    { command: 'p', description: 'Price across exchanges, e.g. /p eth' },
    { command: 'funding', description: 'Funding board, e.g. /funding btc' },
    { command: 'status', description: 'Exchange status' },
    { command: 'listings', description: 'New and removed markets' },
    { command: 'wallet', description: 'Deposit/withdrawal status, e.g. /wallet usdt' },
    { command: 'brief', description: 'Daily Brief time, or /brief now' },
    { command: 'breaking', description: 'Breaking events opt-in' },
    { command: 'pause', description: 'Pause all alerts' },
    { command: 'resume', description: 'Resume alerts' },
    { command: 'ask', description: 'Ask about the market (AI)' },
    { command: 'code', description: 'CCXT code for your last alert' },
    { command: 'help', description: 'All commands' },
    { command: 'about', description: 'About, privacy and safety' },
    { command: 'forget', description: 'Delete all your data' },
];

export const GROUP_COMMANDS = [
    { command: 'p', description: 'Price across exchanges' },
    { command: 'funding', description: 'Funding board' },
    { command: 'status', description: 'Exchange status' },
    { command: 'ask', description: 'Ask about the market (AI)' },
    { command: 'setup', description: 'Admins: configure this group' },
];

export { shortAge };
