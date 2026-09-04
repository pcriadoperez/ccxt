import ccxt from 'ccxt';

// CCXT marks a subset of exchanges "certified" — the ones it actively maintains and tests to a
// higher bar. Read from describe() at module load: it is a static property, so this costs no
// network call and cannot fail at request time.
const certified = new Set<string>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pro = ccxt.pro as any;
for (const id of Object.keys(pro)) {
    if (typeof pro[id] !== 'function') continue;
    try {
        if (new pro[id]().certified) certified.add(id);
    } catch {
        // Not every exported key is a constructible exchange class; skip quietly.
    }
}

export function isCertified (exchangeId: string): boolean {
    return certified.has(exchangeId);
}

export function certifiedExchanges (): string[] {
    return [...certified].sort();
}
