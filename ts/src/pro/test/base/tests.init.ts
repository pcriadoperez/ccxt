
import testWsOrderBook from "./test.orderBook.js";
import testWsOrderBookNative from "./test.orderBookNative.js";
import testWsCache from "./test.cache.js";
import testWsCacheNative from "./test.cacheNative.js";
import testWsSingleFlight from "./test.singleFlight.js";
import testWsSingleFlightWiring from "./test.singleFlightWiring.js";
import testLbankServerPingLivenessWiring from "./test.serverPingLiveness.lbank.js";

async function testBaseWs () {
    testWsOrderBook ();
    testWsOrderBookNative (); // js-only: asserts the Float64Array index buffer of the sides
    testWsCache ();
    testWsCacheNative (); // js-only: removeAt () has no port equivalent
    // todo : testWsClose ();
    await testWsSingleFlight ();
    await testWsSingleFlightWiring ();
    await testLbankServerPingLivenessWiring ();
}

export default testBaseWs;
