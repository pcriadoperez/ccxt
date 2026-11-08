// Deterministic shorthand parser: "btc > 100k", "sol 5% 4h", "funding eth > 0.1%", "eth -10% from 3400", ...
// It runs before the AI, so common requests cost nothing and work when the AI is off.

import type { RuleSpec } from './rules.js';
import { parseSpec } from './rules.js';
import { parseHumanNumber } from './format.js';
import { CORE_VENUES, LISTING_ONLY_VENUES } from './config.js';

const VENUE_ALIASES: Record<string, string> = {
    binance: 'binance', bybit: 'bybit', okx: 'okx', okex: 'okx', coinbase: 'coinbase', cb: 'coinbase', kraken: 'kraken',
    bitget: 'bitget', gate: 'gate', gateio: 'gate', kucoin: 'kucoin', hyperliquid: 'hyperliquid', hl: 'hyperliquid', mexc: 'mexc',
    upbit: 'upbit', bithumb: 'bithumb', htx: 'htx', huobi: 'htx', cryptocom: 'cryptocom', 'crypto.com': 'cryptocom', bingx: 'bingx',
};

export function venueAlias (word: string): string | undefined {
    return VENUE_ALIASES[word.toLowerCase ()];
}

export const KNOWN_VENUES = new Set ([ ...CORE_VENUES, ...LISTING_ONLY_VENUES ]);

export interface ParsedRule {
    spec: RuleSpec;
    mode: 'once' | 'repeat';
}

function parseWindow (w: string): number | undefined {
    const m = w.toLowerCase ().match (/^(\d+(?:\.\d+)?)(m|min|h|hr|d)$/);
    if (!m) {
        return undefined;
    }
    const n = Number (m[1]);
    const mult = m[2] === 'd' ? 1440 : (m[2] === 'h' || m[2] === 'hr' ? 60 : 1);
    return Math.round (n * mult);
}

function parsePct (w: string): number | undefined {
    const m = w.match (/^([+-]?\d+(?:\.\d+)?)%$/);
    return m ? Number (m[1]) : undefined;
}

// Pull venue, market and modifiers out of the token list; returns the remaining tokens.
function extractModifiers (tokens: string[]): { rest: string[], venues: string[], perp: boolean, mark: boolean, once: boolean, repeat: boolean } {
    const rest: string[] = [];
    const venues: string[] = [];
    let perp = false;
    let mark = false;
    let once = false;
    let repeat = false;
    for (const t of tokens) {
        const lower = t.toLowerCase ().replace (/^on$/, '');
        if (lower === '') {
            continue;
        }
        const v = venueAlias (lower);
        if (v) {
            venues.push (v);
        } else if (lower === 'perp' || lower === 'perps' || lower === 'swap' || lower === 'futures') {
            perp = true;
        } else if (lower === 'spot') {
            perp = false;
        } else if (lower === 'mark') {
            mark = true;
            perp = true;
        } else if (lower === 'once') {
            once = true;
        } else if (lower === 'repeat' || lower === 'always') {
            repeat = true;
        } else {
            rest.push (t);
        }
    }
    return { rest, venues, perp, mark, once, repeat };
}

export function parseShorthand (text: string): ParsedRule | undefined {
    const clean = text.trim ().replace (/^\/alert(@\w+)?\s*/i, '').replace (/\s+/g, ' ');
    if (!clean) {
        return undefined;
    }
    const raw = clean.split (' ').filter (Boolean);
    const { rest, venues, perp, mark, once, repeat } = extractModifiers (raw);
    if (rest.length === 0) {
        return undefined;
    }
    const head = rest[0].toLowerCase ();
    const finish = (spec: unknown, defMode: 'once' | 'repeat'): ParsedRule | undefined => {
        const r = parseSpec (spec);
        if (!r.ok) {
            return undefined;
        }
        return { spec: r.spec, mode: once ? 'once' : (repeat ? 'repeat' : defMode) };
    };

    // funding <coin|any> > 0.1% [< -0.05%]
    if (head === 'funding') {
        const coin = (rest[1] && !/^[<>]/.test (rest[1])) ? rest[1] : '*';
        const tail = rest.slice (coin === '*' && rest[1] && /^[<>]/.test (rest[1]) ? 1 : 2).join (' ');
        let high: number | null = null;
        let low: number | null = null;
        for (const m of tail.matchAll (/([<>])\s*(-?\d+(?:\.\d+)?)%/g)) {
            const v = Number (m[2]) / 100;
            if (m[1] === '>') {
                high = v;
            } else {
                low = v;
            }
        }
        if (high === null && low === null) {
            high = 0.001;
            low = -0.0005;
        }
        const base = (coin === 'any' || coin === '*' || coin === 'all') ? '*' : coin;
        return finish ({ kind: 'funding', base, venues, high, low }, 'repeat');
    }
    // gap btc [20%]
    if (head === 'gap' || head === 'fundinggap') {
        const coin = rest[1];
        const pct = rest[2] ? parsePct (rest[2]) : undefined;
        return finish ({ kind: 'fundinggap', base: coin, venues, aprGap: pct !== undefined ? pct / 100 : undefined }, 'repeat');
    }
    // settle btc [15m]
    if (head === 'settle' || head === 'settlement') {
        const w = rest[2] ? parseWindow (rest[2]) : undefined;
        return finish ({ kind: 'settle', base: rest[1], venues, minutesBefore: w }, 'repeat');
    }
    // oi btc 8% 1h
    if (head === 'oi') {
        const pct = rest[2] ? parsePct (rest[2]) : undefined;
        const w = rest[3] ? parseWindow (rest[3]) : undefined;
        return finish ({ kind: 'oi', base: rest[1], venues, pct: pct !== undefined ? Math.abs (pct) : undefined, windowMin: w }, 'repeat');
    }
    // listings [coin...]
    if (head === 'listings' || head === 'listing' || head === 'new') {
        const bases = rest.slice (1).filter ((t) => /^[a-z0-9]{2,15}$/i.test (t) && t.toLowerCase () !== 'markets');
        return finish ({ kind: 'listing', venues, markets: perp ? [ 'perp' ] : [ 'spot', 'perp' ], bases }, 'repeat');
    }
    // wallet usdt
    if (head === 'wallet' || head === 'withdrawals' || head === 'deposits') {
        return finish ({ kind: 'wallet', code: rest[1], venues }, 'repeat');
    }
    // status [venues]
    if (head === 'status' || head === 'outage' || head === 'outages') {
        return finish ({ kind: 'status', venues }, 'repeat');
    }
    // depeg [usdt usdc]
    if (head === 'depeg') {
        const codes = rest.slice (1).map ((c) => c.toUpperCase ());
        return finish ({ kind: 'depeg', codes: codes.length ? codes : undefined }, 'repeat');
    }

    // <coin> ...
    if (!/^[a-z0-9]{1,15}$/i.test (rest[0])) {
        return undefined;
    }
    const base = rest[0];
    const venue = venues[0] || 'median';
    const market = perp ? 'perp' : 'spot';
    const field = mark ? 'mark' : 'last';

    // <coin> > 100k  |  <coin> above 100k  |  <coin> < 90000
    if (rest.length >= 3 || (rest.length === 2 && /^[<>]/.test (rest[1]))) {
        let opWord = rest[1].toLowerCase ();
        let valueWord = rest[2];
        const glued = opWord.match (/^([<>])(.+)$/);
        if (glued) {
            opWord = glued[1];
            valueWord = glued[2];
        }
        const op = (opWord === '>' || opWord === '>=' || opWord === 'above' || opWord === 'over') ? 'above'
            : ((opWord === '<' || opWord === '<=' || opWord === 'below' || opWord === 'under') ? 'below' : undefined);
        if (op && valueWord) {
            const value = parseHumanNumber (valueWord);
            if (value !== undefined) {
                return finish ({ kind: 'price', base, market, venue, field, op, value }, 'once');
            }
        }
    }
    // <coin> -10% from 3400
    if (rest.length >= 4 && rest[2].toLowerCase () === 'from') {
        const pct = parsePct (rest[1]);
        const ref = parseHumanNumber (rest[3]);
        if (pct !== undefined && ref !== undefined && pct !== 0) {
            const value = ref * (1 + pct / 100);
            const note = Math.abs (pct) + '% ' + (pct < 0 ? 'below' : 'above') + ' your reference ' + ref;
            return finish ({ kind: 'price', base, market, venue, field, op: pct < 0 ? 'below' : 'above', value: Number (value.toPrecision (8)), note }, 'once');
        }
    }
    // <coin> 5% 4h  |  <coin> +5% 1h  |  <coin> -3% 15m
    if (rest.length >= 3) {
        const pct = parsePct (rest[1]);
        const w = parseWindow (rest[2]);
        if (pct !== undefined && w !== undefined && pct !== 0) {
            const signed = /^[+-]/.test (rest[1]);
            const direction = signed ? (pct > 0 ? 'up' : 'down') : 'both';
            return finish ({ kind: 'move', base, market, venue, pct: Math.abs (pct), windowMin: w, direction }, 'repeat');
        }
    }
    return undefined;
}
