import pmxt

venue = pmxt.Hyperliquid(
    pmxt_api_key="pmxt_live_xxx",
    wallet_address="0xYourWalletAddress",
    private_key="0xYourPrivateKey",
)

kalshi = pmxt.Kalshi()


def main():
    markets = venue.fetch_markets(query="BTC", limit=10)
    outcome_id = markets[0].outcomes[0].outcome_id

    book = venue.fetch_order_book(outcome_id)
    print("best bid", book.bids[0].price, "best ask", book.asks[0].price)

    candles = venue.fetch_ohlcv(outcome_id, resolution="1h", limit=100)
    print("last close", candles[-1].close)

    balances = venue.fetch_balance()
    print(balances)

    try:
        order = venue.create_order(
            market_id=markets[0].market_id,
            outcome_id=outcome_id,
            side="buy",
            order_type="limit",
            amount=5,
            price=0.42,
        )
        venue.cancel_order(order.id)
    except pmxt.MarketNotFound:
        print("unknown market")
    except pmxt.InsufficientFunds:
        print("top up")

    orders = venue.fetch_all_orders(market_id=markets[0].market_id, limit=50)
    print(orders)

    venue.close()


main()
