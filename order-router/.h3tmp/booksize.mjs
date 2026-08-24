import ccxt from 'ccxt';
import v8 from 'node:v8';
const ex = new ccxt.pro.coinbase({ enableRateLimit: true });
await ex.loadMarkets();
const symbols = Object.keys(ex.markets).filter(s => s.endsWith('/USD')).slice(0, 10);
let snapBytes = 0, snapMsgs = 0, updBytes = 0, updMsgs = 0, maxLevels = 0;
const orig = ex.handleMessage.bind(ex);
ex.handleMessage = (c, m) => {
  const s = JSON.stringify(m).length;
  const t = m?.channel;
  const ev = m?.events?.[0];
  const n = (ev?.updates?.length) ?? 0;
  if (n > maxLevels) maxLevels = n;
  if (ev?.type === 'snapshot') { snapBytes += s; snapMsgs++; } else { updBytes += s; updMsgs++; }
  return orig(c, m);
};
void (async () => { for (;;) { try { await ex.watchOrderBookForSymbols(symbols); } catch (e) {} } })();
await new Promise(r => setTimeout(r, 25000));
console.log(`snapshot msgs=${snapMsgs} totalJSON=${(snapBytes/1048576).toFixed(2)}MB  avg=${(snapBytes/Math.max(1,snapMsgs)/1024).toFixed(0)}KB`);
console.log(`update msgs=${updMsgs} totalJSON=${(updBytes/1048576).toFixed(2)}MB avg=${(updBytes/Math.max(1,updMsgs)).toFixed(0)}B`);
console.log('max levels in one message:', maxLevels);
// per-book level counts + retained size
let totLevels = 0;
for (const s of Object.keys(ex.orderbooks)) {
  const ob = ex.orderbooks[s];
  totLevels += ob.bids.length + ob.asks.length;
  console.log(s, 'bids', ob.bids.length, 'asks', ob.asks.length, 'indexFloat64 bids', ob.bids.index.length, 'asks', ob.asks.index.length);
}
console.log('total levels retained across', Object.keys(ex.orderbooks).length, 'books =', totLevels);
global.gc?.();
const m = process.memoryUsage();
console.log('mem after gc', JSON.stringify(Object.fromEntries(Object.entries(m).map(([k,v])=>[k,(v/1048576).toFixed(1)+'MB']))));
// measure heap cost of the books precisely: serialize sizes
const heap = v8.getHeapStatistics();
console.log('heap used', (heap.used_heap_size/1048576).toFixed(1)+'MB', 'external', (heap.external_memory/1048576).toFixed(1)+'MB');
process.exit(0);
