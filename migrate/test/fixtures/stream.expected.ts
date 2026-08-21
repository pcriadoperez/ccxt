import ccxt from 'ccxt';
// TODO(ccxt-migrate): CCXT has no integration for some pmxt venues used here — kept the pmxtjs import for them.
import * as pmxt from 'pmxtjs';

// TODO(ccxt-migrate): CCXT `hyperliquid` is a different product surface than pmxt `Hyperliquid`. CCXT covers Hyperliquid spot + perpetuals. pmxt covers its prediction markets — re-point symbols at the perp/spot market you actually want.
// TODO(ccxt-migrate): dropped constructor option `pmxtApiKey`. CCXT talks to the venue directly — there is no CCXT-hosted API to authenticate against, so this key has no counterpart.
const venue = new ccxt.pro.hyperliquid ();
// TODO(ccxt-migrate): pmxt venue `Polymarket` has no CCXT exchange. Prediction market. No CCXT integration. Pick a CCXT exchange for this workload or keep pmxt for this venue.
const poly = new pmxt.Polymarket({});

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
