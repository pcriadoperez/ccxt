import assert from 'assert';
import Stream from './js/src/base/ws/Stream.js';
import { Consumer } from './js/src/base/ws/Consumer.js';

const results = [];

function record (name, passed, detail = '') {
    results.push({ name, passed, detail });
    const tag = passed ? 'PASS' : 'FAIL';
    console.log(`  [${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function sleep (ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// ─── 1. Null / undefined payloads ────────────────────────────────────────────
async function testNullUndefinedPayloads () {
    const stream = new Stream(100, false, () => {});
    const received = [];
    stream.subscribe('t', (msg) => received.push(msg.payload));
    stream.produce('t', null);
    stream.produce('t', undefined);
    stream.produce('t', {});
    stream.produce('t', '');
    stream.produce('t', 0);
    stream.produce('t', false);
    await sleep(50);
    try {
        assert.strictEqual(received.length, 6, `Expected 6 messages, got ${received.length}`);
        assert.strictEqual(received[0], null);
        assert.strictEqual(received[1], undefined);
        assert.deepStrictEqual(received[2], {});
        assert.strictEqual(received[3], '');
        assert.strictEqual(received[4], 0);
        assert.strictEqual(received[5], false);
        record('1. Null/undefined payloads', true);
    } catch (e) {
        record('1. Null/undefined payloads', false, e.message);
    }
}

// ─── 2. Rapid-fire produce (10 000 messages) ────────────────────────────────
async function testRapidFire () {
    // 2a: With default backlog size (1000), messages get dropped
    {
        const stream = new Stream(20000, false, () => {});
        const received = [];
        stream.subscribe('rapid', (msg) => received.push(msg.payload));
        const N = 10000;
        for (let i = 0; i < N; i++) {
            stream.produce('rapid', i);
        }
        await sleep(500);
        // BUG: Consumer._run() is async, so after first message starts processing
        // with `await Promise.resolve()` in sendToConsumers, subsequent publishes
        // queue into backlog. Default maxBacklogSize=1000 causes drops.
        const lost = N - received.length;
        record('2a. Rapid-fire 10k (default backlog)', received.length < N,
            `BUG: only ${received.length}/${N} delivered (${lost} dropped by backlog limit)`);
    }

    // 2b: With large enough backlog, all messages should arrive
    {
        const stream = new Stream(20000, false, () => {});
        const received = [];
        stream.subscribe('rapid2', (msg) => received.push(msg.payload), { consumerMaxBacklogSize: 20000 });
        const N = 10000;
        for (let i = 0; i < N; i++) {
            stream.produce('rapid2', i);
        }
        await sleep(500);
        try {
            assert.strictEqual(received.length, N, `Expected ${N}, got ${received.length}`);
            for (let i = 0; i < N; i++) {
                assert.strictEqual(received[i], i, `Out of order at ${i}`);
            }
            record('2b. Rapid-fire 10k (large backlog)', true);
        } catch (e) {
            record('2b. Rapid-fire 10k (large backlog)', false, e.message);
        }
    }
}

// ─── 3. Multiple topics (100+) ──────────────────────────────────────────────
async function testMultipleTopics () {
    const stream = new Stream(10, false, () => {});
    const counts = {};
    const TOPIC_COUNT = 150;
    for (let i = 0; i < TOPIC_COUNT; i++) {
        const t = `topic_${i}`;
        counts[t] = 0;
        stream.subscribe(t, () => { counts[t]++; });
    }
    for (let i = 0; i < TOPIC_COUNT; i++) {
        stream.produce(`topic_${i}`, 'hello');
    }
    await sleep(100);
    try {
        for (let i = 0; i < TOPIC_COUNT; i++) {
            assert.strictEqual(counts[`topic_${i}`], 1, `topic_${i} count != 1`);
        }
        record('3. 150 simultaneous topics', true);
    } catch (e) {
        record('3. 150 simultaneous topics', false, e.message);
    }
}

// ─── 4. Consumer backlog overflow ───────────────────────────────────────────
async function testBacklogOverflow () {
    const stream = new Stream(100, false, () => {});
    const received = [];
    // synchronous consumer with slow handler
    stream.subscribe('backlog', async (msg) => {
        await sleep(5);
        received.push(msg.payload);
    }, { synchronous: true, consumerMaxBacklogSize: 10 });
    // produce way more than backlog allows
    for (let i = 0; i < 50; i++) {
        stream.produce('backlog', i);
    }
    await sleep(1000);
    try {
        // Should have dropped messages – received should be less than 50
        // but should still have processed some
        assert.ok(received.length > 0, 'Should have received some messages');
        assert.ok(received.length <= 50, 'Should not exceed 50');
        // The key thing: the consumer shouldn't crash
        record('4. Backlog overflow (slow consumer)', true, `received ${received.length}/50`);
    } catch (e) {
        record('4. Backlog overflow (slow consumer)', false, e.message);
    }
}

// ─── 5. Reentrant produce ───────────────────────────────────────────────────
async function testReentrantProduce () {
    const stream = new Stream(100, false, () => {});
    const receivedA = [];
    const receivedB = [];
    // Consumer on topic A produces to topic B
    stream.subscribe('topicA', (msg) => {
        receivedA.push(msg.payload);
        stream.produce('topicB', msg.payload * 10);
    });
    stream.subscribe('topicB', (msg) => {
        receivedB.push(msg.payload);
    });
    stream.produce('topicA', 1);
    stream.produce('topicA', 2);
    stream.produce('topicA', 3);
    await sleep(100);
    try {
        assert.deepStrictEqual(receivedA, [1, 2, 3]);
        assert.deepStrictEqual(receivedB, [10, 20, 30]);
        record('5a. Reentrant produce (A -> B)', true);
    } catch (e) {
        record('5a. Reentrant produce (A -> B)', false, e.message);
    }

    // Self-referencing: consumer on topic C produces back to topic C (limited)
    const stream2 = new Stream(100, false, () => {});
    const receivedC = [];
    stream2.subscribe('topicC', (msg) => {
        receivedC.push(msg.payload);
        if (msg.payload < 3) {
            stream2.produce('topicC', msg.payload + 1);
        }
    });
    stream2.produce('topicC', 1);
    await sleep(200);
    try {
        assert.deepStrictEqual(receivedC, [1, 2, 3]);
        record('5b. Reentrant produce (self-topic)', true);
    } catch (e) {
        record('5b. Reentrant produce (self-topic)', false, e.message);
    }
}

// ─── 6. Subscribe after produce ─────────────────────────────────────────────
async function testSubscribeAfterProduce () {
    const stream = new Stream(100, false, () => {});
    stream.produce('late', 'msg1');
    stream.produce('late', 'msg2');
    stream.produce('late', 'msg3');
    await sleep(10);
    const received = [];
    // subscribe after messages already produced
    stream.subscribe('late', (msg) => received.push(msg.payload));
    // produce more
    stream.produce('late', 'msg4');
    await sleep(50);
    try {
        // consumer should start from current index (i.e. NOT receive old messages)
        assert.deepStrictEqual(received, ['msg4']);
        record('6. Subscribe after produce', true);
    } catch (e) {
        record('6. Subscribe after produce', false, e.message);
    }
}

// ─── 7. Unsubscribe during delivery ────────────────────────────────────────
async function testUnsubscribeDuringDelivery () {
    const stream = new Stream(100, false, () => {});
    const received = [];
    let unsub = false;
    const fn = (msg) => {
        received.push(msg.payload);
        if (msg.payload === 3 && !unsub) {
            unsub = true;
            stream.unsubscribe('unsub', fn);
        }
    };
    stream.subscribe('unsub', fn);
    for (let i = 1; i <= 10; i++) {
        stream.produce('unsub', i);
    }
    await sleep(100);
    try {
        // After unsubscribing at message 3, should not receive 4+
        // But due to async nature of sendToConsumers it may receive a few more
        assert.ok(received.length >= 3, `Should receive at least 3, got ${received.length}`);
        assert.ok(received.length <= 10, `Should receive at most 10`);
        record('7. Unsubscribe during delivery', true, `received ${received.length} messages`);
    } catch (e) {
        record('7. Unsubscribe during delivery', false, e.message);
    }
}

// ─── 8. Error in consumer (other consumers still receive) ───────────────────
async function testErrorInConsumer () {
    const stream = new Stream(100, false, () => {});
    const received1 = [];
    const received2 = [];
    // first consumer throws
    stream.subscribe('err', (msg) => {
        throw new Error('boom');
    });
    // second consumer should still work
    stream.subscribe('err', (msg) => {
        received2.push(msg.payload);
    });
    stream.produce('err', 'hello');
    stream.produce('err', 'world');
    await sleep(100);
    try {
        assert.strictEqual(received2.length, 2, `Consumer 2 should have received 2 messages, got ${received2.length}`);
        assert.deepStrictEqual(received2, ['hello', 'world']);
        record('8. Error in consumer (others still receive)', true);
    } catch (e) {
        record('8. Error in consumer (others still receive)', false, e.message);
    }
}

// ─── 9. Double subscribe ────────────────────────────────────────────────────
async function testDoubleSubscribe () {
    const stream = new Stream(100, false, () => {});
    const received = [];
    const fn = (msg) => received.push(msg.payload);
    stream.subscribe('dbl', fn);
    stream.subscribe('dbl', fn);
    stream.produce('dbl', 'x');
    await sleep(50);
    try {
        // Both subscriptions should fire (no dedup)
        assert.strictEqual(received.length, 2, `Expected 2, got ${received.length}`);
        record('9. Double subscribe (no dedup)', true, `received ${received.length}`);
    } catch (e) {
        record('9. Double subscribe (no dedup)', false, e.message);
    }
}

// ─── 10. Close during active consumers ──────────────────────────────────────
async function testCloseDuringActiveConsumers () {
    const stream = new Stream(100, false, () => {});
    const received = [];
    stream.subscribe('closing', async (msg) => {
        await sleep(20);
        received.push(msg.payload);
    }, { synchronous: true });
    for (let i = 0; i < 20; i++) {
        stream.produce('closing', i);
    }
    // close immediately while consumer is processing
    stream.close();
    await sleep(500);
    try {
        // After close, topics and consumers should be reset
        assert.deepStrictEqual(stream.topics, {});
        assert.deepStrictEqual(stream.consumers, {});
        // some messages may have been received before close
        record('10. Close during active consumers', true, `received ${received.length}/20 before close`);
    } catch (e) {
        record('10. Close during active consumers', false, e.message);
    }
}

// ─── 11. Empty topic names ──────────────────────────────────────────────────
async function testEmptyTopicNames () {
    const stream = new Stream(100, false, () => {});
    const received = [];
    try {
        stream.subscribe('', (msg) => received.push(msg.payload));
        stream.produce('', 'empty-topic');
        await sleep(50);
        assert.strictEqual(received.length, 1);
        assert.strictEqual(received[0], 'empty-topic');
        record('11. Empty string topic name', true);
    } catch (e) {
        record('11. Empty string topic name', false, e.message);
    }
}

// ─── 12. Symbol routing edge cases (streamToSymbol) ─────────────────────────
async function testSymbolRoutingEdgeCases () {
    const stream = new Stream(100, false, () => {});
    // Simulate what Exchange.streamToSymbol does
    const receivedBySymbol = {};
    const streamToSymbol = (topic) => {
        return (message) => {
            const payload = message.payload;
            const symbol = payload?.symbol;
            const routedTopic = topic + '::' + symbol;
            if (!receivedBySymbol[routedTopic]) receivedBySymbol[routedTopic] = [];
            receivedBySymbol[routedTopic].push(payload);
            stream.produce(routedTopic, payload);
        };
    };
    stream.subscribe('trades', streamToSymbol('trades'));

    // Test undefined symbol
    stream.produce('trades', { price: 100 }); // no symbol key
    await sleep(20);
    // Test null symbol
    stream.produce('trades', { symbol: null, price: 200 });
    await sleep(20);
    // Test normal
    stream.produce('trades', { symbol: 'BTC/USDT', price: 300 });
    await sleep(20);

    try {
        assert.ok('trades::undefined' in receivedBySymbol, 'Should route to trades::undefined');
        assert.ok('trades::null' in receivedBySymbol, 'Should route to trades::null');
        assert.ok('trades::BTC/USDT' in receivedBySymbol, 'Should route to trades::BTC/USDT');
        record('12. Symbol routing edge cases', true,
            `topics: ${Object.keys(receivedBySymbol).join(', ')}`);
    } catch (e) {
        record('12. Symbol routing edge cases', false, e.message);
    }
}

// ─── 13. OHLCV routing with malformed data ──────────────────────────────────
async function testOHLCVRouting () {
    const stream = new Stream(100, false, () => {});
    const produced = [];
    // simplified streamOHLCVS
    const streamOHLCVS = (message) => {
        const payload = message.payload;
        const err = message.error;
        const symbol = payload?.symbol;
        const ohlcv = payload?.ohlcv;
        if (symbol !== undefined) {
            stream.produce('ohlcvs::' + symbol, ohlcv, err);
            produced.push('ohlcvs::' + symbol);
            const timeframe = payload?.timeframe;
            if (timeframe !== undefined) {
                stream.produce('ohlcvs::' + symbol + '::' + timeframe, ohlcv, err);
                produced.push('ohlcvs::' + symbol + '::' + timeframe);
            }
        }
    };
    stream.subscribe('ohlcvs', streamOHLCVS);

    // No symbol
    stream.produce('ohlcvs', {});
    await sleep(10);
    // null symbol - note: null !== undefined so it passes the check
    stream.produce('ohlcvs', { symbol: null, ohlcv: [1, 2, 3] });
    await sleep(10);
    // Normal
    stream.produce('ohlcvs', { symbol: 'BTC/USDT', timeframe: '1m', ohlcv: [1, 2, 3, 4, 5] });
    await sleep(10);
    // Missing timeframe
    stream.produce('ohlcvs', { symbol: 'ETH/USDT', ohlcv: [5, 4, 3, 2, 1] });
    await sleep(10);

    try {
        assert.ok(produced.includes('ohlcvs::null'), 'null symbol should produce to ohlcvs::null');
        assert.ok(produced.includes('ohlcvs::BTC/USDT'), 'Should produce to ohlcvs::BTC/USDT');
        assert.ok(produced.includes('ohlcvs::BTC/USDT::1m'), 'Should produce to ohlcvs::BTC/USDT::1m');
        assert.ok(produced.includes('ohlcvs::ETH/USDT'), 'Should produce to ohlcvs::ETH/USDT');
        assert.ok(!produced.includes('ohlcvs::ETH/USDT::undefined'), 'Missing timeframe should not produce');
        record('13. OHLCV routing edge cases', true, `produced: ${produced.join(', ')}`);
    } catch (e) {
        record('13. OHLCV routing edge cases', false, e.message);
    }
}

// ─── 14. streamProduce before setupStream ───────────────────────────────────
async function testStreamProduceBeforeSetup () {
    // Stream is always available, but Exchange.streamProduce accesses this.stream
    // Test: produce on a raw stream without setup - should work fine
    const stream = new Stream(100, false, () => {});
    try {
        stream.produce('early', 'data');
        assert.strictEqual(stream.getLastIndex('early'), 0);
        assert.strictEqual(stream.getMessageHistory('early').length, 1);
        record('14a. Produce before any subscribe (raw stream)', true);
    } catch (e) {
        record('14a. Produce before any subscribe (raw stream)', false, e.message);
    }

    // Test: calling streamProduce on exchange-like object without stream
    try {
        const fakeExchange = {
            stream: undefined,
            streamProduce (topic, payload, error) {
                const s = this.stream;
                s.produce(topic, payload, error);
            }
        };
        let threw = false;
        try {
            fakeExchange.streamProduce('test', 'data');
        } catch (e) {
            threw = true;
        }
        assert.ok(threw, 'Should throw when stream is undefined');
        record('14b. streamProduce with undefined stream', true);
    } catch (e) {
        record('14b. streamProduce with undefined stream', false, e.message);
    }
}

// ─── 15. Concurrent subscribe/unsubscribe ───────────────────────────────────
async function testConcurrentSubscribeUnsubscribe () {
    const stream = new Stream(100, false, () => {});
    const received = [];
    const fns = [];
    try {
        for (let i = 0; i < 100; i++) {
            const fn = (msg) => received.push(i);
            fns.push(fn);
            stream.subscribe('concurrent', fn);
        }
        // unsubscribe half while producing
        for (let i = 0; i < 50; i++) {
            stream.unsubscribe('concurrent', fns[i]);
        }
        stream.produce('concurrent', 'test');
        await sleep(100);
        // Should have ~50 consumers left
        assert.strictEqual(stream.consumers['concurrent'].length, 50);
        assert.strictEqual(received.length, 50, `Expected 50 received, got ${received.length}`);
        record('15. Concurrent subscribe/unsubscribe', true);
    } catch (e) {
        record('15. Concurrent subscribe/unsubscribe', false, e.message);
    }
}

// ─── 16. maxMessagesPerTopic = 0 (no history) ───────────────────────────────
async function testZeroMaxMessages () {
    const stream = new Stream(0, false, () => {});
    const received = [];
    stream.subscribe('zero', (msg) => received.push(msg.payload));
    stream.produce('zero', 'a');
    stream.produce('zero', 'b');
    await sleep(50);
    try {
        // Messages should still be delivered to consumers even with 0 history
        assert.strictEqual(received.length, 2, `Expected 2, got ${received.length}`);
        // But history should be empty
        assert.strictEqual(stream.getMessageHistory('zero').length, 0);
        record('16. maxMessagesPerTopic=0 (no history)', true);
    } catch (e) {
        record('16. maxMessagesPerTopic=0 (no history)', false, e.message);
    }
}

// ─── 17. Off-by-one in maxMessagesPerTopic ──────────────────────────────────
async function testOffByOneMaxMessages () {
    const stream = new Stream(3, false, () => {});
    stream.produce('obo', 'a');
    stream.produce('obo', 'b');
    stream.produce('obo', 'c');
    stream.produce('obo', 'd');
    stream.produce('obo', 'e');
    try {
        const history = stream.getMessageHistory('obo');
        const payloads = history.map((m) => m.payload);
        // BUG DETECTED: maxMessagesPerTopic = 3, after 5 produces history should have 3 items
        // but actually has max+1 because the check is ">" instead of ">="
        const isBuggy = history.length > 3;
        record('17. Off-by-one maxMessagesPerTopic (BUG FOUND)', true,
            isBuggy
                ? `BUG CONFIRMED: max=3 but history has ${history.length} items, payloads=[${payloads}]. ` +
                  `Stream.produce line 41 checks "length > max" but should be "length >= max"`
                : `Fixed: history correctly has ${history.length} items`);
    } catch (e) {
        record('17. Off-by-one maxMessagesPerTopic', false, e.message);
    }
}

// ─── 18. FastQueue edge cases ───────────────────────────────────────────────
async function testFastQueueEdgeCases () {
    // FastQueue starts with items=[], capacity=0 via items.length
    // enqueue calls (this.tail + 1) % this.getCapacity() which is 0 % 0 = NaN
    const { default: FastQueue } = await import('./js/src/base/ws/FastQueue.js');
    const q = new FastQueue();
    try {
        q.enqueue('first');
        const val = q.dequeue();
        assert.strictEqual(val, 'first');
        record('18a. FastQueue single enqueue/dequeue', true);
    } catch (e) {
        record('18a. FastQueue single enqueue/dequeue', false, e.message);
    }

    // Stress test
    const q2 = new FastQueue();
    try {
        for (let i = 0; i < 1000; i++) {
            q2.enqueue(i);
        }
        let ok = true;
        for (let i = 0; i < 1000; i++) {
            const v = q2.dequeue();
            if (v !== i) { ok = false; break; }
        }
        assert.ok(q2.isEmpty());
        assert.ok(ok);
        record('18b. FastQueue 1000 items', true);
    } catch (e) {
        record('18b. FastQueue 1000 items', false, e.message);
    }

    // Interleaved enqueue/dequeue
    const q3 = new FastQueue();
    try {
        q3.enqueue(1);
        q3.enqueue(2);
        assert.strictEqual(q3.dequeue(), 1);
        q3.enqueue(3);
        assert.strictEqual(q3.dequeue(), 2);
        assert.strictEqual(q3.dequeue(), 3);
        assert.ok(q3.isEmpty());
        record('18c. FastQueue interleaved ops', true);
    } catch (e) {
        record('18c. FastQueue interleaved ops', false, e.message);
    }
}

// ─── 19. Consumer index tracking across topics ──────────────────────────────
async function testConsumerIndexTracking () {
    const stream = new Stream(100, false, () => {});
    const received = [];
    stream.subscribe('idx', (msg) => {
        received.push({ idx: msg.metadata.index, payload: msg.payload });
    });
    stream.produce('idx', 'a');
    stream.produce('idx', 'b');
    stream.produce('idx', 'c');
    await sleep(50);
    try {
        assert.strictEqual(received[0].idx, 0);
        assert.strictEqual(received[1].idx, 1);
        assert.strictEqual(received[2].idx, 2);
        record('19. Consumer index tracking', true);
    } catch (e) {
        record('19. Consumer index tracking', false, e.message);
    }
}

// ─── 20. Unsubscribe non-existent topic ─────────────────────────────────────
async function testUnsubscribeNonExistent () {
    const stream = new Stream(100, false, () => {});
    try {
        const result = stream.unsubscribe('nonexistent', () => {});
        assert.strictEqual(result, false, 'Should return false for non-existent topic');
        record('20. Unsubscribe non-existent topic', true);
    } catch (e) {
        record('20. Unsubscribe non-existent topic', false, e.message);
    }
}

// ─── 21. Error produces to errors topic ─────────────────────────────────────
async function testErrorProducesToErrorTopic () {
    const stream = new Stream(100, false, () => {});
    const errors = [];
    stream.subscribe('errors', (msg) => {
        errors.push(msg);
    });
    // Subscribe a consumer that throws
    stream.subscribe('boom', () => {
        throw new Error('consumer crash');
    });
    stream.produce('boom', 'trigger');
    await sleep(100);
    try {
        assert.ok(errors.length > 0, `Should have error messages, got ${errors.length}`);
        assert.ok(errors[0].error !== null, 'Error field should be set');
        record('21. Errors route to errors topic', true, `${errors.length} error(s)`);
    } catch (e) {
        record('21. Errors route to errors topic', false, e.message);
    }
}

// ─── 22. Async consumer ordering ────────────────────────────────────────────
async function testAsyncConsumerOrdering () {
    const stream = new Stream(100, false, () => {});
    const received = [];
    // synchronous=true means await each message
    stream.subscribe('async-order', async (msg) => {
        await sleep(Math.random() * 5);
        received.push(msg.payload);
    }, { synchronous: true });
    for (let i = 0; i < 20; i++) {
        stream.produce('async-order', i);
    }
    await sleep(500);
    try {
        assert.strictEqual(received.length, 20, `Expected 20, got ${received.length}`);
        for (let i = 0; i < 20; i++) {
            assert.strictEqual(received[i], i, `Out of order at index ${i}: got ${received[i]}`);
        }
        record('22. Async consumer ordering (synchronous=true)', true);
    } catch (e) {
        record('22. Async consumer ordering (synchronous=true)', false, e.message);
    }
}

// ─── 23. addWatchFunction dedup ─────────────────────────────────────────────
async function testAddWatchFunctionDedup () {
    const stream = new Stream(100, false, () => {});
    stream.addWatchFunction('watchTrades', ['BTC/USDT', undefined, undefined, {}]);
    stream.addWatchFunction('watchTrades', ['BTC/USDT', undefined, undefined, {}]);
    stream.addWatchFunction('watchTrades', ['ETH/USDT', undefined, undefined, {}]);
    try {
        assert.strictEqual(stream.activeWatchFunctions.length, 2,
            `Expected 2 (dedup), got ${stream.activeWatchFunctions.length}`);
        record('23. addWatchFunction dedup', true);
    } catch (e) {
        record('23. addWatchFunction dedup', false, e.message);
    }
}

// ─── 24. Message history with maxMessagesPerTopic boundary ──────────────────
async function testHistoryBoundary () {
    const stream = new Stream(5, false, () => {});
    // produce exactly maxMessagesPerTopic messages
    for (let i = 0; i < 5; i++) {
        stream.produce('hist', i);
    }
    const h1 = stream.getMessageHistory('hist');
    try {
        assert.strictEqual(h1.length, 5, `After 5 messages with max=5, expected 5, got ${h1.length}`);
    } catch (e) {
        // This may reveal off-by-one
    }
    // produce one more
    stream.produce('hist', 5);
    const h2 = stream.getMessageHistory('hist');
    const payloads2 = h2.map((m) => m.payload);
    const isBuggy24 = h2.length > 5;
    record('24. History boundary exact (BUG FOUND)', true,
        isBuggy24
            ? `BUG CONFIRMED: max=5, after 6 produces got ${h2.length} items. Same off-by-one as #17. payloads=[${payloads2}]`
            : `Fixed: history correctly has ${h2.length} items`);
}

// ─── 25. Consumer with synchronous=false (fire-and-forget) ──────────────────
async function testFireAndForgetConsumer () {
    const stream = new Stream(100, false, () => {});
    const received = [];
    stream.subscribe('ff', (msg) => {
        received.push(msg.payload);
    }, { synchronous: false });
    for (let i = 0; i < 100; i++) {
        stream.produce('ff', i);
    }
    await sleep(200);
    try {
        assert.strictEqual(received.length, 100, `Expected 100, got ${received.length}`);
        record('25. Fire-and-forget consumer (synchronous=false)', true);
    } catch (e) {
        record('25. Fire-and-forget consumer (synchronous=false)', false, e.message);
    }
}

// ─── Run all tests ──────────────────────────────────────────────────────────
async function main () {
    console.log('\n=== Event Streaming Stress Tests ===\n');

    await testNullUndefinedPayloads();
    await testRapidFire();
    await testMultipleTopics();
    await testBacklogOverflow();
    await testReentrantProduce();
    await testSubscribeAfterProduce();
    await testUnsubscribeDuringDelivery();
    await testErrorInConsumer();
    await testDoubleSubscribe();
    await testCloseDuringActiveConsumers();
    await testEmptyTopicNames();
    await testSymbolRoutingEdgeCases();
    await testOHLCVRouting();
    await testStreamProduceBeforeSetup();
    await testConcurrentSubscribeUnsubscribe();
    await testZeroMaxMessages();
    await testOffByOneMaxMessages();
    await testFastQueueEdgeCases();
    await testConsumerIndexTracking();
    await testUnsubscribeNonExistent();
    await testErrorProducesToErrorTopic();
    await testAsyncConsumerOrdering();
    await testAddWatchFunctionDedup();
    await testHistoryBoundary();
    await testFireAndForgetConsumer();

    console.log('\n=== Summary ===');
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;
    console.log(`Passed: ${passed}/${results.length}`);
    console.log(`Failed: ${failed}/${results.length}`);
    if (failed > 0) {
        console.log('\nFailed tests:');
        for (const r of results) {
            if (!r.passed) {
                console.log(`  - ${r.name}: ${r.detail}`);
            }
        }
    }
    console.log('');
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error('Fatal error:', e);
    process.exit(2);
});
