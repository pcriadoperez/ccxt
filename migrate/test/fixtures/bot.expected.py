import ccxt.prediction

# TODO(ccxt-migrate): mapped to `ccxt.prediction.hyperliquid`, which is async-only — every call needs await and the surrounding function needs to be async. pmxt addresses Hyperliquid prediction markets, so ccxt.prediction.hyperliquid is the like-for-like target. Use the top-level ccxt.hyperliquid only if you actually want its spot/perp markets.
# TODO(ccxt-migrate): dropped constructor option `pmxt_api_key`. CCXT talks to the venue directly — there is no CCXT-hosted API to authenticate against, so this key has no counterpart.
venue = ccxt.prediction.hyperliquid ({
    'walletAddress': "0xYourWalletAddress",
    'privateKey': "0xYourPrivateKey",
})

# TODO(ccxt-migrate): mapped to `ccxt.prediction.kalshi`, which is async-only — every call needs await and the surrounding function needs to be async. Direct match: ccxt.prediction.kalshi.
kalshi = ccxt.prediction.kalshi ()


def main():
    # TODO(ccxt-migrate): signature changed: fetchMarkets(params) -> loadMarkets(). pmxt returns a filtered array; CCXT returns a dict keyed by symbol and takes no query/sort/limit filters. Filter the loaded `exchange.markets` map yourself.
    # TODO(ccxt-migrate): loadMarkets() takes no filters, so `query`, `limit` was dropped — filter the returned map yourself.
    markets = venue.load_markets()
    outcome_id = markets[0].outcomes[0].outcome_id

    # TODO(ccxt-migrate): signature changed: fetchOrderBook(outcomeId, limit, params) -> fetchOrderBook(symbol, limit, params). First argument becomes the CCXT outcome handle (an outcome id is also accepted). CCXT levels are [price, amount] arrays, not {price, size} objects.
    book = venue.fetch_order_book(outcome_id)
    print("best bid", book.bids[0].price, "best ask", book.asks[0].price)

    # TODO(ccxt-migrate): signature changed: fetchOHLCV(outcomeId, resolution, limit, start, end) -> fetchOHLCV(outcome, timeframe, since, limit, params). Argument order changes (since comes before limit) and CCXT returns [timestamp, open, high, low, close, volume] arrays, not PriceCandle objects.
    candles = venue.fetch_ohlcv(outcome_id, "1h", None, 100)
    print("last close", candles[-1].close)

    # TODO(ccxt-migrate): signature changed: fetchBalance(address) -> fetchBalance(params). CCXT returns a dict keyed by currency code with free/used/total, not a list of Balance objects. There is no address argument — credentials identify the account.
    balances = venue.fetch_balance()
    print(balances)

    try:
        # TODO(ccxt-migrate): signature changed: createOrder({marketId, outcomeId, side, type, amount, price}) -> createOrder(outcome, type, side, amount, price, params). Object argument becomes positional arguments and type/side swap order. On prediction venues `amount` is a number of shares and `price` stays a 0..1 probability, so the numbers carry over unchanged.
        # TODO(ccxt-migrate): create_order now takes positional arguments. The first one must be a unified CCXT symbol (e.g. 'BTC/USDT') — outcome_id is a pmxt id.
        order = venue.create_order(outcome_id, "limit", "buy", 5, 0.42)
        # TODO(ccxt-migrate): signature changed: cancelOrder(orderId) -> cancelOrder(id, symbol, params). Most CCXT exchanges require the symbol as the second argument.
        venue.cancel_order(order.id)
    except ccxt.BadSymbol:
        print("unknown market")
    except ccxt.InsufficientFunds:
        print("top up")

    # TODO(ccxt-migrate): signature changed: fetchAllOrders(params) -> fetchOrders(symbol, since, limit, params). Renamed, and the options object becomes positional arguments.
    orders = venue.fetch_orders(markets[0].market_id, None, 50)
    print(orders)

    venue.close()


main()
