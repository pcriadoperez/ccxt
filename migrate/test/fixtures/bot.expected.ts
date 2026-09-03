import ccxt, { BadSymbol, InsufficientFunds } from 'ccxt';

// TODO(ccxt-migrate): mapped to `ccxt.prediction.hyperliquid`. Same events/markets/outcomes model and 0..1 pricing as pmxt, but verify the outcome handles: pmxt addresses Hyperliquid prediction markets, so ccxt.prediction.hyperliquid is the like-for-like target. Use the top-level ccxt.hyperliquid only if you actually want its spot/perp markets.
// TODO(ccxt-migrate): dropped constructor option `pmxtApiKey`. CCXT talks to the venue directly — there is no CCXT-hosted API to authenticate against, so this key has no counterpart.
const venue = new ccxt.prediction.hyperliquid ({ 'walletAddress': process.env.WALLET_ADDRESS, 'privateKey': process.env.PRIVATE_KEY });

// TODO(ccxt-migrate): mapped to `ccxt.prediction.polymarket`. Same events/markets/outcomes model and 0..1 pricing as pmxt, but verify the outcome handles: Direct match: ccxt.prediction.polymarket, same events/markets/outcomes model.
// TODO(ccxt-migrate): dropped constructor option `pmxtApiKey`. CCXT talks to the venue directly — there is no CCXT-hosted API to authenticate against, so this key has no counterpart.
const poly = new ccxt.prediction.polymarket ();

async function main () {
    // TODO(ccxt-migrate): signature changed: fetchMarkets(params) -> loadMarkets(). pmxt returns a filtered array; CCXT returns a dict keyed by symbol and takes no query/sort/limit filters. Filter the loaded `exchange.markets` map yourself.
    // TODO(ccxt-migrate): loadMarkets() takes no filters, so `limit`, `sort` was dropped — filter the returned map yourself.
    const markets = await venue.loadMarkets();
    const outcomeId = markets[0].outcomes[0].outcomeId;

    // TODO(ccxt-migrate): signature changed: fetchOrderBook(outcomeId, limit, params) -> fetchOrderBook(symbol, limit, params). First argument becomes the CCXT outcome handle (an outcome id is also accepted). CCXT levels are [price, amount] arrays, not {price, size} objects.
    const book = await venue.fetchOrderBook(outcomeId);
    console.log("best bid", book.bids[0].price, "best ask", book.asks[0].price);

    // TODO(ccxt-migrate): signature changed: fetchOHLCV(outcomeId, resolution, limit, start, end) -> fetchOHLCV(outcome, timeframe, since, limit, params). Argument order changes (since comes before limit) and CCXT returns [timestamp, open, high, low, close, volume] arrays, not PriceCandle objects.
    const candles = await venue.fetchOHLCV(outcomeId, "1h", undefined, 100);
    console.log("last close", candles[candles.length - 1].close);

    // TODO(ccxt-migrate): signature changed: fetchBalance(address) -> fetchBalance(params). CCXT returns a dict keyed by currency code with free/used/total, not a list of Balance objects. There is no address argument — credentials identify the account.
    const balances = await venue.fetchBalance();
    console.log(balances);

    try {
        // TODO(ccxt-migrate): signature changed: createOrder({marketId, outcomeId, side, type, amount, price}) -> createOrder(outcome, type, side, amount, price, params). Object argument becomes positional arguments and type/side swap order. On prediction venues `amount` is a number of shares and `price` stays a 0..1 probability, so the numbers carry over unchanged.
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
