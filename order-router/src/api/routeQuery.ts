import { config } from '../config.js';
import { ROUTE_STRATEGIES, type RouteStrategy, type RouteOptions } from '../routing/route.js';
import type { RouteRequest } from '../routing/route.js';
import { DEFAULT_BRIDGES } from '../routing/market.js';
import { parseBalancesParam, type BalanceBook } from '../routing/balances.js';

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
    requireFullFill?: string;
    hopPenaltyBps?: string;
    includeQuotes?: string;
    balances?: string;
    balanceMode?: string;
}

// Caps for the two caller-supplied lists, matching the shape `balances` uses. Generous enough that
// no real caller meets them: there are ~76 exchanges, and a bridge list beyond a handful of assets
// is a search-space explosion rather than a query.
const MAX_LIST_CHARS = 1024;
const MAX_LIST_ENTRIES = 128;

function listTooBig (name: string, raw: string): string | undefined {
    if (raw.length > MAX_LIST_CHARS) return `${name} must not exceed ${MAX_LIST_CHARS} characters`;
    const count = raw.split(',').filter((e) => e.trim().length > 0).length;
    if (count > MAX_LIST_ENTRIES) return `${name} must not exceed ${MAX_LIST_ENTRIES} entries`;
    return undefined;
}

// Refusing balances on a socket is honest; silently pricing holdings the caller traded away half an
// hour ago is not. A stream is held open for minutes and there is no message channel on it to
// update them — /stream/route registers no socket.on('message') — so there is no version of this
// that stays true.
export const STREAM_BALANCES_UNSUPPORTED =
    'balances is not supported on /stream/route: a stream would keep pricing a portfolio that may '
    + 'already have been traded away, and there is no channel to update it. Use GET /route.';

export type ParsedRoute = { ok: true; req: RouteRequest; opts: RouteOptions }
    | { ok: false; error: string };

// Fastify turns a repeated query parameter into an array: ?from=A&from=B arrives as ['A','B'].
// Every read below assumes a string, so an array reached .trim()/.split() and threw — surfacing as
// a 500 that leaked the internal message on REST, and an abnormal 1006 close with no error frame on
// the WebSocket. Rejecting is the only safe answer: silently taking one of the two would let a
// duplicated `requireFullFill` or `certified` drop a safety flag without the caller ever knowing.
// The fields whose grammar is numeric, and so may arrive as a JSON number on POST /route. Every
// other field is a string, an enum or a "true"/"false" flag, where a number cannot mean anything.
const NUMERIC_FIELDS = new Set([ 'amountIn', 'amountOut', 'maxVenues', 'minLegNotional', 'hopPenaltyBps' ]);

function rejectRepeated (query: Record<string, unknown>): string | null {
    for (const [name, value] of Object.entries(query)) {
        if (Array.isArray(value)) return `${name} must not be repeated`;
        // Every read below assumes a string, which the query string guarantees and a JSON body does
        // not: POST /route binds its body straight to this parser, so `{"from": 1234}` reached
        // .trim() and surfaced as a 500 whose body was the internal TypeError — a caller mistake
        // answered with an internal error.
        //
        // A JSON NUMBER is legitimate for the fields whose grammar is numeric — the OpenAPI schema
        // declares amountIn/amountOut that way and callers send them so. Everywhere else a number
        // is refused rather than coerced, because coercion is silently wrong on exactly the fields
        // that matter: `{"certified": 1}` would become "1", which is not "true", so the flag would
        // read as unset while the caller believes they set it. Booleans are refused for the mirror
        // reason: `{"requireFullFill": true}` stringifies to "true" and WOULD arm the flag, so
        // accepting it teaches an idiom that fails silently on its neighbour.
        if (value === undefined || value === null || typeof value === 'string') continue;
        if (typeof value === 'number' && NUMERIC_FIELDS.has(name)) {
            if (!Number.isFinite(value)) return `${name} must be a finite number`;
            continue;
        }
        return `${name} must be a string, got ${typeof value}`;
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
    defaults: { includeQuotes?: boolean; rejectBalances?: boolean } = {},
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
    // Capped at 10000 because that is a 100% discount — the point at which every extra hop is
    // already disqualified. Anything beyond is not "even more strongly prefer direct", it is the
    // same thing with a number that no longer orders anything.
    const hopPenaltyBps = num(query.hopPenaltyBps, config.hopPenaltyBps);
    if (hopPenaltyBps === null || hopPenaltyBps < 0 || hopPenaltyBps > 10_000) {
        return fail('hopPenaltyBps must be between 0 and 10000');
    }

    // Parsed after the amounts so a request malformed on BOTH is rejected on the amount — the
    // cheaper thing to fix, and the one that makes the portfolio moot.
    let balances: BalanceBook | null = null;
    if (query.balances !== undefined) {
        if (defaults.rejectBalances === true) return fail(STREAM_BALANCES_UNSUPPORTED);
        const parsed = parseBalancesParam(query.balances);
        if (!parsed.ok) return fail(parsed.error);
        balances = parsed.book;
    }
    // An enum rather than a boolean, deliberately: the existing flags split into opt-out
    // (includeFees, includeQuotes) and opt-in (certified, requireFullFill), so a third polarity
    // would be a coin flip for anyone reading a query string. Naming both modes settles it.
    // Refused wherever balances are, rather than validated and then dropped: on its own the mode
    // says what to do about holdings the endpoint will not accept, so honouring it is impossible
    // and accepting it silently tells the caller their instruction landed.
    if (query.balanceMode !== undefined && defaults.rejectBalances === true) {
        return fail(STREAM_BALANCES_UNSUPPORTED);
    }
    const balanceMode = query.balanceMode ?? 'cap';
    if (balanceMode !== 'cap' && balanceMode !== 'require') return fail('balanceMode must be cap or require');

    // Freshness is NOT a caller parameter. Deciding whether a book is too old to price is the
    // router's judgment, not something to outsource to someone who cannot see the update rates it
    // is judging against — and a millisecond number is the wrong shape for that question anyway.
    // Both values are still echoed in the response, so a caller can always see what was applied.

    // An explicitly empty list (`exchanges=`) is treated as "no venues", not "all venues".
    // Silently widening an empty allowlist would be the opposite of what the caller asked.
    //
    // Both lists are bounded the way `balances` already is, and for the same reason: they are
    // caller-controlled, they are echoed verbatim into the audit record, and `bridges` is re-walked
    // on every push of a stream that can live for minutes. Nothing capped either one, so a single
    // request could pin a megabyte of caller-chosen text into every audit line it produced and make
    // each streamed update proportional to it. Rejected rather than truncated: silently routing
    // against a different list than the one asked for is the failure mode this file exists to
    // avoid. The caps are far above any real request — there are ~76 exchanges and a handful of
    // sensible bridge assets.
    let exchanges: Set<string> | undefined;
    if (query.exchanges !== undefined) {
        const bad = listTooBig('exchanges', query.exchanges);
        if (bad !== undefined) return fail(bad);
        exchanges = new Set(query.exchanges.split(',').map((e) => e.trim()).filter((e) => e.length > 0));
    }

    // `bridges=` (explicitly empty) disables bridging entirely — direct markets only.
    if (query.bridges !== undefined) {
        const bad = listTooBig('bridges', query.bridges);
        if (bad !== undefined) return fail(bad);
    }
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
            staleBookMs: config.staleBookMs, requestId, exchanges,
            certifiedOnly: query.certified === 'true',
            requireFullFill: query.requireFullFill === 'true',
            includeQuotes: query.includeQuotes === undefined
                ? (defaults.includeQuotes ?? true)
                : query.includeQuotes !== 'false',
            stalenessPenaltyBps: config.stalenessPenaltyBps, hopPenaltyBps,
            balances, balanceMode,
        },
    };
}
