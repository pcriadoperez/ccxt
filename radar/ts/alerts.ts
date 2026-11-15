// Alert objects and their message templates (Telegram HTML).

import type { DeliveryContext } from './db.js';
import type { MarketEvent } from './events.js';
import type { Funding } from './market/state.js';
import { to8h, toApr } from './market/state.js';
import type { Rule } from './rules.js';
import { KIND_DEFAULTS } from './rules.js';
import { esc, fmtAge, fmtDuration, fmtFundingRate, fmtPct, fmtPrice, venueName } from './format.js';

export interface Alert {
    chatId: number;
    ruleId?: string;
    eventKey?: string;
    priority: 1 | 2 | 3;
    ttlMs: number;
    html: string;
    summary: string; // one line, used when merging several alerts or holding them for the Brief
    breakQuiet?: boolean;
    countsAgainstBudget: boolean;
    buttons: 'alert' | 'none';
    context?: DeliveryContext;
    createdAt: number;
}

export function alertFor (rule: Rule, html: string, summary: string, context: DeliveryContext, now: number, eventKey?: string): Alert {
    const d = KIND_DEFAULTS[rule.spec.kind];
    return {
        chatId: rule.chatId,
        ruleId: rule.id,
        eventKey,
        priority: d.priority,
        ttlMs: d.ttlS * 1000,
        html,
        summary,
        breakQuiet: rule.breakQuiet,
        countsAgainstBudget: true,
        buttons: 'alert',
        context,
        createdAt: now,
    };
}

export function footer (venue: string, method: string, ts: number, now: number): string {
    const src = venue === 'median' ? 'median of major venues' : venueName (venue);
    return '<i>Data: ' + esc (src) + ' · fetched ' + fmtAge (Math.max (0, now - ts)) + ' ago with ccxt ' + esc (method) + '</i>';
}

export function priceAlertHtml (p: { base: string, symbol: string, venue: string, op: 'above' | 'below', threshold: number, value: number, field: string, ts: number, now: number, note?: string }): string {
    const head = p.op === 'above' ? '▲ Price above ' : '▼ Price below ';
    const lines = [
        '<b>' + head + esc (fmtPrice (p.threshold)) + ' · ' + esc (p.symbol) + '</b>',
        esc (venueName (p.venue)) + ' ' + (p.field === 'mark' ? 'mark ' : '') + '<code>' + esc (fmtPrice (p.value)) + '</code>',
    ];
    if (p.note) {
        lines.push (esc (p.note));
    }
    lines.push (footer (p.venue, p.venue === 'median' ? 'fetchTickers' : (p.field === 'mark' ? 'fetchFundingRates' : 'fetchTickers'), p.ts, p.now));
    return lines.join ('\n');
}

export function moveAlertHtml (p: { base: string, venue: string, pct: number, windowMin: number, from: number, to: number, ts: number, now: number }): string {
    const up = p.pct >= 0;
    return [
        '<b>' + (up ? '▲ ' : '▼ ') + esc (p.base) + ' ' + fmtPct (p.pct, 2, true) + ' in ' + windowLabel (p.windowMin) + '</b>',
        '<code>' + esc (fmtPrice (p.from)) + ' → ' + esc (fmtPrice (p.to)) + '</code>',
        footer (p.venue, 'fetchTickers', p.ts, p.now),
    ].join ('\n');
}

export function windowLabel (min: number): string {
    return min % 60 === 0 ? (min / 60) + 'h' : min + 'm';
}

export function fundingLine (venue: string, f: Funding): string {
    return esc (venueName (venue)) + ' ' + fmtFundingRate (f.rate) + ' / ' + f.intervalH + 'h' + (f.intervalAssumed ? '*' : '') + ' (8h-eq ' + fmtFundingRate (to8h (f)) + ', ' + fmtPct (toApr (f) * 100, 1, true) + ' APR)';
}

export function fundingAlertHtml (p: { symbol: string, venue: string, f: Funding, high: number | null, low: number | null, others: Array<{ venue: string, f: Funding }>, now: number }): string {
    const v8 = to8h (p.f);
    const which = (p.high !== null && v8 > p.high) ? 'above ' + fmtFundingRate (p.high) : 'below ' + fmtFundingRate (p.low ?? 0);
    const lines = [
        '<b>Funding extreme · ' + esc (p.symbol) + '</b>',
        '<code>' + fundingLine (p.venue, p.f) + '</code>',
        'Your rule: 8h-equivalent ' + esc (which),
    ];
    if (p.f.settleTs) {
        lines.push ('Settles in ' + fmtDuration (p.f.settleTs - p.now));
    }
    if (p.others.length) {
        lines.push ('<i>' + p.others.slice (0, 4).map ((o) => esc (venueName (o.venue)) + ' ' + fmtFundingRate (to8h (o.f))).join (' · ') + ' (8h-eq)</i>');
    }
    if (p.f.intervalAssumed) {
        lines.push ('<i>* interval not reported by the venue; 8h assumed</i>');
    }
    lines.push (footer (p.venue, 'fetchFundingRates', p.f.ts, p.now));
    return lines.join ('\n');
}

export function fundingGapHtml (p: { base: string, rows: Array<{ venue: string, f: Funding }>, gap: number, now: number }): string {
    const sorted = [ ...p.rows ].sort ((a, b) => toApr (b.f) - toApr (a.f));
    return [
        '<b>Funding gap · ' + esc (p.base) + ' perps · ' + fmtPct (p.gap * 100, 1) + ' APR</b>',
        ...sorted.map ((r) => '<code>' + esc (venueName (r.venue).padEnd (11)) + fmtPct (toApr (r.f) * 100, 1, true).padStart (8) + ' APR</code>'),
        '<i>Gross gap only: fees, basis and transfer costs are not included.</i>',
        footer (sorted[0].venue, 'fetchFundingRates', Math.min (...sorted.map ((r) => r.f.ts)), p.now),
    ].join ('\n');
}

export function settleHtml (p: { symbol: string, venue: string, f: Funding, now: number }): string {
    return [
        '<b>Funding settles in ' + fmtDuration ((p.f.settleTs || p.now) - p.now) + ' · ' + esc (p.symbol) + '</b>',
        '<code>' + fundingLine (p.venue, p.f) + '</code>',
        footer (p.venue, 'fetchFundingRates', p.f.ts, p.now),
    ].join ('\n');
}

export function oiHtml (p: { symbol: string, venue: string, pct: number, windowMin: number, from: number, to: number, ts: number, now: number }): string {
    return [
        '<b>Open interest ' + fmtPct (p.pct, 1, true) + ' in ' + windowLabel (p.windowMin) + ' · ' + esc (p.symbol) + '</b>',
        esc (venueName (p.venue)) + ' <code>' + esc (fmtPrice (p.from)) + ' → ' + esc (fmtPrice (p.to)) + '</code> (contracts/base units)',
        footer (p.venue, 'fetchOpenInterest', p.ts, p.now),
    ].join ('\n');
}

export function eventHtml (ev: MarketEvent, now: number): string {
    switch (ev.type) {
        case 'listing':
            return [
                '<b>New ' + (ev.data.market === 'perp' ? 'perp' : 'spot') + ' market · ' + esc (venueName (ev.venue || '')) + '</b>',
                '<code>' + esc (ev.symbol) + '</code> is now listed and active.',
                '<i>Detected by comparing market lists (ccxt loadMarkets), confirmed twice.</i>',
            ].join ('\n');
        case 'delisting':
            return [
                '<b>Market removed · ' + esc (venueName (ev.venue || '')) + '</b>',
                '<code>' + esc (ev.symbol) + '</code> is no longer listed or no longer active.',
                '<i>Confirmed in 3 consecutive market snapshots (ccxt loadMarkets).</i>',
            ].join ('\n');
        case 'wallet': {
            const what = ev.data.field === 'deposit' ? 'Deposits' : 'Withdrawals';
            const state = ev.data.to ? 'reopened' : 'paused';
            const net = ev.data.network === '*' ? '' : ' on ' + esc (ev.data.network);
            return [
                '<b>' + what + ' ' + state + ' · ' + esc (ev.code) + net + '</b>',
                esc (venueName (ev.venue || '')) + ' reports ' + ev.data.field + ' ' + (ev.data.to ? 'enabled' : 'disabled') + '.',
                footer (ev.venue || '', 'fetchCurrencies', ev.ts, now),
            ].join ('\n');
        }
        case 'status':
            if (ev.data.state === 'down') {
                return [
                    '<b>⚠ ' + esc (venueName (ev.venue || '')) + ' looks degraded</b>',
                    'No fresh data for ' + fmtDuration (now - ev.data.since) + '. Reason: ' + esc (ev.data.reason || 'unknown') + '.',
                    '<i>Its alerts are paused until data is fresh again.</i>',
                ].join ('\n');
            }
            return '<b>✓ ' + esc (venueName (ev.venue || '')) + ' recovered</b>\nData has been fresh for 10 minutes.';
        case 'depeg':
            return [
                '<b>Depeg · ' + esc (ev.code) + ' at ' + esc (fmtPrice (ev.data.price)) + ' USD</b>',
                'Off the dollar by ' + fmtPct (Math.abs (ev.data.price - 1) * 100, 2) + ' for at least 2 minutes.',
                '<i>Measured on ' + esc ((ev.data.venues || []).map (venueName).join (', ')) + ' USD pairs.</i>',
            ].join ('\n');
        case 'bigmove':
            return [
                '<b>' + (ev.data.pct >= 0 ? '▲ ' : '▼ ') + esc (ev.base) + ' ' + fmtPct (ev.data.pct, 1, true) + ' in ' + ev.data.windowMin + ' min</b>',
                '<code>' + esc (fmtPrice (ev.data.from)) + ' → ' + esc (fmtPrice (ev.data.to)) + '</code> (median of major venues)',
                ev.data.cause ? 'Possibly related: ' + ev.data.cause : '<i>Move detected, cause unconfirmed.</i>',
            ].join ('\n');
        case 'macro':
            return [
                '<b>Macro · ' + esc (ev.data.title) + '</b>',
                'Released ' + new Date (ev.data.at).toISOString ().slice (11, 16) + ' UTC (' + esc (ev.data.source) + ').',
                ev.data.reaction ? 'BTC since release: ' + esc (ev.data.reaction) : '',
            ].filter (Boolean).join ('\n');
        case 'exploit':
            return [
                '<b>Reported exploit · ' + esc (ev.data.title) + '</b>',
                (ev.data.sources || []).map ((s: any) => '<a href="' + esc (s.link) + '">' + esc (s.publisher) + '</a>').join (' · '),
                '<i>Reported by ' + (ev.data.sources || []).length + ' independent publishers. Details may change.</i>',
            ].join ('\n');
    }
}

export function eventSummary (ev: MarketEvent): string {
    switch (ev.type) {
        case 'listing': return 'New market ' + ev.symbol + ' on ' + venueName (ev.venue || '');
        case 'delisting': return 'Removed ' + ev.symbol + ' on ' + venueName (ev.venue || '');
        case 'wallet': return ev.code + ' ' + ev.data.field + ' ' + (ev.data.to ? 'reopened' : 'paused') + ' on ' + venueName (ev.venue || '');
        case 'status': return venueName (ev.venue || '') + (ev.data.state === 'down' ? ' degraded' : ' recovered');
        case 'depeg': return ev.code + ' depeg ' + fmtPrice (ev.data.price);
        case 'bigmove': return ev.base + ' ' + fmtPct (ev.data.pct, 1, true) + ' in ' + ev.data.windowMin + 'm';
        case 'macro': return 'Macro: ' + ev.data.title;
        case 'exploit': return 'Exploit: ' + ev.data.title;
    }
}
