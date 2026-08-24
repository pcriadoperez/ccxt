import ccxt from 'ccxt';

const id = process.argv[2];
const pmd = process.argv[3] === 'on';
const nSym = Number(process.argv[4] || 25);
const durMs = Number(process.argv[5] || 420) * 1000;
const tag = `${id}/pmd=${pmd ? 'ON' : 'OFF'}`;
const mb = (b) => (b / 1048576).toFixed(1);

const opts = { enableRateLimit: true };
if (!pmd) opts.options = { ws: { options: { perMessageDeflate: false } } };
const ex = new ccxt.pro[id](opts);
await ex.loadMarkets();
const syms = Object.keys(ex.markets).filter((s) => ex.markets[s].spot && ex.markets[s].active).slice(0, nSym);

let msgs = 0, wireBytes = 0, levels = 0, books = 0, maxLevels = 0;
let hooked = false;
function hook () {
    if (hooked) return;
    for (const u of Object.keys(ex.clients)) {
        const c = ex.clients[u].connection;
        if (!c || !c._socket) continue;
        c._socket.on('data', (d) => { wireBytes += d.length; });
        c.on('message', () => { msgs++; });
        hooked = true;
        console.log(`[${tag}] hooked ${u.slice(0,50)} ext="${c.extensions}"`);
    }
}

const start = Date.now();
let stop = false;
setTimeout(() => { stop = true; }, durMs);

const loop = (async () => {
    while (!stop) {
        try {
            const ob = await (ex.has.watchOrderBookForSymbols ? ex.watchOrderBookForSymbols(syms) : ex.watchOrderBook(syms[0]));
            hook();
            books++;
            const l = ob.bids.length + ob.asks.length;
            levels += l; if (l > maxLevels) maxLevels = l;
        } catch (e) { await new Promise((r) => setTimeout(r, 500)); }
    }
})();

const samples = [];
const timer = setInterval(() => {
    global.gc(); global.gc();
    const m = process.memoryUsage();
    const t = ((Date.now() - start) / 1000).toFixed(0);
    samples.push(m);
    console.log(`[${tag}] t=${t}s rss=${mb(m.rss)} heap=${mb(m.heapUsed)} ext=${mb(m.external)} ab=${mb(m.arrayBuffers)} | msgs=${msgs} wireMB=${mb(wireBytes)} books=${books} maxLevels=${maxLevels}`);
}, 20000);

await loop;
clearInterval(timer);
global.gc(); global.gc();
const m = process.memoryUsage();
console.log(`[${tag}] FINAL rss=${mb(m.rss)} heap=${mb(m.heapUsed)} ext=${mb(m.external)} ab=${mb(m.arrayBuffers)} msgs=${msgs} wireMB=${mb(wireBytes)} books=${books} avgLevels=${(levels/Math.max(books,1)).toFixed(0)} maxLevels=${maxLevels}`);
process.exit(0);
