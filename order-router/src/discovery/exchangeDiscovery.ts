import ccxt from 'ccxt';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ccxtPro = ccxt.pro as any;

// Every ccxt.pro exchange id whose class actually implements watchOrderBook.
// This is a local, network-free check (`has` is a static describe()-derived
// property on a freshly constructed instance) — safe to run unconditionally.
export function listWatchOrderBookExchanges (exclude: Set<string>): string[] {
    const ids: string[] = [];
    for (const id of Object.keys(ccxtPro)) {
        if (typeof ccxtPro[id] !== 'function' || exclude.has(id)) continue;
        try {
            const instance = new ccxtPro[id]();
            if (instance.has?.watchOrderBook) {
                ids.push(id);
            }
        } catch {
            // Some exported keys aren't exchange classes (e.g. helper namespaces); skip silently.
        }
    }
    return ids;
}
