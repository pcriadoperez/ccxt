// Argument adapters.
//
// Renaming a method is not enough when the argument list also moved. pmxt's
// fetchOHLCV takes (outcomeId, resolution, limit, start, end) while CCXT's takes
// (symbol, timeframe, since, limit) — leaving the call untouched would compile
// and then silently fetch the wrong window. These adapters rewrite the argument
// lists the codemod can rewrite safely, and report what a human still has to do.

import { splitArgs, parsePairs } from './util.js';

/** One call site's arguments, however they were written. */
export type ParsedArgs = {
    positional: string[];
    named: Record<string, string>;
    /** contents of a single trailing/leading object literal, if there was one */
    object: Record<string, string>;
};

export type Adapted = {
    /** rewritten argument list, already joined */
    text: string;
    /** things the adapter could not carry across */
    notes: string[];
};

export type Lang = 'ts' | 'py';

const NIL: Record<Lang, string> = { 'ts': 'undefined', 'py': 'None' };

export function parseArgs (argText: string, lang: Lang): ParsedArgs {
    const positional: string[] = [];
    const named: Record<string, string> = {};
    let object: Record<string, string> = {};
    for (const piece of splitArgs (argText)) {
        if (lang === 'py') {
            const eq = piece.indexOf ('=');
            const key = (eq > 0) ? piece.slice (0, eq).trim () : '';
            if (/^[A-Za-z_]\w*$/.test (key)) {
                named[key] = piece.slice (eq + 1).trim ();
                continue;
            }
        }
        if (piece.startsWith ('{')) {
            object = parsePairs (piece.slice (1, piece.length - 1), ':');
            continue;
        }
        positional.push (piece);
    }
    return { positional, named, object };
}

/** Read an argument by keyword name first, then by pmxt's positional slot. */
function pick (args: ParsedArgs, names: string[], index: number): string | undefined {
    for (const name of names) {
        if (name in args.named) {
            return args.named[name];
        }
        if (name in args.object) {
            return args.object[name];
        }
    }
    return args.positional[index];
}

/** Drop trailing nils so `fetchOHLCV (s, '1h')` doesn't become `fetchOHLCV (s, '1h', undefined, undefined)`. */
function trim (parts: (string | undefined)[], nil: string): string[] {
    const out = parts.map ((p) => p ?? nil);
    while (out.length && out[out.length - 1] === nil) {
        out.pop ();
    }
    return out;
}

type Adapter = (args: ParsedArgs, nil: string) => Adapted;

const ADAPTERS: Record<string, Adapter> = {

    // pmxt: fetchMarkets({ query, limit, offset, sort, slug })
    // ccxt: loadMarkets(reload?)
    'fetchMarkets': (args, nil) => {
        const dropped = Object.keys (args.object).concat (Object.keys (args.named));
        return {
            'text': '',
            'notes': dropped.length
                ? [ 'loadMarkets() takes no filters, so ' + dropped.map ((k) => '`' + k + '`').join (', ') + ' was dropped — filter the returned map yourself.' ]
                : [],
        };
    },

    'fetchMarketsPaginated': (args, nil) => ADAPTERS['fetchMarkets'] (args, nil),

    // pmxt: fetchOHLCV(outcomeId, resolution, limit, start, end)
    // ccxt: fetchOHLCV(symbol, timeframe, since, limit, params)
    'fetchOHLCV': (args, nil) => {
        const symbol = pick (args, [ 'outcomeId', 'outcome_id' ], 0);
        const timeframe = pick (args, [ 'resolution' ], 1);
        const limit = pick (args, [ 'limit' ], 2);
        const start = pick (args, [ 'start' ], 3);
        const end = pick (args, [ 'end' ], 4);
        const notes: string[] = [];
        let since: string | undefined = undefined;
        if (start !== undefined) {
            since = start;
            notes.push ('`start` became CCXT\'s `since` (3rd argument). CCXT wants a millisecond integer, not a Date — wrap it in `.getTime()` / `int(dt.timestamp() * 1000)` if it is a date object.');
        }
        if (end !== undefined) {
            notes.push ('`end` has no positional slot in CCXT. Most exchanges accept it as `params.until` (milliseconds) — check your exchange page.');
        }
        return { 'text': trim ([ symbol, timeframe ?? "'1m'", since, limit ], nil).join (', '), notes };
    },

    // pmxt: fetchTrades(outcomeId, { limit })
    // ccxt: fetchTrades(symbol, since, limit, params)
    'fetchTrades': (args, nil) => {
        const symbol = pick (args, [ 'outcomeId', 'outcome_id' ], 0);
        const limit = pick (args, [ 'limit' ], 1);
        return { 'text': trim ([ symbol, undefined, limit ], nil).join (', '), 'notes': [] };
    },

    // pmxt: fetchOpenOrders(marketId) / fetchClosedOrders(params) / fetchAllOrders(params) / fetchMyTrades(params)
    // ccxt: (symbol, since, limit, params)
    'fetchOpenOrders': ordersAdapter,
    'fetchClosedOrders': ordersAdapter,
    'fetchAllOrders': ordersAdapter,
    'fetchMyTrades': ordersAdapter,

    // pmxt: fetchBalance(address) / fetchPositions(address)
    // ccxt: fetchBalance(params) / fetchPositions(symbols, params)
    'fetchBalance': (args, nil) => balanceAdapter (args, nil, 'fetchBalance'),
    'fetchPositions': (args, nil) => balanceAdapter (args, nil, 'fetchPositions'),
};

function ordersAdapter (args: ParsedArgs, nil: string): Adapted {
    const symbol = pick (args, [ 'marketId', 'market_id', 'outcomeId', 'outcome_id' ], 0);
    const since = pick (args, [ 'since', 'start' ], -1);
    const limit = pick (args, [ 'limit' ], -1);
    const notes: string[] = [];
    const known = [ 'marketId', 'market_id', 'outcomeId', 'outcome_id', 'since', 'start', 'limit' ];
    const leftover = Object.keys (args.object).concat (Object.keys (args.named)).filter ((k) => known.indexOf (k) === -1);
    if (leftover.length) {
        notes.push ('dropped pmxt-only option(s) ' + leftover.map ((k) => '`' + k + '`').join (', ') + ' — pass exchange-specific options in CCXT\'s trailing `params` object instead.');
    }
    return { 'text': trim ([ symbol, since, limit ], nil).join (', '), notes };
}

function balanceAdapter (args: ParsedArgs, nil: string, method: string): Adapted {
    const address = pick (args, [ 'address' ], 0);
    const notes: string[] = [];
    if (address !== undefined) {
        notes.push ('`' + method + '()` takes no address in CCXT — the credentials on the exchange instance identify the account. Removed `' + address + '`.');
    }
    return { 'text': '', notes };
}

/**
 * Rewrite one call's argument list, or return null when this method needs no
 * argument surgery (the caller then leaves the arguments alone).
 */
export function adaptArgs (camelMethod: string, argText: string, lang: Lang): Adapted | null {
    const adapter = ADAPTERS[camelMethod];
    if (adapter === undefined) {
        return null;
    }
    const parsed = parseArgs (argText, lang);
    const result = adapter (parsed, NIL[lang]);
    if (result.text === argText.trim ()) {
        return { 'text': result.text, 'notes': result.notes };
    }
    return result;
}
