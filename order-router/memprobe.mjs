// Full memory accounting probe for the order-router workload.
// Samples the FULL process.memoryUsage() split (rss/heapTotal/heapUsed/external/arrayBuffers)
// plus, on Linux, the glibc [heap] (brk arena) size from /proc/self/smaps.
import fs from 'node:fs';
import ccxt from 'ccxt';

const EXCHANGES = (process.env.EX || 'coinbase').split(',').filter(Boolean);
const NSYM = Number(process.env.NSYM || 10);
const DUR_MS = Number(process.env.DUR_MS || 300000);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 15000);
const MB = 1024 * 1024;

function linuxHeap () {
    try {
        const s = fs.readFileSync('/proc/self/smaps', 'utf8');
        let heapSize = 0, heapRss = 0, anonTotal = 0;
        const blocks = s.split(/\n(?=[0-9a-f]+-[0-9a-f]+ )/);
        for (const b of blocks) {
            const size = Number(/^Size:\s+(\d+) kB/m.exec(b)?.[1] || 0);
            const rss = Number(/^Rss:\s+(\d+) kB/m.exec(b)?.[1] || 0);
            if (b.includes('[heap]')) { heapSize += size; heapRss += rss; }
            anonTotal += Number(/^Anonymous:\s+(\d+) kB/m.exec(b)?.[1] || 0);
        }
        return { heapSizeMb: heapSize / 1024, heapRssMb: heapRss / 1024, anonMb: anonTotal / 1024 };
    } catch { return { heapSizeMb: NaN, heapRssMb: NaN, anonMb: NaN }; }
}

let msgs = 0, levels = 0, sockets = 0;

function sample (tag) {
    const m = process.memoryUsage();
    const h = linuxHeap();
    return {
        t: tag,
        rss: (m.rss / MB).toFixed(0),
        heapTotal: (m.heapTotal / MB).toFixed(0),
        heapUsed: (m.heapUsed / MB).toFixed(0),
        external: (m.external / MB).toFixed(0),
        arrayBuffers: (m.arrayBuffers / MB).toFixed(0),
        brkHeap: h.heapSizeMb.toFixed(0),
        brkRss: h.heapRssMb.toFixed(0),
        anon: h.anonMb.toFixed(0),
        msgs, levels, sockets,
    };
}

const rows = [];
function record (tag) {
    const r = sample(tag);
    rows.push(r);
    console.log(JSON.stringify(r));
}

const instances = [];

async function run () {
    console.log('# node ' + process.version + ' platform=' + process.platform + ' arenaMax=' + (process.env.MALLOC_ARENA_MAX || 'default') + ' mmapThreshold=' + (process.env.MALLOC_MMAP_THRESHOLD_ || 'default'));
    record('t0-boot');
    for (const id of EXCHANGES) {
        const Cls = ccxt.pro[id];
        if (!Cls) { console.log('# no ' + id); continue; }
        const ex = new Cls({ enableRateLimit: true });
        instances.push(ex);
        await ex.loadMarkets();
        const syms = Object.keys(ex.markets).filter((s) => ex.markets[s].active && ex.markets[s].spot).slice(0, NSYM);
        console.log('# ' + id + ' symbols=' + syms.length + ' batched=' + !!ex.has.watchOrderBookForSymbols);
        const loop = async () => {
            for (;;) {
                try {
                    let ob;
                    if (ex.has.watchOrderBookForSymbols) ob = await ex.watchOrderBookForSymbols(syms);
                    else ob = await ex.watchOrderBook(syms[0]);
                    msgs++;
                    levels = Math.max(levels, (ob.bids?.length || 0) + (ob.asks?.length || 0));
                } catch (e) {
                    console.log('# err ' + id + ': ' + String(e.message).slice(0, 120));
                    await new Promise((r) => setTimeout(r, 1000));
                }
            }
        };
        void loop();
    }
    record('t1-subscribed');

    const start = Date.now();
    while (Date.now() - start < DUR_MS) {
        await new Promise((r) => setTimeout(r, SAMPLE_MS));
        sockets = instances.reduce((n, ex) => n + Object.keys(ex.clients || {}).length, 0);
        record('t+' + Math.round((Date.now() - start) / 1000) + 's');
    }

    // Stop traffic, then GC hard.
    console.log('# closing connections');
    for (const ex of instances) { try { await ex.close(); } catch {} }
    await new Promise((r) => setTimeout(r, 3000));
    record('closed');
    if (global.gc) {
        for (let i = 0; i < 5; i++) { global.gc(); await new Promise((r) => setTimeout(r, 500)); }
        record('after-gc');
    } else {
        console.log('# no --expose-gc');
    }
    // malloc_trim equivalent: nothing in JS. Report final.
    await new Promise((r) => setTimeout(r, 5000));
    record('final');
    console.table(rows);
    process.exit(0);
}
run();
