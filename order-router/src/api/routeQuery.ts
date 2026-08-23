import { config } from '../config.js';
import { ROUTE_STRATEGIES, type RouteStrategy, type RouteOptions } from '../routing/route.js';
import type { RouteRequest } from '../routing/route.js';
import { DEFAULT_BRIDGES } from '../routing/market.js';

// Every query parameter /route and /stream/route accept. Shared so the two endpoints cannot drift
// apart: the streaming endpoint previously did its own ad-hoc parsing and skipped amount
// validation entirely, which let `amount=abc` become NaN and walk every level of every book
// forever. One parser, one set of rules.
export interface RouteQuery {
    from?: string;
    to?: string;
    amountIn?: string;
    amountOut?: string;
    bridges?: string;
    strategy?: string;
    maxVenues?: string;
    includeFees?: string;
    minLegNotional?: string;
    exchanges?: string;
    certified?: string;
    maxStalenessMs?: string;
    requireFullFill?: string;
    stalenessPenaltyBps?: string;
    hopPenaltyBps?: string;
    includeQuotes?: string;
}

export type ParsedRoute = { ok: true; req: RouteRequest; opts: RouteOptions }
    | { ok: false; error: string };

// Fastify turns a repeated query parameter into an array: ?from=A&from=B arrives as ['A','B'].
// Every read below assumes a string, so an array reached .trim()/.split() and threw — surfacing as
// a 500 that leaked the internal message on REST, and an abnormal 1006 close with no error frame on
// the WebSocket. Rejecting is the only safe answer: silently taking one of the two would let a
// duplicated `requireFullFill` or `certified` drop a safety flag without the caller ever knowing.
function rejectRepeated (query: Record<string, unknown>): string | null {
    for (const [name, value] of Object.entries(query)) {
        if (Array.isArray(value)) return `${name} must not be repeated`;
    }
    return null;
}

function num (raw: string | undefined, fallback: number): number | null {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

export function parseRouteQuery (
    query: RouteQuery, requestId: string,
    // The streaming endpoint defaults quotes OFF. Measured on the live service, a single
    // /stream/route socket pushed 658 frames/sec at 9.3KB each — 6.3 MB/s, of which the per-venue
    // quotes array is the overwhelming majority. A once-per-request explanation is cheap; the same
    // explanation ten times a second is not. An explicit includeQuotes= always wins.
    defaults: { includeQuotes?: boolean } = {},
): ParsedRoute {
    const fail = (error: string): ParsedRoute => ({ ok: false, error });

    const repeated = rejectRepeated(query as Record<string, unknown>);
    if (repeated !== null) return fail(repeated);

    const from = (query.from ?? '').trim().toUpperCase();
    const to = (query.to ?? '').trim().toUpperCase();
    if (from.length === 0 || to.length === 0) {
        return fail('from and to query params are required (e.g. from=USDT&to=BTC)');
    }
    if (from === to) return fail('from and to must differ');

    const hasIn = query.amountIn !== undefined;
    const hasOut = query.amountOut !== undefined;
    // Rejecting both is deliberate: silently preferring one would make a caller's typo return a
    // confidently wrong route rather than an error.
    if (hasIn === hasOut) return fail('exactly one of amountIn or amountOut must be supplied');
    const amount = Number(hasIn ? query.amountIn : query.amountOut);
    if (!Number.isFinite(amount) || amount <= 0) {
        return fail(`${hasIn ? 'amountIn' : 'amountOut'} must be a positive finite number`);
    }

    const strategy = (query.strategy ?? 'best_single') as RouteStrategy;
    if (!ROUTE_STRATEGIES.includes(strategy)) {
        return fail(`strategy must be one of: ${ROUTE_STRATEGIES.join(', ')}`);
    }
    const maxVenues = num(query.maxVenues, 3);
    if (maxVenues === null || maxVenues < 1) return fail('maxVenues must be a positive integer');
    const minLegNotional = num(query.minLegNotional, 0);
    if (minLegNotional === null || minLegNotional < 0) {
        return fail('minLegNotional must be zero or a positive number');
    }
    const stalenessPenaltyBps = num(query.stalenessPenaltyBps, 0);
    if (stalenessPenaltyBps === null || stalenessPenaltyBps < 0) {
        return fail('stalenessPenaltyBps must be zero or a positive number');
    }
    // Capped at 10000 because that is a 100% discount — the point at which every extra hop is
    // already disqualified. Anything beyond is not "even more strongly prefer direct", it is the
    // same thing with a number that no longer orders anything.
    const hopPenaltyBps = num(query.hopPenaltyBps, config.hopPenaltyBps);
    if (hopPenaltyBps === null || hopPenaltyBps < 0 || hopPenaltyBps > 10_000) {
        return fail('hopPenaltyBps must be between 0 and 10000');
    }

    // Escape hatch: a caller who would rather have an old price than no price can widen the
    // freshness window. Deliberately opt-in — defaulting loose would hand out prices minutes out
    // of date without the caller ever choosing that risk.
    const maxStalenessMs = num(query.maxStalenessMs, config.staleBookMs);
    if (maxStalenessMs === null || maxStalenessMs <= 0) {
        return fail('maxStalenessMs must be a positive number');
    }

    // An explicitly empty list (`exchanges=`) is treated as "no venues", not "all venues".
    // Silently widening an empty allowlist would be the opposite of what the caller asked.
    let exchanges: Set<string> | undefined;
    if (query.exchanges !== undefined) {
        exchanges = new Set(query.exchanges.split(',').map((e) => e.trim()).filter((e) => e.length > 0));
    }

    // `bridges=` (explicitly empty) disables bridging entirely — direct markets only.
    const bridges = query.bridges === undefined
        ? DEFAULT_BRIDGES
        : query.bridges.split(',').map((b) => b.trim().toUpperCase()).filter((b) => b.length > 0);

    return {
        ok: true,
        req: {
            from, to, bridges,
            amountIn: hasIn ? amount : undefined,
            amountOut: hasOut ? amount : undefined,
        },
        opts: {
            strategy, includeFees: query.includeFees !== 'false', maxVenues, minLegNotional,
            staleBookMs: maxStalenessMs, requestId, exchanges,
            certifiedOnly: query.certified === 'true',
            requireFullFill: query.requireFullFill === 'true',
            includeQuotes: query.includeQuotes === undefined
                ? (defaults.includeQuotes ?? true)
                : query.includeQuotes !== 'false',
            stalenessPenaltyBps, hopPenaltyBps,
        },
    };
}
