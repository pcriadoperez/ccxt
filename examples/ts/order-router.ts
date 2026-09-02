// @NO_AUTO_TRANSPILE

// OrderRouter — ask the router how to convert one asset into another.
//
// The router holds live L2 books from many venues and answers "what is the
// cheapest way to turn X into Y right now, and on which venues" — book-walked
// to your actual size, fee-adjusted, and split across venues when that beats
// any single one.
//
// This example is READ-ONLY: it asks for a recommendation and prints it. It
// never places an order. Execution lives behind router.execute(plan, venues),
// which defaults to dry_run and refuses to trade unless explicitly told to.
//
// Usage:
//   ORDER_ROUTER_API_KEY=or_live_... npm run tsBuild && node js/examples/ts/order-router.js
//
// Get a key from https://docs.ccxt.com/router

import ccxt from '../../js/ccxt.js';

async function main () {
    const apiKey = process.env.ORDER_ROUTER_API_KEY;
    if (apiKey === undefined || apiKey === '') {
        console.log ('set ORDER_ROUTER_API_KEY (get one at https://docs.ccxt.com/router)');
        return;
    }

    const router = new ccxt.OrderRouter ({
        'apiKey': apiKey,
        // 'baseUrl': 'https://docs.ccxt.com/router/api',  // the default
    });

    // Exactly one of amountIn or amountOut — never both, and never neither.
    // They are different book traversals, not a unit conversion: amountIn walks
    // until the money runs out, amountOut walks until the size is reached.
    const route = await router.fetchRoute ('USDT', 'BTC', {
        'amountIn': 20,
        'strategy': 'split_optimal',
    });

    // An unroutable pair comes back as a result with a reason, NOT an exception.
    // Refusing to quote is a deliberate outcome, not an error.
    if (route['unroutableReason'] !== undefined && route['unroutableReason'] !== null) {
        console.log ('unroutable:', route['unroutableReason']);
        return;
    }

    console.log (route['amountIn'], route['from'], '->', route['amountOut'], route['to']);
    console.log ('effective rate  ', route['effectiveRate']);
    console.log ('price impact    ', route['impactBps'], 'bps');  // positive is worse
    console.log ('fill ratio      ', route['fillRatio']);

    // One hop is a direct conversion; more than one means it was bridged
    // (e.g. SOL -> USDT -> BTC), and each hop is a separate order.
    const hops = route['hops'];
    for (let i = 0; i < hops.length; i++) {
        const hop = hops[i];
        console.log ('hop', i + 1, hop['pair'], hop['side'], '-', hop['legs'].length, 'venue(s)');
        const legs = hop['legs'];
        for (let j = 0; j < legs.length; j++) {
            const leg = legs[j];
            console.log ('   ', leg['exchangeId'], leg['amount'], '@', leg['effectivePrice']);
        }
    }
}

await main ();
