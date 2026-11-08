// The rule schema: the single contract shared by shorthand commands, buttons, presets and the AI.

import { z } from 'zod';
import { fmtPct, fmtPrice, fmtFundingRate, venueName } from './format.js';

export const MarketKind = z.enum ([ 'spot', 'perp' ]);
export type MarketKind = z.infer<typeof MarketKind>;

const base = z.string ().min (1).max (20).transform ((s) => s.toUpperCase ());
const venues = z.array (z.string ().min (2).max (20)).max (20).default ([]);

export const PriceSpec = z.object ({
    kind: z.literal ('price'),
    base,
    quote: z.string ().optional (),
    market: MarketKind.default ('spot'),
    venue: z.string ().default ('median'), // exchange id or 'median'
    field: z.enum ([ 'last', 'mark' ]).default ('last'),
    op: z.enum ([ 'above', 'below' ]),
    value: z.number ().positive (),
    note: z.string ().max (120).optional (),
});

export const MoveSpec = z.object ({
    kind: z.literal ('move'),
    base,
    market: MarketKind.default ('spot'),
    venue: z.string ().default ('median'),
    pct: z.number ().positive ().max (100), // percent, e.g. 5 means 5%
    windowMin: z.number ().int ().min (5).max (1440),
    direction: z.enum ([ 'up', 'down', 'both' ]).default ('both'),
});

export const FundingSpec = z.object ({
    kind: z.literal ('funding'),
    base: z.string ().default ('*').transform ((s) => s.toUpperCase ()), // '*' = top perps
    venues,
    high: z.number ().nullable ().default (0.001), // 8h-equivalent rate as a fraction (0.001 = 0.1%)
    low: z.number ().nullable ().default (-0.0005),
});

export const FundingGapSpec = z.object ({
    kind: z.literal ('fundinggap'),
    base,
    venues,
    aprGap: z.number ().positive ().default (0.2), // annualized gap as a fraction (0.2 = 20% APR)
});

export const SettleSpec = z.object ({
    kind: z.literal ('settle'),
    base,
    venues,
    minutesBefore: z.number ().int ().min (1).max (120).default (15),
});

export const OpenInterestSpec = z.object ({
    kind: z.literal ('oi'),
    base,
    venues,
    pct: z.number ().positive ().max (100).default (8),
    windowMin: z.number ().int ().min (10).max (1440).default (60),
});

export const ListingSpec = z.object ({
    kind: z.literal ('listing'),
    venues,
    markets: z.array (MarketKind).default ([ 'spot', 'perp' ]),
    removals: z.boolean ().default (true),
    bases: z.array (z.string ()).default ([]), // optional filter: only these coins
});

export const WalletSpec = z.object ({
    kind: z.literal ('wallet'),
    code: base,
    venues,
});

export const StatusSpec = z.object ({
    kind: z.literal ('status'),
    venues,
});

export const DepegSpec = z.object ({
    kind: z.literal ('depeg'),
    codes: z.array (z.string ()).default ([ 'USDT', 'USDC' ]),
    threshold: z.number ().positive ().max (0.2).default (0.005),
});

export const BreakingTypes = z.enum ([ 'listing', 'status', 'macro', 'exploit', 'bigmove' ]);
export type BreakingType = z.infer<typeof BreakingTypes>;

export const BreakingSpec = z.object ({
    kind: z.literal ('breaking'),
    types: z.array (BreakingTypes).min (1),
});

export const RuleSpec = z.discriminatedUnion ('kind', [
    PriceSpec, MoveSpec, FundingSpec, FundingGapSpec, SettleSpec, OpenInterestSpec,
    ListingSpec, WalletSpec, StatusSpec, DepegSpec, BreakingSpec,
]);
export type RuleSpec = z.infer<typeof RuleSpec>;
export type RuleKind = RuleSpec['kind'];

export interface Rule {
    id: string;
    chatId: number;
    spec: RuleSpec;
    mode: 'once' | 'repeat';
    cooldownS: number;
    expiresAt: number | null;
    paused: boolean;
    breakQuiet: boolean;
    source: 'shorthand' | 'button' | 'preset' | 'ai';
    createdAt: number;
}

// Defaults per rule kind: cooldown, delivery priority and time-to-live (spec "Delivery and noise" table).
export const KIND_DEFAULTS: Record<RuleKind, { cooldownS: number, priority: 1 | 2 | 3, ttlS: number, mode: 'once' | 'repeat' }> = {
    price: { cooldownS: 0, priority: 1, ttlS: 300, mode: 'once' },
    move: { cooldownS: 3600, priority: 1, ttlS: 300, mode: 'repeat' },
    depeg: { cooldownS: 3600, priority: 1, ttlS: 900, mode: 'repeat' },
    status: { cooldownS: 1800, priority: 1, ttlS: 900, mode: 'repeat' },
    funding: { cooldownS: 4 * 3600, priority: 2, ttlS: 1800, mode: 'repeat' },
    fundinggap: { cooldownS: 4 * 3600, priority: 2, ttlS: 1800, mode: 'repeat' },
    oi: { cooldownS: 2 * 3600, priority: 2, ttlS: 900, mode: 'repeat' },
    listing: { cooldownS: 0, priority: 2, ttlS: 3600, mode: 'repeat' },
    wallet: { cooldownS: 0, priority: 2, ttlS: 3600, mode: 'repeat' },
    breaking: { cooldownS: 0, priority: 2, ttlS: 3600, mode: 'repeat' },
    settle: { cooldownS: 0, priority: 3, ttlS: 600, mode: 'repeat' },
};

export function parseSpec (input: unknown): { ok: true, spec: RuleSpec } | { ok: false, error: string } {
    const result = RuleSpec.safeParse (input);
    if (result.success) {
        if (result.data.kind === 'funding' && result.data.high === null && result.data.low === null) {
            return { ok: false, error: 'A funding rule needs an upper or a lower threshold.' };
        }
        return { ok: true, spec: result.data };
    }
    const issue = result.error.issues[0];
    return { ok: false, error: (issue ? issue.path.join ('.') + ': ' + issue.message : 'invalid rule') };
}

function venueList (v: string[]): string {
    if (v.length === 0) {
        return 'all supported venues';
    }
    return v.map (venueName).join (', ');
}

function windowText (minutes: number): string {
    if (minutes % 60 === 0) {
        const h = minutes / 60;
        return h === 24 ? '24h' : h + 'h';
    }
    return minutes + 'm';
}

// Plain-language description used on confirmation cards and in /list.
export function describeSpec (spec: RuleSpec): string {
    switch (spec.kind) {
        case 'price': {
            const where = spec.venue === 'median' ? 'median of major venues' : venueName (spec.venue);
            const what = spec.market === 'perp' ? spec.base + ' perp' : spec.base;
            const field = spec.field === 'mark' ? ' (mark price)' : '';
            const note = spec.note ? ' · ' + spec.note : '';
            return what + ' ' + (spec.op === 'above' ? 'rises above ' : 'falls below ') + fmtPrice (spec.value) + field + ' · ' + where + note;
        }
        case 'move': {
            const where = spec.venue === 'median' ? 'median of major venues' : venueName (spec.venue);
            const dir = spec.direction === 'both' ? '±' : (spec.direction === 'up' ? '+' : '−');
            return spec.base + ' moves ' + dir + spec.pct + '% within ' + windowText (spec.windowMin) + ' · ' + where;
        }
        case 'funding': {
            const what = spec.base === '*' ? 'Any top perp' : spec.base + ' perp';
            const parts: string[] = [];
            if (spec.high !== null) {
                parts.push ('above ' + fmtFundingRate (spec.high));
            }
            if (spec.low !== null) {
                parts.push ('below ' + fmtFundingRate (spec.low));
            }
            return what + ' funding (8h-equiv.) ' + parts.join (' or ') + ' · ' + venueList (spec.venues);
        }
        case 'fundinggap':
            return spec.base + ' funding gap between venues above ' + fmtPct (spec.aprGap * 100, 0) + ' APR · ' + venueList (spec.venues);
        case 'settle':
            return spec.base + ' funding settlement reminder, ' + spec.minutesBefore + ' min before · ' + venueList (spec.venues);
        case 'oi':
            return spec.base + ' open interest ±' + spec.pct + '% within ' + windowText (spec.windowMin) + ' · ' + venueList (spec.venues);
        case 'listing': {
            const kinds = spec.markets.join (' and ');
            const coins = spec.bases.length ? ' for ' + spec.bases.join (', ') : '';
            return 'New ' + kinds + ' markets' + coins + (spec.removals ? ' (and removals)' : '') + ' · ' + venueList (spec.venues);
        }
        case 'wallet':
            return spec.code + ' deposit/withdrawal status changes · ' + venueList (spec.venues);
        case 'status':
            return 'Exchange outages and recoveries · ' + venueList (spec.venues);
        case 'depeg':
            return spec.codes.join (', ') + ' off the dollar by more than ' + fmtPct (spec.threshold * 100, 1);
        case 'breaking':
            return 'Breaking events: ' + spec.types.join (', ');
    }
}
