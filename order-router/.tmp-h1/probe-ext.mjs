import ccxt from 'ccxt';

const ids = process.argv.slice(2);
const results = [];

async function probe (id) {
    let ex;
    try {
        ex = new ccxt.pro[id]({ enableRateLimit: true });
        await ex.loadMarkets();
        const syms = Object.keys(ex.markets).filter((s) => ex.markets[s].spot && ex.markets[s].active).slice(0, 3);
        if (!syms.length) throw new Error('no spot symbols');
        const p = ex.has.watchOrderBookForSymbols
            ? ex.watchOrderBookForSymbols(syms)
            : ex.watchOrderBook(syms[0]);
        await Promise.race([ p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 25000)) ]);
        const urls = Object.keys(ex.clients);
        for (const u of urls) {
            const c = ex.clients[u];
            const conn = c.connection;
            const ext = conn && conn.extensions ? Object.keys(conn.extensions) : [];
            const pmd = conn && conn._extensions && conn._extensions['permessage-deflate'];
            results.push({
                id, url: u,
                extensions: ext,
                negotiated: ext.indexOf('permessage-deflate') !== -1,
                params: pmd ? pmd.params : null,
                clientOptions: c.options ? Object.keys(c.options) : null,
                pmdOptionSet: c.options ? c.options.perMessageDeflate : 'unset',
                gunzip: c.gunzip, inflate: c.inflate,
            });
        }
    } catch (e) {
        results.push({ id, error: String(e && e.message || e) });
    } finally {
        try { if (ex) await ex.close(); } catch {}
    }
}

await Promise.all(ids.map(probe));
console.log(JSON.stringify(results, null, 1));
process.exit(0);
