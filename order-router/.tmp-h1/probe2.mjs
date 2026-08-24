import ccxt from 'ccxt';

function extInfo (c) {
    const conn = c.connection;
    if (!conn) return { none: true };
    const ext = typeof conn.extensions === 'string' ? conn.extensions : String(conn.extensions);
    const pmd = conn._extensions && conn._extensions['permessage-deflate'];
    return {
        extensions: ext,
        negotiated: ext.indexOf('permessage-deflate') !== -1,
        params: pmd ? pmd.params : null,
        pmdOptionPassed: c.options ? c.options.perMessageDeflate : 'unset',
        receiverHasPmd: !!(conn._receiver && conn._receiver._extensions && conn._receiver._extensions['permessage-deflate']),
    };
}

async function probe (id, opts) {
    let ex;
    const out = { id, opts: JSON.stringify(opts) };
    try {
        ex = new ccxt.pro[id]({ enableRateLimit: true, ...opts });
        await ex.loadMarkets();
        const syms = Object.keys(ex.markets).filter((s) => ex.markets[s].spot && ex.markets[s].active).slice(0, 3);
        const p = ex.has.watchOrderBookForSymbols ? ex.watchOrderBookForSymbols(syms) : ex.watchOrderBook(syms[0]);
        await Promise.race([ p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 25000)) ]);
        out.clients = Object.keys(ex.clients).map((u) => ({ url: u.slice(0, 60), ...extInfo(ex.clients[u]) }));
    } catch (e) {
        out.error = String(e && e.message || e).slice(0, 120);
    } finally { try { if (ex) await ex.close(); } catch {} }
    return out;
}

const ids = ['coinbase', 'binance', 'kraken', 'kucoin', 'bitget', 'gate', 'okx', 'bybit', 'poloniex', 'onetrading', 'cex', 'bitmex', 'upbit', 'bitfinex', 'htx', 'lbank', 'deepcoin', 'mexc', 'bitstamp'];
const off = { options: { ws: { options: { perMessageDeflate: false } } } };
const rows = await Promise.all(ids.map((id) => probe(id, {})));
console.log('=== DEFAULT (no pmd option set) ===');
for (const r of rows) console.log(JSON.stringify(r));
console.log('=== WITH perMessageDeflate:false ===');
const rows2 = await Promise.all(['coinbase', 'kucoin', 'poloniex', 'binance'].map((id) => probe(id, off)));
for (const r of rows2) console.log(JSON.stringify(r));
process.exit(0);
