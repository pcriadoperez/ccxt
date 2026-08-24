// H2 test: does event-loop saturation (ELU 1.0, as measured on shard-0/2) cause undrained
// socket/frame buffers to accumulate as native (external/arrayBuffers) memory, and does that
// memory return to the OS once the backlog drains + GC runs?
import fs from 'node:fs';
import ccxt from 'ccxt';

const EX = (process.env.EX || 'coinbase').split(',');
const NSYM = Number(process.env.NSYM || 10);
const BLOCK_MS = Number(process.env.BLOCK_MS || 800);   // ms of synchronous blocking per cycle
const YIELD_MS = Number(process.env.YIELD_MS || 60);    // ms allowed to drain per cycle
const STALL_S  = Number(process.env.STALL_S || 120);
const MB = 1024 * 1024;

function brk () {
    try {
        const s = fs.readFileSync('/proc/self/smaps', 'utf8');
        let size = 0, rss = 0;
        for (const b of s.split(/\n(?=[0-9a-f]+-[0-9a-f]+ )/)) {
            if (!b.includes('[heap]')) continue;
            size += Number(/^Size:\s+(\d+) kB/m.exec(b)?.[1] || 0);
            rss  += Number(/^Rss:\s+(\d+) kB/m.exec(b)?.[1] || 0);
        }
        return { size: size / 1024, rss: rss / 1024 };
    } catch { return { size: NaN, rss: NaN }; }
}
let msgs = 0;
const rows = [];
function rec (t) {
    const m = process.memoryUsage(); const h = brk();
    const r = { t, rss: +(m.rss/MB).toFixed(0), heapUsed: +(m.heapUsed/MB).toFixed(0),
        external: +(m.external/MB).toFixed(0), arrayBuffers: +(m.arrayBuffers/MB).toFixed(0),
        brkSize: +h.size.toFixed(0), brkRss: +h.rss.toFixed(0), msgs };
    rows.push(r); console.log(JSON.stringify(r)); return r;
}
function spin (ms) { const e = Date.now() + ms; let x = 0; while (Date.now() < e) { x += Math.sqrt(x + 1); } return x; }

const insts = [];
async function main () {
    console.log('# mmapThreshold=' + (process.env.MALLOC_MMAP_THRESHOLD_ || 'default') + ' arenaMax=' + (process.env.MALLOC_ARENA_MAX || 'default') + ' block=' + BLOCK_MS + '/' + YIELD_MS + 'ms');
    rec('boot');
    for (const id of EX) {
        const ex = new ccxt.pro[id]({ enableRateLimit: true });
        insts.push(ex);
        await ex.loadMarkets();
        const syms = Object.keys(ex.markets).filter((s) => ex.markets[s].active && ex.markets[s].spot).slice(0, NSYM);
        console.log('# ' + id + ' n=' + syms.length);
        void (async () => { for (;;) { try {
            const ob = ex.has.watchOrderBookForSymbols ? await ex.watchOrderBookForSymbols(syms) : await ex.watchOrderBook(syms[0]);
            msgs++; void ob;
        } catch (e) { console.log('# err ' + id + ' ' + String(e.message).slice(0,90)); await new Promise(r=>setTimeout(r,500)); } } })();
    }
    await new Promise((r) => setTimeout(r, 20000));
    rec('warm');
    // ---- PHASE 1: saturate the event loop, starving socket drain ----
    const end = Date.now() + STALL_S * 1000; let i = 0;
    while (Date.now() < end) {
        spin(BLOCK_MS);
        await new Promise((r) => setTimeout(r, YIELD_MS));
        if (++i % 10 === 0) rec('stall+' + Math.round((Date.now() - (end - STALL_S*1000))/1000) + 's');
    }
    rec('stall-end');
    // ---- PHASE 2: release the loop, let everything drain ----
    for (let k = 0; k < 6; k++) { await new Promise((r) => setTimeout(r, 5000)); rec('drain+' + (k+1)*5 + 's'); }
    // ---- PHASE 3: close + GC ----
    for (const ex of insts) { try { await ex.close(); } catch {} }
    await new Promise((r) => setTimeout(r, 3000)); rec('closed');
    for (let k = 0; k < 8; k++) { global.gc?.(); await new Promise((r) => setTimeout(r, 500)); }
    rec('after-gc');
    await new Promise((r) => setTimeout(r, 10000)); rec('final');
    console.table(rows);
    process.exit(0);
}
main();
