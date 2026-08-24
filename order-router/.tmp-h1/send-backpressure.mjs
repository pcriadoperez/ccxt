import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const self = fileURLToPath(import.meta.url);
const mb = (b) => (b / 1048576).toFixed(0);
if (process.env.H1_CHILD) {
    const ccxt = (await import('ccxt')).default;
    const ex = new ccxt.pro.coinbase({ enableRateLimit: true });
    await ex.loadMarkets();
    const syms = Object.keys(ex.markets).filter((s) => ex.markets[s].spot && ex.markets[s].active).slice(0, 25);
    const normalize = (lv) => lv.filter((l) => l[0] !== undefined && l[1] !== undefined).map(([p, a]) => ({ price: p, amount: a }));
    let books = 0, sendTrue = 0, sendFalse = 0, bytes = 0;
    setInterval(() => {
        global.gc(); global.gc();
        const m = process.memoryUsage();
        // report over stdout, NOT the saturated IPC channel
        console.log(JSON.stringify({ rss: mb(m.rss), heap: mb(m.heapUsed), ext: mb(m.external), books, sendTrue, sendFalse, estMBserialized: (bytes / 1048576).toFixed(0) }));
    }, 15000);
    while (true) {
        try {
            const ob = await ex.watchOrderBookForSymbols(syms);
            books++;
            const book = { exchangeId: 'coinbase', symbol: ob.symbol, bids: normalize(ob.bids), asks: normalize(ob.asks), receivedAt: Date.now(), sequence: books };
            bytes += (book.bids.length + book.asks.length) * 40;
            const ok = process.send({ type: 'book', book });
            if (ok) sendTrue++; else sendFalse++;
        } catch (e) { await new Promise((r) => setTimeout(r, 500)); }
    }
} else {
    const child = fork(self, [], { execArgv: ['--expose-gc', '--max-old-space-size=1024'], env: { ...process.env, H1_CHILD: '1' }, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let received = 0;
    child.on('message', () => { received++; });
    setInterval(() => console.log(`PARENT received=${received} rss=${mb(process.memoryUsage().rss)}MB`), 15000);
    child.on('error', () => {});
    setTimeout(() => { child.kill(); process.exit(0); }, 150000);
}
