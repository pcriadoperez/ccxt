import ccxt from 'ccxt';
const ex = new ccxt.pro.coinbase({ enableRateLimit: true });
await ex.loadMarkets();
const symbols = Object.keys(ex.markets).filter(s => s.endsWith('/USD')).slice(0, 10);
const orphans = [];
const seen = new Set();
const socks = () => process._getActiveHandles().filter(h => h.constructor && /Socket|TLSSocket/.test(h.constructor.name)).length;
const mb = n => (n/1048576).toFixed(1);
const snap = (tag) => { const m = process.memoryUsage();
  console.log(`${tag} sockets=${socks()} orphans=${orphans.length} rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}MB ext=${mb(m.external)}MB ab=${mb(m.arrayBuffers)}MB`); };
let msgs = 0, bytes = 0;
const origHandle = ex.handleMessage.bind(ex);
ex.handleMessage = (c, m) => { msgs++; bytes += JSON.stringify(m).length; return origHandle(c, m); };
void (async () => { for (;;) { try { await ex.watchOrderBookForSymbols(symbols); } catch (e) {} } })();
await new Promise(r => setTimeout(r, 8000));
snap('baseline');
const t0 = Date.now(), m0 = msgs, b0 = bytes;
await new Promise(r => setTimeout(r, 10000));
console.log(`traffic on 1 connection: ${((msgs-m0)/((Date.now()-t0)/1000)).toFixed(0)} msg/s, ${mb((bytes-b0)/((Date.now()-t0)/1000))} MB/s JSON`);
for (let i = 0; i < 8; i++) {
  const url = Object.keys(ex.clients)[0];
  const c = ex.clients[url];
  if (!seen.has(c)) { seen.add(c); }
  c.onError(new Error('simulated keepalive miss #' + i));
  orphans.push(c);
  await new Promise(r => setTimeout(r, 9000));
  snap(`after orphan #${i+1}`);
}
await new Promise(r => setTimeout(r, 20000));
snap('final +20s');
console.log('orphan states (1=OPEN):', orphans.map(o => o.connection.readyState).join(','));
console.log('orphan bytesRead MB:', orphans.map(o => mb(o.connection._socket?.bytesRead ?? 0)).join(','));
console.log('distinct client objects seen:', seen.size);
console.log('ex.clients keys:', Object.keys(ex.clients).length, 'orderbooks:', Object.keys(ex.orderbooks||{}).length);
process.exit(0);
