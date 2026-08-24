// Isolate which step of the prod connector path allocates the native memory.
// mode: bare | normalize | send  (all with permessage-deflate at ccxt default = ON)
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const self = fileURLToPath(import.meta.url);
const mb = (b) => (b / 1048576).toFixed(0);

if (process.env.H1_CHILD) {
    const ccxt = (await import('ccxt')).default;
    const mode = process.env.H1_MODE;
    const ex = new ccxt.pro.coinbase({ enableRateLimit: true });
    await ex.loadMarkets();
    const syms = Object.keys(ex.markets).filter((s) => ex.markets[s].spot && ex.markets[s].active).slice(0, 25);
    const normalize = (lv) => lv.filter((l) => l[0] !== undefined && l[1] !== undefined).map(([price, amount]) => ({ price, amount }));
    let books = 0;
    let sink = null;
    setInterval(() => {
        global.gc(); global.gc();
        const m = process.memoryUsage();
        process.send({ stat: 1, rss: m.rss, heap: m.heapUsed, ext: m.external, ab: m.arrayBuffers, books });
    }, 20000);
    while (true) {
        try {
            const ob = await ex.watchOrderBookForSymbols(syms);
            books++;
            if (mode === 'bare') continue;
            const book = { exchangeId: 'coinbase', symbol: ob.symbol, bids: normalize(ob.bids), asks: normalize(ob.asks), receivedAt: Date.now(), sequence: books };
            if (mode === 'normalize') { sink = book.bids.length + book.asks.length; continue; }
            if (mode === 'stringify') { sink = JSON.stringify(book).length; continue; }
            process.send({ type: 'book', book });
        } catch (e) { await new Promise((r) => setTimeout(r, 500)); }
    }
} else {
    const mode = process.argv[2], dur = Number(process.argv[3] || 260) * 1000;
    const child = fork(self, [], { execArgv: ['--expose-gc', '--max-old-space-size=1024'], env: { ...process.env, H1_CHILD: '1', H1_MODE: mode }, serialization: 'advanced' });
    const t0 = Date.now();
    child.on('message', (m) => {
        if (m.stat) console.log(`[${mode}] t=${((Date.now()-t0)/1000).toFixed(0)}s rss=${mb(m.rss)}MB heap=${mb(m.heap)}MB ext=${mb(m.ext)}MB ab=${mb(m.ab)}MB books=${m.books}`);
    });
    child.on('error', () => {});
    setTimeout(() => { child.kill(); process.exit(0); }, dur);
}
