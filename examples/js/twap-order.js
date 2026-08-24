// @NO_AUTO_TRANSPILE
"use strict";
// ----------------------------------------------------------------------------
// TWAP orders
//
// A TWAP (Time-Weighted Average Price) order is a parent order the exchange
// slices into child orders and works over a fixed duration, so the fill price
// tracks the time-weighted average price of the market over that window.
//
// createTwapOrder () is a wrapper around the exchange's NATIVE TWAP engine. The
// schedule lives on the exchange, so it survives your process dying. CCXT does
// not emulate TWAP client-side - when has['createTwapOrder'] is not true, the
// method throws NotSupported. The second half of this file shows what a
// client-side fallback looks like, and why owning that loop is your problem
// rather than the library's.
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
async function nativeTwap() {
    // credentials are only needed once DRY_RUN is off, so the planning half of
    // this example runs against public data with no keys at all
    const exchange = new ccxt.binance(credentials());
    await exchange.loadMarkets();
    const symbol = 'BTC/USDT';
    if (!exchange.has['createTwapOrder']) {
        console.log(exchange.id, 'has no native TWAP');
        return;
    }
    // features answers per market type - binance supports TWAP on spot and
    // linear contracts, but not on inverse ones
    console.log('twap supported for', symbol, exchange.featureValue(symbol, 'createOrder', 'twap'));
    if (DRY_RUN) {
        return;
    }
    // work a 0.5 BTC buy over 4 hours, never paying more than 60000
    const duration = 4 * 60 * 60 * 1000; // milliseconds, as everywhere in ccxt
    const parent = await exchange.createTwapOrder(symbol, 'buy', 0.5, duration, {
        'price': 60000,
    });
    console.log('placed', parent['id'], parent['clientOrderId'], parent['status']);
    // running algo orders live in a separate namespace, reach them with params.twap,
    // exactly like params.trigger reaches conditional orders
    const running = await exchange.fetchOpenOrders(symbol, undefined, undefined, { 'twap': true });
    for (let i = 0; i < running.length; i++) {
        const order = running[i];
        console.log(order['id'], order['side'], order['filled'], '/', order['amount'], 'avg', order['average']);
    }
    // binance's create response only carries clientAlgoId, so read the algoId back
    // from the open orders before canceling
    if (running.length) {
        await exchange.cancelOrder(running[0]['id'], symbol, { 'twap': true });
    }
}
// ----------------------------------------------------------------------------
// Client-side fallback for exchanges without a native TWAP.
//
// Read this as a sketch, not a production executor. What is missing here is
// exactly what makes the native version worth preferring:
//
//   - no persistence: if this process dies at slice 7 of 20 you are left with an
//     untracked partial position and no record of what you intended
//   - no idempotency: a restart cannot tell a resent slice from a new one
//   - no reconciliation: partial fills on a slice are not fed back into the plan
//   - no circuit breaker: it keeps buying into a 5% rally, by design
//
// Anything you actually run should own all four.
// ----------------------------------------------------------------------------
function planTwapSlices(exchange, symbol, amount, duration, slices) {
    // pure: works out the schedule without touching the network, so it can be
    // inspected and tested before a single order is sent
    const now = exchange.milliseconds();
    const interval = Math.floor(duration / slices);
    const perSlice = exchange.amountToPrecision(symbol, amount / slices);
    const plan = [];
    // accumulate as strings: subtracting floats here loses the last digit of
    // precision and quietly under-fills the parent by a tick
    let allocated = '0';
    for (let i = 0; i < slices; i++) {
        // rounding each slice down loses a little of the parent, so the last one
        // absorbs the remainder
        const isLast = (i === slices - 1);
        const remainder = ccxt.Precise.stringSub(exchange.numberToString(amount), allocated);
        const sizeString = isLast ? exchange.amountToPrecision(symbol, remainder) : perSlice;
        allocated = ccxt.Precise.stringAdd(allocated, sizeString);
        const size = parseFloat(sizeString);
        plan.push({
            'timestamp': now + (i * interval),
            'amount': size,
        });
    }
    return plan;
}
async function emulatedTwap() {
    const exchange = new ccxt.kraken(credentials());
    await exchange.loadMarkets();
    const symbol = 'BTC/USD';
    const amount = 0.05;
    const duration = 30 * 60 * 1000; // 30 minutes
    const slices = 6;
    const plan = planTwapSlices(exchange, symbol, amount, duration, slices);
    console.log('plan:', plan);
    if (DRY_RUN) {
        return; // inspect the schedule first, always
    }
    const market = exchange.market(symbol);
    let filled = 0;
    for (let i = 0; i < plan.length; i++) {
        const slice = plan[i];
        const wait = slice['timestamp'] - exchange.milliseconds();
        if (wait > 0) {
            await exchange.sleep(wait);
        }
        // a real implementation would check the book here and refuse to trade
        // through a slippage limit, then journal the intent before sending
        if (slice['amount'] < market['limits']['amount']['min']) {
            console.log('slice below the exchange minimum, skipping');
            continue;
        }
        const child = await exchange.createOrder(symbol, 'market', 'buy', slice['amount']);
        filled += child['filled'];
        console.log('slice', i + 1, 'of', plan.length, 'filled', child['filled'], 'total', filled);
    }
}
async function main() {
    await nativeTwap();
    await emulatedTwap();
}
main();
