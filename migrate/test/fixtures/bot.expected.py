import ccxt
# TODO(ccxt-migrate): CCXT has no integration for some pmxt venues used here — kept the pmxt import for them.
import pmxt

# TODO(ccxt-migrate): CCXT `hyperliquid` is a different product surface than pmxt `Hyperliquid`. CCXT covers Hyperliquid spot + perpetuals. pmxt covers its prediction markets — re-point symbols at the perp/spot market you actually want.
# TODO(ccxt-migrate): dropped constructor option `pmxt_api_key`. CCXT talks to the venue directly — there is no CCXT-hosted API to authenticate against, so this key has no counterpart.
venue = ccxt.hyperliquid ({
    'walletAddress': "0xYourWalletAddress",
    'privateKey': "0xYourPrivateKey",
})

# TODO(ccxt-migrate): pmxt venue `Kalshi` has no CCXT exchange. Prediction market. No CCXT integration. Pick a CCXT exchange for this workload or keep pmxt for this venue.
kalshi = pmxt.Kalshi()


def main():
    # TODO(ccxt-migrate): signature changed: fetchMarkets(params) -> loadMarkets(). pmxt returns a filtered array; CCXT returns a dict keyed by symbol and takes no query/sort/limit filters. Filter the loaded `exchange.markets` map yourself.
    # TODO(ccxt-migrate): loadMarkets() takes no filters, so `query`, `limit` was dropped — filter the returned map yourself.
    markets = venue.load_markets()
    outcome_id = markets[0].outcomes[0].outcome_id

    # TODO(ccxt-migrate): signature changed: fetchOrderBook(outcomeId, limit, params) -> fetchOrderBook(symbol, limit, params). First argument becomes a unified symbol. CCXT levels are [price, amount] arrays, not {price, size} objects.
    book = venue.fetch_order_book(outcome_id)
    print("best bid", book.bids[0].price, "best ask", book.asks[0].price)

    # TODO(ccxt-migrate): signature changed: fetchOHLCV(outcomeId, resolution, limit, start, end) -> fetchOHLCV(symbol, timeframe, since, limit, params). Argument order changes (since comes before limit) and CCXT returns [timestamp, open, high, low, close, volume] arrays, not PriceCandle objects.
    candles = venue.fetch_ohlcv(outcome_id, "1h", None, 100)
    print("last close", candles[-1].close)

    # TODO(ccxt-migrate): signature changed: fetchBalance(address) -> fetchBalance(params). CCXT returns a dict keyed by currency code with free/used/total, not a list of Balance objects. There is no address argument — credentials identify the account.
    balances = venue.fetch_balance()
    print(balances)

    try:
        # TODO(ccxt-migrate): signature changed: createOrder({marketId, outcomeId, side, type, amount, price}) -> createOrder(symbol, type, side, amount, price, params). Object argument becomes positional arguments, and the order of type/side is swapped relative to how pmxt reads.
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
