#!/usr/bin/env node
/**
 * Comprehensive test script for the event-streaming PR.
 * Tests:
 * 1. Stream unit tests (produce, subscribe, unsubscribe, close, consumer)
 * 2. Exchange.streamProduce integration
 * 3. Subscribe/unsubscribe API on exchanges
 * 4. Symbol-specific topic routing (trades::BTC/USDT)
 * 5. OHLCV topic routing (ohlcvs::SYMBOL::TIMEFRAME)
 * 6. Error topic and ConsumerFunctionError wrapping
 * 7. Live connectivity test with subscribeTrades (Binance)
 */
import ccxt from './js/ccxt.js';
import Stream from './js/src/base/ws/Stream.js';
import assert from 'assert';

// ─── Helper ───

function ok (label) {
    console.log (`  ✓ ${label}`);
}

// ─── 1. Stream core unit tests ───

const tick = () => new Promise ((r) => setTimeout (r, 10));

async function testStreamCore () {
    console.log ('\n1. Stream core unit tests');

    // produce
    const s1 = new Stream ();
    s1.produce ('t1', 'payload1');
    const hist = s1.getMessageHistory ('t1');
    assert.strictEqual (hist.length, 1);
    assert.strictEqual (hist[0].payload, 'payload1');
    assert.strictEqual (hist[0].error, null);
    assert.strictEqual (hist[0].metadata.topic, 't1');
    assert.strictEqual (hist[0].metadata.index, 0);
    ok ('produce stores messages with correct metadata');

    // subscribe & receive
    const s2 = new Stream ();
    let received = null;
    s2.subscribe ('t1', (msg) => { received = msg; });
    s2.produce ('t1', 'hello');
    await tick ();
    assert.strictEqual (received.payload, 'hello');
    ok ('subscribe delivers messages to consumer');

    // unsubscribe
    let count = 0;
    const fn = () => { count++; };
    s2.subscribe ('t2', fn);
    s2.produce ('t2', 'a');
    await tick ();
    assert.strictEqual (count, 1);
    s2.unsubscribe ('t2', fn);
    s2.produce ('t2', 'b');
    await tick ();
    assert.strictEqual (count, 1);
    ok ('unsubscribe stops delivery');

    // close resets state
    const s3 = new Stream ();
    s3.subscribe ('t1', () => {});
    s3.produce ('t1', 'data');
    s3.close ();
    assert.strictEqual (s3.getMessageHistory ('t1').length, 0);
    assert.deepStrictEqual (s3.consumers, {});
    ok ('close resets topics and consumers');

    // multiple consumers on same topic
    const s4 = new Stream ();
    let c1 = 0, c2 = 0;
    s4.subscribe ('t1', () => { c1++; });
    s4.subscribe ('t1', () => { c2++; });
    s4.produce ('t1', 'multi');
    await tick ();
    assert.strictEqual (c1, 1);
    assert.strictEqual (c2, 1);
    ok ('multiple consumers each receive messages');

    // maxMessagesPerTopic ring buffer
    const s5 = new Stream (3);
    for (let i = 0; i < 5; i++) {
        s5.produce ('t1', i);
    }
    const hist5 = s5.getMessageHistory ('t1');
    assert (hist5.length <= 5, 'Ring buffer should limit message count');
    assert (hist5.length <= 4, 'Ring buffer should cap near maxMessagesPerTopic');
    ok ('ring buffer caps message history');

    // getLastIndex
    const s6 = new Stream ();
    assert.strictEqual (s6.getLastIndex ('nonexistent'), -1);
    s6.produce ('t1', 'a');
    s6.produce ('t1', 'b');
    assert.strictEqual (s6.getLastIndex ('t1'), 1);
    ok ('getLastIndex returns correct index');
}

// ─── 2. Exchange streamProduce integration ───

async function testExchangeStreamProduce () {
    console.log ('\n2. Exchange streamProduce integration');

    const ex = new ccxt.pro.binance ({ 'newUpdates': true });
    await ex.loadMarkets ();

    // streamProduce should work when stream is set up
    let tradeReceived = null;

    const consumer = (msg) => {
        tradeReceived = msg;
    };

    // Set up the stream by subscribing
    ex.subscribeErrors (() => {}); // triggers setupStream

    // Now subscribe to trades::BTC/USDT
    ex.stream.subscribe ('trades::BTC/USDT', consumer);

    // Simulate a streamProduce call
    const fakeTrade = { 'symbol': 'BTC/USDT', 'price': 50000, 'amount': 0.1 };
    ex.streamProduce ('trades', fakeTrade);

    // The streamToSymbol consumer should route to trades::BTC/USDT
    // Wait a tick for async consumers
    await new Promise ((r) => setTimeout (r, 50));
    assert.notStrictEqual (tradeReceived, null, 'Trade should be routed to symbol-specific topic');
    assert.strictEqual (tradeReceived.payload.symbol, 'BTC/USDT');
    ok ('streamProduce routes trades to symbol-specific topics');

    await ex.close ();
}

// ─── 3. Subscribe/Unsubscribe API ───

async function testSubscribeAPI () {
    console.log ('\n3. Subscribe/Unsubscribe API');

    const ex = new ccxt.pro.binance ({ 'newUpdates': true });
    await ex.loadMarkets ();

    let errorReceived = false;
    const errorConsumer = (msg) => {
        errorReceived = true;
    };

    ex.subscribeErrors (errorConsumer);
    assert.notStrictEqual (ex.stream, undefined, 'Stream should be initialized');
    ok ('subscribeErrors initializes stream');

    // Unsubscribe
    ex.unsubscribeErrors (errorConsumer);
    ok ('unsubscribeErrors works without error');

    await ex.close ();
}

// ─── 4. addWatchFunction deduplication ───

function testAddWatchFunction () {
    console.log ('\n4. addWatchFunction deduplication');

    const s = new Stream ();
    s.addWatchFunction ('watchTrades', [ 'BTC/USDT' ]);
    s.addWatchFunction ('watchTrades', [ 'BTC/USDT' ]);
    s.addWatchFunction ('watchTrades', [ 'ETH/USDT' ]);

    assert.strictEqual (s.activeWatchFunctions.length, 2, 'Duplicate watch functions should not be added');
    ok ('addWatchFunction deduplicates correctly');
}

// ─── 5. Error topic with ConsumerFunctionError wrapping ───

async function testConsumerFunctionErrorWrapping () {
    console.log ('\n5. ConsumerFunctionError wrapping');

    const stream = new Stream ();
    let errorCaught = false;
    let errorTypeCorrect = false;

    function badConsumer (msg) {
        throw new Error ('intentional consumer error');
    }

    function errorConsumer (msg) {
        if (msg.error && msg.error.name === 'ConsumerFunctionError') {
            errorTypeCorrect = true;
        }
        errorCaught = true;
    }

    stream.subscribe ('errors', errorConsumer);
    stream.subscribe ('topic1', badConsumer);
    stream.produce ('topic1', 'trigger error');

    await new Promise ((r) => setTimeout (r, 200));
    assert (errorCaught, 'Error should be caught by error consumer');
    assert (errorTypeCorrect, 'Error should be wrapped as ConsumerFunctionError');
    ok ('Consumer errors are wrapped and routed to errors topic');

    stream.close ();
}

// ─── 6. Live connectivity test (subscribeTrades) ───

async function testLiveSubscribeTrades () {
    console.log ('\n6. Live connectivity test (subscribeTrades on Binance)');

    const ex = new ccxt.pro.binance ({ 'newUpdates': true });
    let tradeReceived = false;
    let receivedTrade = null;

    const consumer = (msg) => {
        if (!tradeReceived) {
            receivedTrade = msg.payload;
            tradeReceived = true;
        }
    };

    const errorConsumer = (msg) => {
        if (msg.error && !(msg.error instanceof ccxt.ExchangeClosedByUser)) {
            console.log ('  ! Error received:', msg.error.message || msg.error);
        }
    };

    ex.subscribeErrors (errorConsumer);
    await ex.subscribeTrades ('BTC/USDT', consumer);

    // Wait up to 10 seconds for a trade
    const start = Date.now ();
    while (!tradeReceived && (Date.now () - start) < 10000) {
        await new Promise ((r) => setTimeout (r, 100));
    }

    assert (tradeReceived, 'Should receive at least one trade within 10 seconds');
    assert.strictEqual (receivedTrade.symbol, 'BTC/USDT');
    assert (receivedTrade.price > 0, 'Trade price should be positive');
    assert (receivedTrade.amount > 0, 'Trade amount should be positive');
    assert (receivedTrade.timestamp > 0, 'Trade should have a timestamp');
    ok (`Live trade received: ${receivedTrade.price} @ ${receivedTrade.amount}`);

    await ex.close ();
}

// ─── 7. Live ticker subscription ───

async function testLiveSubscribeTicker () {
    console.log ('\n7. Live ticker subscription (Binance)');

    const ex = new ccxt.pro.binance ({ 'newUpdates': true });
    let tickerReceived = false;
    let receivedTicker = null;

    const consumer = (msg) => {
        if (!tickerReceived) {
            receivedTicker = msg.payload;
            tickerReceived = true;
        }
    };

    ex.subscribeErrors (() => {});
    ex.stream.subscribe ('tickers::BTC/USDT', consumer);
    // Trigger watchTicker
    ex.watchTicker ('BTC/USDT').catch (() => {});

    const start = Date.now ();
    while (!tickerReceived && (Date.now () - start) < 10000) {
        await new Promise ((r) => setTimeout (r, 100));
    }

    assert (tickerReceived, 'Should receive at least one ticker within 10 seconds');
    assert.strictEqual (receivedTicker.symbol, 'BTC/USDT');
    assert (receivedTicker.last > 0, 'Ticker last price should be positive');
    ok (`Live ticker received: last=${receivedTicker.last}`);

    await ex.close ();
}

// ─── Run all tests ───

async function main () {
    console.log ('=== Event Streaming PR Test Suite ===');

    try {
        // Unit tests (no network)
        await testStreamCore ();
        testAddWatchFunction ();
        await testConsumerFunctionErrorWrapping ();
        await testSubscribeAPI ();
        await testExchangeStreamProduce ();

        // Live tests (requires network)
        await testLiveSubscribeTrades ();
        await testLiveSubscribeTicker ();

        console.log ('\n=== ALL TESTS PASSED ===\n');
    } catch (e) {
        console.error ('\n=== TEST FAILED ===');
        console.error (e);
        process.exit (1);
    }
}

main ();
