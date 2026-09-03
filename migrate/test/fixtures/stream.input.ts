import pmxt from "pmxtjs";

const venue = new pmxt.Hyperliquid({ pmxtApiKey: process.env.PMXT_API_KEY });
const poly = new pmxt.Polymarket({});

async function stream (outcomeId: string) {
    while (true) {
        const book = await venue.watchOrderBook(outcomeId);
        console.log(book.bids[0].price, book.asks[0].price);
    }
}

async function stop (outcomeId: string) {
    await venue.unwatchOrderBook(outcomeId);
    await venue.close();
}

stream("some-outcome-id");
