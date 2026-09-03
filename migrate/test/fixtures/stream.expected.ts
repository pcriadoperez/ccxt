import ccxt from 'ccxt';

// TODO(ccxt-migrate): mapped to `ccxt.prediction.hyperliquid`. Same events/markets/outcomes model and 0..1 pricing as pmxt, but verify the outcome handles: pmxt addresses Hyperliquid prediction markets, so ccxt.prediction.hyperliquid is the like-for-like target. Use the top-level ccxt.hyperliquid only if you actually want its spot/perp markets.
// TODO(ccxt-migrate): dropped constructor option `pmxtApiKey`. CCXT talks to the venue directly — there is no CCXT-hosted API to authenticate against, so this key has no counterpart.
const venue = new ccxt.prediction.hyperliquid ();
// TODO(ccxt-migrate): mapped to `ccxt.prediction.polymarket`. Same events/markets/outcomes model and 0..1 pricing as pmxt, but verify the outcome handles: Direct match: ccxt.prediction.polymarket, same events/markets/outcomes model.
const poly = new ccxt.prediction.polymarket ();

async function stream (outcomeId: string) {
    while (true) {
        // TODO(ccxt-migrate): signature changed: watchOrderBook(outcomeId, limit, params) -> watchOrderBook(symbol, limit, params). Same await-in-a-loop pattern. Requires a CCXT Pro instance: `new ccxt.pro.<id>()` in JS/TS, `import ccxt.pro as ccxt` in Python.
        const book = await venue.watchOrderBook(outcomeId);
        console.log(book.bids[0].price, book.asks[0].price);
    }
}

async function stop (outcomeId: string) {
    // TODO(ccxt-migrate): signature changed: unwatchOrderBook(outcomeId) -> unWatchOrderBook(symbol, params). Note the capital W in the CCXT spelling.
    await venue.unWatchOrderBook(outcomeId);
    await venue.close();
}

stream("some-outcome-id");
