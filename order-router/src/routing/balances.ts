import type { ResolvedHop } from './market.js';

// What the caller actually holds, split by whether they said WHERE it sits. A venue-qualified
// entry funds only that venue's legs: you cannot sell BTC on kraken because your BTC is on
// binance, and a per-asset-only model would keep emitting five-venue splits the caller cannot
// execute — worse than not constraining at all, because it looks like it was checked.
export interface BalanceBook {
    byVenue: Map<string, Map<string, number>>;
    // Holdings the caller did NOT pin to a venue — "I have not told you where it sits" — so they
    // are spendable wherever the walk lands.
    anyVenue: Map<string, number>;
    // Canonical form of the parsed input, key-sorted. Echoed to the caller so they can confirm the
    // constraint reached a server that understands it, and hashed for the audit trail — where the
    // same portfolio must produce the same hash however the caller happened to order the entries.
    normalized: string;
    entryCount: number;
}

export type ParsedBalances = { ok: true; book: BalanceBook } | { ok: false; error: string };

// `[<exchangeId>.]<ASSET>:<amount>`. Both names are restricted to characters that exclude the dot,
// so the single separator between them is never ambiguous — no ccxt exchange id contains a dot and
// no unified asset code does either, and guessing which dot was the separator is not a thing to do
// with someone's wallet.
const ENTRY = /^(?:([A-Za-z0-9_-]+)\.)?([A-Za-z0-9_-]+):(.+)$/;

// Bounds, not tuning knobs, and both REJECT rather than truncate. A silently dropped entry is a
// route the caller cannot fund, which is the exact failure this whole feature exists to prevent.
const MAX_ENTRIES = 64;
const MAX_CHARS = 4096;

// Per-venue spending capacity for ONE hop, denominated in the asset that hop spends. Mutable by
// design: the greedy walk draws it down level by level, which is why every allocate() pass is
// handed its own clone — candidate paths and strategy passes are alternative plans for the same
// money, not successive spends of it.
export interface HopBudgets {
    perVenue: Map<string, number>;
    // The unpinned pool, drawn down globally rather than per venue: it is one pile of money the
    // caller can send anywhere, not a copy of itself at every venue.
    shared: number;
    // Whether the amounts above are base or quote units. Carried here rather than passed alongside
    // because the denomination flip is the single easiest thing to get backwards, and a budget in
    // the wrong units never binds and never errors.
    spendIsBase: boolean;
}

// `balances=` (explicitly empty) parses to a book that holds NOTHING, which is a real answer and
// not the same as the parameter being absent — the same polarity `exchanges=` and `bridges=` use.
export function parseBalancesParam (raw: string): ParsedBalances {
    if (raw.length > MAX_CHARS) return { ok: false, error: `balances must not exceed ${MAX_CHARS} characters` };
    const entries = raw.split(',').map((e) => e.trim()).filter((e) => e.length > 0);
    if (entries.length > MAX_ENTRIES) return { ok: false, error: `balances must not exceed ${MAX_ENTRIES} entries` };

    const byVenue = new Map<string, Map<string, number>>();
    const anyVenue = new Map<string, number>();
    const canonical: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
        const match = ENTRY.exec(entry);
        if (match === null) {
            return { ok: false, error: `balances entry "${entry}" must be [exchange.]ASSET:amount` };
        }
        // Venue ids are trimmed but NOT case-folded, exactly like `exchanges=`: both are matched
        // against the ccxt id on a cached book, and having one of the two silently accept a
        // capitalised id would be a worse inconsistency than neither doing so.
        const venue = match[1];
        const asset = match[2]!.toUpperCase();
        const amount = Number(match[3]);
        // Zero is allowed and meaningful ("I hold none of this here"); negative and NaN are not,
        // and a negative budget would silently disable a venue rather than cap it.
        if (!Number.isFinite(amount) || amount < 0) {
            return { ok: false, error: `balances entry "${entry}" must be [exchange.]ASSET:amount` };
        }
        const key = venue === undefined ? asset : `${venue}.${asset}`;
        // Last-wins would be a silent footgun: the caller sees their first figure ignored with
        // nothing in the response to say so.
        if (seen.has(key)) return { ok: false, error: `balances contains duplicate key ${key}` };
        seen.add(key);
        canonical.push(`${key}:${amount}`);
        if (venue === undefined) {
            anyVenue.set(asset, amount);
        } else {
            let holdings = byVenue.get(venue);
            if (holdings === undefined) { holdings = new Map(); byVenue.set(venue, holdings); }
            holdings.set(asset, amount);
        }
    }
    return {
        ok: true,
        book: {
            byVenue, anyVenue, entryCount: entries.length,
            normalized: canonical.sort().join(','),
        },
    };
}

// Total spendable in `asset` anywhere. Where it sits is a per-hop question; how much of it exists
// is a whole-route one, which is what the source clamp needs. Infinity when unconstrained, so the
// caller's `Math.min` reads the same with and without a wallet.
export function capFor (book: BalanceBook | null, asset: string): number {
    if (book === null) return Infinity;
    let total = book.anyVenue.get(asset) ?? 0;
    for (const holdings of book.byVenue.values()) total += holdings.get(asset) ?? 0;
    return total;
}

// The asset a hop SPENDS: the base when selling it, the quote when buying with it. The mirror of
// route.ts's inputIsBase, kept here because the budget denomination is what actually depends on it.
export function hopSpendAsset (hop: ResolvedHop): string {
    return hop.side === 'sell' ? hop.base : hop.quote;
}

export function budgetsForHop (book: BalanceBook | null, hop: ResolvedHop): HopBudgets | null {
    if (book === null) return null;
    const asset = hopSpendAsset(hop);
    const perVenue = new Map<string, number>();
    for (const [venue, holdings] of book.byVenue) {
        const amount = holdings.get(asset);
        if (amount !== undefined) perVenue.set(venue, amount);
    }
    return { perVenue, shared: book.anyVenue.get(asset) ?? 0, spendIsBase: hop.side === 'sell' };
}

// Mandatory at every allocate() call site. A shared mutable budget does not crash — it quietly
// starves whichever pass runs last, and the symptom is a worse route with nothing to point at.
export function cloneBudgets (budgets: HopBudgets | null): HopBudgets | null {
    if (budgets === null) return null;
    return { perVenue: new Map(budgets.perVenue), shared: budgets.shared, spendIsBase: budgets.spendIsBase };
}

// What this venue could still spend: its own pinned holdings plus whatever is left of the pool.
export function budgetFor (budgets: HopBudgets, venueId: string): number {
    return (budgets.perVenue.get(venueId) ?? 0) + budgets.shared;
}

// Draws `spend` down, pinned holdings first. The pool is the only capacity any OTHER venue could
// still draw on, so spending it ahead of a venue's own money starves them for nothing.
export function drawBudget (budgets: HopBudgets, venueId: string, spend: number): void {
    const pinned = budgets.perVenue.get(venueId) ?? 0;
    const fromPinned = Math.min(spend, pinned);
    budgets.perVenue.set(venueId, pinned - fromPinned);
    budgets.shared = Math.max(0, budgets.shared - (spend - fromPinned));
}
