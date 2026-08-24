import ccxt from 'ccxt';

const ex = new ccxt.pro.coinbase({ enableRateLimit: true });
await ex.loadMarkets();
const symbols = Object.keys(ex.markets).filter(s => s.endsWith('/USD')).slice(0, 10);
console.log('symbols', symbols.length);

function liveSockets () {
  // count libuv TCP handles
  return process._getActiveHandles().filter(h => h.constructor && /Socket|TLSSocket/.test(h.constructor.name)).length;
}
function clientUrls () { return Object.keys(ex.clients || {}); }

// one batched watch, like the connector does
const loop = async () => { for (;;) { try { await ex.watchOrderBookForSymbols(symbols); } catch (e) { /* connector logs + backs off */ } } };
void loop();

await new Promise(r => setTimeout(r, 6000));
console.log('after connect: sockets=', liveSockets(), 'clients=', clientUrls());

const url = clientUrls()[0];
const client = ex.clients[url];
console.log('connection readyState BEFORE onError:', client.connection.readyState);

// This is EXACTLY what Client.onPingInterval() does on a missed pong,
// and what Exchange.watchMultiple's throttle .catch() does: client.onError(err)
client.onError(new Error('simulated keepalive miss'));

await new Promise(r => setTimeout(r, 500));
console.log('connection readyState AFTER onError:', client.connection.readyState, '(1 = OPEN)');
console.log('still in ex.clients?', clientUrls().includes(url));
console.log('sockets now =', liveSockets());

// the connector loop will now call watchOrderBookForSymbols again -> new client, new socket
await new Promise(r => setTimeout(r, 8000));
console.log('after reconnect: sockets=', liveSockets(), 'clients=', clientUrls().length);
console.log('orphan still OPEN?', client.connection.readyState === 1, 'bytes received on orphan:', client.connection._socket?.bytesRead);
const mem = process.memoryUsage();
console.log('mem', JSON.stringify(mem));
process.exit(0);
