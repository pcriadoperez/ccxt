// Change detectors with confirmation rules from the spec. Pure logic: callers persist baselines.

export interface ListingChange {
    venue: string;
    symbol: string;
    change: 'added' | 'removed';
}

interface ListingBaseline {
    confirmed: string[];
    pendingAdd: Record<string, number>; // symbol -> consecutive sightings
    pendingRemove: Record<string, number>; // symbol -> consecutive absences
}

// A new market must appear in ADD_CONFIRMATIONS consecutive snapshots; a removal needs REMOVE_CONFIRMATIONS,
// and a snapshot that shrinks by more than PARTIAL_DROP is treated as a partial API response and ignored.
export const ADD_CONFIRMATIONS = 2;
export const REMOVE_CONFIRMATIONS = 3;
export const PARTIAL_DROP = 0.05;

export class ListingTracker {
    private baselines = new Map<string, ListingBaseline> ();

    constructor (initial: Record<string, ListingBaseline> = {}) {
        for (const [ venue, b ] of Object.entries (initial)) {
            this.baselines.set (venue, b);
        }
    }

    snapshot (): Record<string, ListingBaseline> {
        return Object.fromEntries (this.baselines);
    }

    hasBaseline (venue: string): boolean {
        return this.baselines.has (venue);
    }

    // `active` = symbols currently listed and active on the venue.
    observe (venue: string, active: string[]): ListingChange[] {
        const current = new Set (active);
        const b = this.baselines.get (venue);
        if (!b) {
            this.baselines.set (venue, { confirmed: [ ...current ].sort (), pendingAdd: {}, pendingRemove: {} });
            return []; // the first snapshot only sets the baseline
        }
        const confirmed = new Set (b.confirmed);
        if (current.size < confirmed.size * (1 - PARTIAL_DROP)) {
            return []; // looks like a partial response: ignore the whole snapshot
        }
        const changes: ListingChange[] = [];
        const pendingAdd: Record<string, number> = {};
        for (const s of current) {
            if (!confirmed.has (s)) {
                const seen = (b.pendingAdd[s] || 0) + 1;
                if (seen >= ADD_CONFIRMATIONS) {
                    confirmed.add (s);
                    changes.push ({ venue, symbol: s, change: 'added' });
                } else {
                    pendingAdd[s] = seen;
                }
            }
        }
        const pendingRemove: Record<string, number> = {};
        for (const s of [ ...confirmed ]) {
            if (!current.has (s)) {
                const missed = (b.pendingRemove[s] || 0) + 1;
                if (missed >= REMOVE_CONFIRMATIONS) {
                    confirmed.delete (s);
                    changes.push ({ venue, symbol: s, change: 'removed' });
                } else {
                    pendingRemove[s] = missed;
                }
            }
        }
        this.baselines.set (venue, { confirmed: [ ...confirmed ].sort (), pendingAdd, pendingRemove });
        return changes;
    }
}

export interface WalletChange {
    venue: string;
    code: string;
    network: string;
    field: 'deposit' | 'withdraw';
    from: boolean;
    to: boolean;
}

type WalletSnapshot = Record<string, Record<string, { deposit?: boolean, withdraw?: boolean }>>; // code -> network -> flags

interface WalletBaseline {
    confirmed: WalletSnapshot;
    pending: Record<string, number>; // "code|network|field|value" -> sightings
}

export const WALLET_CONFIRMATIONS = 2;

export class WalletTracker {
    private baselines = new Map<string, WalletBaseline> ();

    constructor (initial: Record<string, WalletBaseline> = {}) {
        for (const [ venue, b ] of Object.entries (initial)) {
            this.baselines.set (venue, b);
        }
    }

    snapshot (): Record<string, WalletBaseline> {
        return Object.fromEntries (this.baselines);
    }

    observe (venue: string, snap: WalletSnapshot, trackedCodes?: Set<string>): WalletChange[] {
        const b = this.baselines.get (venue);
        if (!b) {
            this.baselines.set (venue, { confirmed: JSON.parse (JSON.stringify (snap)), pending: {} }); // own copy: never alias the caller's object
            return [];
        }
        const changes: WalletChange[] = [];
        const pending: Record<string, number> = {};
        for (const [ code, nets ] of Object.entries (snap)) {
            if (trackedCodes && !trackedCodes.has (code)) {
                b.confirmed[code] = JSON.parse (JSON.stringify (nets));
                continue;
            }
            const prevNets = b.confirmed[code] || {};
            for (const [ network, flags ] of Object.entries (nets)) {
                const prev = prevNets[network];
                for (const field of [ 'deposit', 'withdraw' ] as const) {
                    const now = flags[field];
                    const before = prev ? prev[field] : undefined;
                    if (now === undefined || before === undefined || now === before) {
                        continue;
                    }
                    const key = code + '|' + network + '|' + field + '|' + now;
                    const seen = (b.pending[key] || 0) + 1;
                    if (seen >= WALLET_CONFIRMATIONS) {
                        changes.push ({ venue, code, network, field, from: before, to: now });
                        prev[field] = now;
                    } else {
                        pending[key] = seen;
                    }
                }
                if (!prev) {
                    prevNets[network] = { ...flags };
                }
            }
            b.confirmed[code] = prevNets;
        }
        b.pending = pending;
        return changes;
    }
}
