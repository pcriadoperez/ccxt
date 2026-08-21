import ccxt, { BadSymbol, InsufficientFunds } from 'ccxt';
// TODO(ccxt-migrate): CCXT has no integration for these pmxt venues — kept on pmxtjs for now.
import { Polymarket } from 'pmxtjs';

// TODO(ccxt-migrate): CCXT `hyperliquid` is a different product surface than pmxt `Hyperliquid`. CCXT covers Hyperliquid spot + perpetuals. pmxt covers its prediction markets — re-point symbols at the perp/spot market you actually want.
// TODO(ccxt-migrate): dropped constructor option `pmxtApiKey`. CCXT talks to the venue directly — there is no CCXT-hosted API to authenticate against, so this key has no counterpart.
const venue = new ccxt.hyperliquid ({ 'walletAddress': process.env.WALLET_ADDRESS, 'privateKey': process.env.PRIVATE_KEY });

// TODO(ccxt-migrate): pmxt venue `Polymarket` has no CCXT exchange. Prediction market. No CCXT integration. Pick a CCXT exchange for this workload or keep pmxt for this venue.
const poly = new Polymarket({ pmxtApiKey: process.env.PMXT_API_KEY });

async function main () {
    // TODO(ccxt-migrate): signature changed: fetchMarkets(params) -> loadMarkets(). pmxt returns a filtered array; CCXT returns a dict keyed by symbol and takes no query/sort/limit filters. Filter the loaded `exchange.markets` map yourself.
    // TODO(ccxt-migrate): loadMarkets() takes no filters, so `limit`, `sort` was dropped — filter the returned map yourself.
    const markets = await venue.loadMarkets();
    const outcomeId = markets[0].outcomes[0].outcomeId;

    // TODO(ccxt-migrate): signature changed: fetchOrderBook(outcomeId, limit, params) -> fetchOrderBook(symbol, limit, params). First argument becomes a unified symbol. CCXT levels are [price, amount] arrays, not {price, size} objects.
    const book = await venue.fetchOrderBook(outcomeId);
    console.log("best bid", book.bids[0].price, "best ask", book.asks[0].price);

    // TODO(ccxt-migrate): signature changed: fetchOHLCV(outcomeId, resolution, limit, start, end) -> fetchOHLCV(symbol, timeframe, since, limit, params). Argument order changes (since comes before limit) and CCXT returns [timestamp, open, high, low, close, volume] arrays, not PriceCandle objects.
    const candles = await venue.fetchOHLCV(outcomeId, "1h", undefined, 100);
    console.log("last close", candles[candles.length - 1].close);

    // TODO(ccxt-migrate): signature changed: fetchBalance(address) -> fetchBalance(params). CCXT returns a dict keyed by currency code with free/used/total, not a list of Balance objects. There is no address argument — credentials identify the account.
    const balances = await venue.fetchBalance();
    console.log(balances);

    try {
        // TODO(ccxt-migrate): signature changed: createOrder({marketId, outcomeId, side, type, amount, price}) -> createOrder(symbol, type, side, amount, price, params). Object argument becomes positional arguments, and the order of type/side is swapped relative to how pmxt reads.
        // TODO(ccxt-migrate): createOrder now takes positional arguments. The first one must be a unified CCXT symbol (e.g. 'BTC/USDT') — outcomeId is a pmxt id.
        const order = await venue.createOrder(outcomeId, "limit", "buy", 5, 0.42);
        // TODO(ccxt-migrate): signature changed: cancelOrder(orderId) -> cancelOrder(id, symbol, params). Most CCXT exchanges require the symbol as the second argument.
        await venue.cancelOrder(order.id);
    } catch (e) {
        if (e instanceof BadSymbol) {
            console.error("unknown market");
        } else if (e instanceof InsufficientFunds) {
            console.error("top up");
        }
    }

    // TODO(ccxt-migrate): `fetchArbitrage()` has no CCXT equivalent. pmxt router feature. No CCXT equivalent — see the arbitrage examples in the CCXT manual.
    const edge = await venue.fetchArbitrage({ minSpread: 0.02 });
    console.log(edge);

    await venue.close();
}

main();
