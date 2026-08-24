// Does reconnect churn leak permessage-deflate zlib contexts?
import ccxt from 'ccxt';
const mb = (b) => (b / 1048576).toFixed(2);
const id = process.argv[2] || 'bitstamp';
const cycles = Number(process.argv[3] || 60);
const pmd = process.argv[4] !== 'off';
const opts = { enableRateLimit: true };
if (!pmd) opts.options = { ws: { options: { perMessageDeflate: false } } };
function snap (tag) {
    global.gc(); global.gc();
    const m = process.memoryUsage();
    console.log(`${tag.padEnd(28)} rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}MB ext=${mb(m.external)}MB ab=${mb(m.arrayBuffers)}MB`);
    return m;
}
let base;
for (let i = 0; i < cycles; i++) {
    const ex = new ccxt.pro[id](opts);
    try {
        await ex.loadMarkets();
        const s = Object.keys(ex.markets).filter((x) => ex.markets[x].spot && ex.markets[x].active)[0];
        await Promise.race([ ex.watchOrderBook(s), new Promise((_, r) => setTimeout(() => r(new Error('t')), 15000)) ]);
        const u = Object.keys(ex.clients)[0];
        if (i === 0) console.log(`negotiated extensions: "${ex.clients[u].connection.extensions}"`);
    } catch (e) { /* churn anyway */ }
    try { await ex.close(); } catch {}
    if (i === 4) base = snap(`after 5 cycles (baseline)`);
    if (i > 4 && (i + 1) % 15 === 0) {
        const m = snap(`after ${i + 1} cycles`);
        console.log(`   delta since baseline: rss ${mb(m.rss - base.rss)}MB  ext ${mb(m.external - base.external)}MB  -> per extra cycle ${((m.rss - base.rss) / (i - 4) / 1024).toFixed(1)} KB`);
    }
}
process.exit(0);
