import ccxt from 'ccxt';
const SYMS = ['BTC/USD','ETH/USD','SOL/USD','XRP/USD','DOGE/USD','ADA/USD','AVAX/USD','LINK/USD','DOT/USD','LTC/USD'];
const ex = new ccxt.pro.coinbase({ enableRateLimit: true });
await ex.loadMarkets();
const syms = SYMS.filter(s => ex.markets[s]);
console.log('symbols', syms.length);
let n = 0; const sizes = []; const levels = [];
const t0 = Date.now();
const stop = t0 + 90_000;
function mem(tag){ const m = process.memoryUsage(); console.log(JSON.stringify({tag, t:((Date.now()-t0)/1000)|0, rssMB:+(m.rss/1e6).toFixed(1), heapUsedMB:+(m.heapUsed/1e6).toFixed(1), externalMB:+(m.external/1e6).toFixed(1), arrayBuffersMB:+(m.arrayBuffers/1e6).toFixed(1), updates:n})); }
const iv = setInterval(()=>mem('sample'), 10_000);
try {
  while (Date.now() < stop) {
    const ob = await ex.watchOrderBookForSymbols(syms);
    n++;
    // replicate applyOrderBook + shard IPC serialization exactly
    const book = { exchangeId:'coinbase', symbol: ob.symbol,
      bids: ob.bids.filter(l=>l[0]!==undefined&&l[1]!==undefined).map(([p,a])=>({price:p,amount:a})),
      asks: ob.asks.filter(l=>l[0]!==undefined&&l[1]!==undefined).map(([p,a])=>({price:p,amount:a})),
      exchangeTimestamp: ob.timestamp ?? undefined, receivedAt: Date.now(), sequence: n };
    const s = JSON.stringify({type:'book', book});
    sizes.push(Buffer.byteLength(s));
    levels.push(ob.bids.length + ob.asks.length);
  }
} catch(e){ console.log('ERR', e.message); }
clearInterval(iv);
await ex.close();
sizes.sort((a,b)=>a-b); levels.sort((a,b)=>a-b);
const q=(arr,p)=>arr[Math.min(arr.length-1,Math.floor(arr.length*p))];
const secs=(Date.now()-t0)/1000;
const totalBytes = sizes.reduce((a,b)=>a+b,0);
console.log(JSON.stringify({updates:n, rate:+(n/secs).toFixed(1),
  levels:{min:levels[0],p50:q(levels,.5),p95:q(levels,.95),max:levels[levels.length-1]},
  ipcBytes:{min:sizes[0],p50:q(sizes,.5),p95:q(sizes,.95),max:sizes[sizes.length-1]},
  distinctSizes:new Set(sizes).size,
  ipcThroughputMBps:+((totalBytes/1e6)/secs).toFixed(1)}, null, 2));
mem('final');
