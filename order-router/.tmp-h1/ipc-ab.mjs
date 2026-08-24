// Reproduces the REAL prod path: shardWorker child -> normalizeLevels -> process.send(book) -> parent.
// Variant: permessage-deflate ON/OFF. Measures the child's rss/external/arrayBuffers.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const mb = (b) => (b / 1048576).toFixed(1);

if (process.env.H1_CHILD) {
    const ccxt = (await import('ccxt')).default;
    const pmd = process.env.H1_PMD === 'on';
    const opts = { enableRateLimit: true };
    if (!pmd) opts.options = { ws: { options: { perMessageDeflate: false } } };
    const ex = new ccxt.pro[process.env.H1_ID](opts);
    await ex.loadMarkets();
    const syms = Object.keys(ex.markets).filter((s) => ex.markets[s].spot && ex.markets[s].active).slice(0, Number(process.env.H1_N));
    const normalize = (levels) => levels.filter((l) => l[0] !== undefined && l[1] !== undefined).map(([price, amount]) => ({ price, amount }));
    let books = 0, sent = 0;
    setInterval(() => {
        global.gc(); global.gc();
        const m = process.memoryUsage();
        process.send({ stat: true, rss: m.rss, heap: m.heapUsed, ext: m.external, ab: m.arrayBuffers, books, sent, chQ: process.channel && process.channel.writableLength });
    }, 20000).unref?.();
    while (true) {
        try {
            const ob = await (ex.has.watchOrderBookForSymbols ? ex.watchOrderBookForSymbols(syms) : ex.watchOrderBook(syms[0]));
            books++;
            const book = { exchangeId: process.env.H1_ID, symbol: ob.symbol, bids: normalize(ob.bids), asks: normalize(ob.asks), receivedAt: Date.now(), sequence: books };
            process.send({ type: 'book', book });
            sent++;
        } catch (e) { await new Promise((r) => setTimeout(r, 500)); }
    }
} else {
    const id = process.argv[2], pmd = process.argv[3], n = process.argv[4] || '25', dur = Number(process.argv[5] || 420) * 1000;
    const child = fork(self, [], {
        execArgv: ['--expose-gc', '--max-old-space-size=1024'],
        env: { ...process.env, H1_CHILD: '1', H1_PMD: pmd, H1_ID: id, H1_N: n },
    });
    const t0 = Date.now();
    let received = 0;
    child.on('message', (m) => {
        if (m.stat) {
            console.log(`[${id}/pmd=${pmd}] t=${((Date.now()-t0)/1000).toFixed(0)}s CHILD rss=${mb(m.rss)} heap=${mb(m.heap)} ext=${mb(m.ext)} ab=${mb(m.ab)} books=${m.books} sent=${m.sent} recvByParent=${received} channelWritableLength=${m.chQ} | PARENT rss=${mb(process.memoryUsage().rss)}`);
        } else received++;
    });
    setTimeout(() => { child.kill(); process.exit(0); }, dur);
}
