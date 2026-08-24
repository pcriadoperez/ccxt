// @NO_AUTO_TRANSPILE
"use strict";
// ----------------------------------------------------------------------------
// Swarm orders
//
// A "swarm" fragments a parent order into N clips of randomised size and fires
// them in parallel, as fast as possible. Unlike a TWAP it does not spread the
// order over time - it trades time-risk for impact-risk, and sits at the
// opposite end of the spectrum. The point is to reduce the visible footprint of
// a single large market order, not to track a benchmark.
//
// No exchange offers "swarm" as a native order type - it is purely a
// client-side fragmentation technique, which is why it lives in examples/
// rather than in the library. Contrast with:
//   - iceberg: ONE resting order with a hidden reserve, managed exchange-side
//   - twap:    a schedule the exchange owns, see examples/ts/twap-order.ts
// ----------------------------------------------------------------------------
import ccxt from '../../js/ccxt.js';
const DRY_RUN = true; // flip to false only against an account you are happy to trade
function credentials() {
    const apiKey = process.env.APIKEY;
    const secret = process.env.SECRET;
    if ((apiKey === undefined) || (secret === undefined)) {
        return {}; // public access is enough to plan and inspect
    }
    return { 'apiKey': apiKey, 'secret': secret };
}
// pure: split `amount` into `clips` pieces, each within +/- `randomness` of the
// even split, respecting the exchange's amount precision. Deterministic input ->
// inspectable output, so you can eyeball the clips before sending anything.
function planSwarmClips(exchange, symbol, amount, clips, randomness) {
    const even = amount / clips;
    const raw = [];
    let total = 0;
    for (let i = 0; i < clips; i++) {
        // uniform in [1 - randomness, 1 + randomness]
        const jitter = 1 + ((Math.random() * 2 - 1) * randomness);
        const size = even * jitter;
        raw.push(size);
        total += size;
    }
    // rescale so the clips sum back to the requested amount, then round each to
    // the exchange's precision
    const plan = [];
    let allocated = 0;
    for (let i = 0; i < raw.length; i++) {
        // the last clip absorbs the rounding remainder so the clips sum back to
        // the parent exactly, instead of leaving a sliver unexecuted
        const isLast = (i === raw.length - 1);
        const scaled = isLast ? (amount - allocated) : (raw[i] * (amount / total));
        const size = parseFloat(exchange.amountToPrecision(symbol, scaled));
        allocated += size;
        plan.push(size);
    }
    return plan;
}
async function main() {
    // credentials are only needed once DRY_RUN is off, so the planning half of
    // this example runs against public data with no keys at all
    const exchange = new ccxt.binance(credentials());
    await exchange.loadMarkets();
    const symbol = 'BTC/USDT';
    const amount = 0.4;
    const clips = 5;
    const randomness = 0.35; // +/- 35% around the even split
    const market = exchange.market(symbol);
    const plan = planSwarmClips(exchange, symbol, amount, clips, randomness);
    console.log('clips:', plan, 'sum:', plan.reduce((a, b) => a + b, 0));
    // every clip must clear the exchange minimum on its own, otherwise the swarm
    // silently degrades into fewer, larger orders
    const minAmount = market['limits']['amount']['min'];
    for (let i = 0; i < plan.length; i++) {
        if (plan[i] < minAmount) {
            console.log('clip', i, 'is below the exchange minimum', minAmount, '- use fewer clips');
            return;
        }
    }
    // a slippage guard belongs here: price the whole parent against the current
    // book and refuse if the expected impact is worse than your limit. Firing N
    // market orders in parallel means you cannot cancel your way out.
    const orderbook = await exchange.fetchOrderBook(symbol);
    const bestAsk = orderbook['asks'][0][0];
    console.log('best ask', bestAsk, '- price your impact against the full book before sending');
    if (DRY_RUN) {
        return;
    }
    // in parallel, as fast as possible - that is the whole idea. Note that this
    // is also the part with no undo: rate limits, partial rejects and a moving
    // book all land at once, so keep the parent small enough that a total fill
    // at the worst clip price is still acceptable to you.
    const promises = [];
    for (let i = 0; i < plan.length; i++) {
        promises.push(exchange.createOrder(symbol, 'market', 'buy', plan[i]));
    }
    const results = await Promise.allSettled(promises);
    let filled = 0;
    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled') {
            filled += result.value['filled'];
        }
        else {
            // a rejected clip leaves the parent partially executed - reconcile,
            // do not blindly retry
            console.log('clip', i, 'rejected:', result.reason.message);
        }
    }
    console.log('filled', filled, 'of', amount);
}
main();
