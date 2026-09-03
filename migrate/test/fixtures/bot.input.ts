import { Hyperliquid, Polymarket, MarketNotFound, InsufficientFunds } from "pmxtjs";

const venue = new Hyperliquid({
    pmxtApiKey: process.env.PMXT_API_KEY,
    walletAddress: process.env.WALLET_ADDRESS,
    privateKey: process.env.PRIVATE_KEY,
});

const poly = new Polymarket({ pmxtApiKey: process.env.PMXT_API_KEY });

async function main () {
    const markets = await venue.fetchMarkets({ limit: 10, sort: "volume" });
    const outcomeId = markets[0].outcomes[0].outcomeId;

    const book = await venue.fetchOrderBook(outcomeId);
    console.log("best bid", book.bids[0].price, "best ask", book.asks[0].price);

    const candles = await venue.fetchOHLCV(outcomeId, "1h", 100);
    console.log("last close", candles[candles.length - 1].close);

    const balances = await venue.fetchBalance();
    console.log(balances);

    try {
        const order = await venue.createOrder({
            marketId: markets[0].marketId,
            outcomeId: outcomeId,
            side: "buy",
            type: "limit",
            amount: 5,
            price: 0.42,
        });
        await venue.cancelOrder(order.id);
    } catch (e) {
        if (e instanceof MarketNotFound) {
            console.error("unknown market");
        } else if (e instanceof InsufficientFunds) {
            console.error("top up");
        }
    }

    const edge = await venue.fetchArbitrage({ minSpread: 0.02 });
    console.log(edge);

    await venue.close();
}

main();
