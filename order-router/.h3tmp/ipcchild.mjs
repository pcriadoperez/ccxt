// Emulates shardWorker: relays a full order book over process.send() on every update.
const LEVELS = Number(process.env.LEVELS || 44271);
const RATE   = Number(process.env.RATE || 125);
const mkBook = () => {
  const half = LEVELS >> 1;
  const side = (base) => { const a = new Array(half); for (let i=0;i<half;i++) a[i] = {price: base + i*0.01, amount: 0.12345678 + i*1e-8}; return a; };
  return { exchangeId: 'coinbase', symbol: 'BTC/USD', bids: side(60000), asks: side(70000),
           exchangeTimestamp: Date.now(), receivedAt: Date.now(), sequence: 0 };
};
const book = mkBook();
const bytes = Buffer.byteLength(JSON.stringify({type:'book', book}));
console.error(`[child] one book message = ${(bytes/1048576).toFixed(2)} MB JSON; at ${RATE}/s = ${(bytes*RATE/1048576).toFixed(0)} MB/s`);
let sent = 0, backpressured = 0;
const mb = n => +(n/1048576).toFixed(1);
setInterval(() => {
  const m = process.memoryUsage();
  console.error(JSON.stringify({t: process.uptime().toFixed(0), sent, backpressured,
    rss: mb(m.rss), heap: mb(m.heapUsed), ext: mb(m.external), ab: mb(m.arrayBuffers),
    rss_minus_heap: mb(m.rss - m.heapUsed)}));
}, 5000);
setInterval(() => {
  book.sequence++;
  const ok = process.send({type:'book', book});
  sent++;
  if (ok === false) backpressured++;
}, Math.max(1, Math.round(1000/RATE)));
