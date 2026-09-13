import assert from 'assert';
import { Asks, Bids, CountedAsks, CountedBids, IndexedAsks, IndexedBids } from '../../../base/ws/OrderBookSide.js';
import { OrderBook } from '../../../base/ws/OrderBook.js';

// NO_AUTO_TRANSPILE
// native ts test, intentionally not transpiled: it asserts the internals of the
// js order book sides, the Float64Array `index` buffer that mirrors the rows.
// [0, length) holds the side-signed prices of the live rows in ascending order,
// [length, index.length) is Number.MAX_VALUE padding that bisectLeft relies on,
// and storeArray grows the buffer by doubling once the live region fills it.
// The shifts in storeArray move the live region only, so this test grows sides
// well past the initial 1024 slots and checks the padding after every operation.
// The language ports keep their own index structures (a python list, a php
// array, ...) with no equivalent of this buffer, which is why the shared
// test.orderBook covers the same operations through the public surface only.
// The marker on the first comment line keeps the rust transpiler off this file.

function assertIndexInvariants (side: any, label: string) {
    const index = side.index;
    assert (index instanceof Float64Array, label + ': index is a Float64Array');
    assert (side.length <= index.length - 1, label + ': the live region leaves at least one padding slot');
    for (let i = 0; i < side.length; i++) {
        const row = side[i];
        assert (row !== undefined, label + ': row ' + i + ' exists');
        const signedPrice = (side.side === true) ? -row[0] : row[0];
        assert (index[i] === signedPrice, label + ': index[' + i + '] mirrors the row price');
        if (i > 0) {
            assert (index[i - 1] <= index[i], label + ': index is sorted at ' + i);
        }
    }
    for (let i = side.length; i < index.length; i++) {
        assert (index[i] === Number.MAX_VALUE, label + ': padding at ' + i + ' is MAX_VALUE');
    }
}

function testWsOrderBookNative () {

    // ----------------------------------------------------------------------------
    // every side type, filled in a pseudo random order past the seed buffer, then
    // a delete and a reinsert of the best, a middle and the worst level, a trim
    // through limit () and a copy (). the third element of a delta is ignored by
    // the plain sides, is the count of the counted sides and the id of the
    // indexed sides, and prices are distinct so no indexed rows share a level

    const depth = 1500; // past the 1024 slot seed buffer, the index doubles to 2048
    const sides: any[] = [ new Bids (), new Asks (), new CountedBids (), new CountedAsks (), new IndexedBids (), new IndexedAsks () ];
    for (let s = 0; s < sides.length; s++) {
        const side = sides[s];
        const label = side.constructor.name;
        assert (side.index.length === 1024, label + ': starts on the seed buffer');
        for (let i = 0; i < depth; i++) {
            const price = ((i * 7919) % depth) + 1; // 7919 is prime to 1500, so this walks a permutation of 1..depth
            side.storeArray ([ price, 1, price ]);
            assertIndexInvariants (side, label + ' insert ' + i);
        }
        assert (side.length === depth, label + ': every level stored');
        assert (side.index.length === 2048, label + ': buffer doubled once');
        for (let i = 1; i < depth; i++) {
            assert (side.index[i - 1] < side.index[i], label + ': live region strictly ascending at ' + i);
        }
        const best = side[0][0];
        const middle = side[Math.floor (depth / 2)][0];
        const worst = side[depth - 1][0];
        // delete at the front, in the middle and at the end
        side.storeArray ([ best, 0, best ]);
        assertIndexInvariants (side, label + ' delete best');
        side.storeArray ([ middle, 0, middle ]);
        assertIndexInvariants (side, label + ' delete middle');
        side.storeArray ([ worst, 0, worst ]);
        assertIndexInvariants (side, label + ' delete worst');
        assert (side.length === depth - 3, label + ': three levels gone');
        assert (side[0][0] !== best, label + ': best is gone');
        assert (side[side.length - 1][0] !== worst, label + ': worst is gone');
        // a delete of a level that is not in the book is a no-op
        side.storeArray ([ best, 0, best ]);
        assertIndexInvariants (side, label + ' delete missing');
        assert (side.length === depth - 3, label + ': missing delete is a no-op');
        // reinsert at the front, in the middle and at the end
        side.storeArray ([ worst, 2, worst ]);
        assertIndexInvariants (side, label + ' reinsert worst');
        side.storeArray ([ middle, 2, middle ]);
        assertIndexInvariants (side, label + ' reinsert middle');
        side.storeArray ([ best, 2, best ]);
        assertIndexInvariants (side, label + ' reinsert best');
        assert (side.length === depth, label + ': every level back');
        assert (side[0][0] === best, label + ': best back at the front');
        assert (side[0][1] === 2, label + ': best carries the new size');
        assert (side[Math.floor (depth / 2)][0] === middle, label + ': middle back in place');
        assert (side[depth - 1][0] === worst, label + ': worst back at the end');
        // an in-place update leaves the index untouched
        side.storeArray ([ middle, 3, middle ]);
        assertIndexInvariants (side, label + ' update middle');
        assert (side.length === depth, label + ': update does not change the length');
        assert (side[Math.floor (depth / 2)][1] === 3, label + ': update stored the size');
        // a copy rebuilds its own index from the rows
        const copied = side.copy ();
        assertIndexInvariants (copied, label + ' copy');
        assert (copied.length === depth, label + ': copy has every level');
        for (let i = 0; i < depth; i++) {
            assert (copied[i][0] === side[i][0], label + ': copy row ' + i + ' matches');
            assert (copied[i] !== side[i], label + ': copy row ' + i + ' is its own array');
        }
        // limit () trims the tail and restores the padding above the new length
        side.depth = 1000;
        side.limit ();
        assertIndexInvariants (side, label + ' limit');
        assert (side.length === 1000, label + ': trimmed to depth');
        assert (side.index.length === 2048, label + ': the buffer never shrinks');
        side.depth = Number.MAX_SAFE_INTEGER;
        // and the trimmed levels reinsert cleanly (the indexed sides must have
        // dropped them from the hashmap, otherwise this walks a stale entry)
        side.storeArray ([ worst, 1, worst ]);
        assertIndexInvariants (side, label + ' reinsert after limit');
        assert (side.length === 1001, label + ': reinsert after limit');
        assert (side[1000][0] === worst, label + ': reinserted level is the worst again');
    }

    // ----------------------------------------------------------------------------
    // the growth boundary itself: 1023 live rows fit the seed buffer, the 1024th
    // doubles it, and the buffer keeps its padding through a shrink back to empty

    const boundary: any = new Asks ();
    for (let i = 0; i < 1023; i++) {
        boundary.storeArray ([ i + 1, 1 ]);
    }
    assertIndexInvariants (boundary, 'boundary 1023');
    assert (boundary.index.length === 1024, 'boundary: 1023 rows still fit the seed buffer');
    boundary.storeArray ([ 1024, 1 ]);
    assertIndexInvariants (boundary, 'boundary 1024');
    assert (boundary.length === 1024, 'boundary: 1024 rows');
    assert (boundary.index.length === 2048, 'boundary: the 1024th row doubles the buffer');
    // inserting at the front right after a growth shifts the whole live region
    boundary.storeArray ([ 0.5, 1 ]);
    assertIndexInvariants (boundary, 'boundary front insert');
    assert (boundary[0][0] === 0.5, 'boundary: new best ask at the front');
    assert (boundary[1024][0] === 1024, 'boundary: old worst ask moved to the end');
    boundary.storeArray ([ 0.5, 0 ]);
    assertIndexInvariants (boundary, 'boundary front delete');
    assert (boundary[0][0] === 1, 'boundary: front delete restores the old best');
    // shrink all the way back down, deleting the best level every time
    for (let i = 1; i <= 1024; i++) {
        boundary.storeArray ([ i, 0 ]);
        assertIndexInvariants (boundary, 'boundary shrink ' + i);
    }
    assert (boundary.length === 0, 'boundary: empty again');
    assert (boundary.index.length === 2048, 'boundary: the buffer never shrinks');
    // and refill past the second boundary
    for (let i = 0; i < 2100; i++) {
        boundary.storeArray ([ 2100 - i, 1 ]);
    }
    assertIndexInvariants (boundary, 'boundary refill');
    assert (boundary.length === 2100, 'boundary: refilled');
    assert (boundary.index.length === 4096, 'boundary: doubled again');

    // ----------------------------------------------------------------------------
    // the indexed sides also move a row to a new price (delete plus reinsert), and
    // update a row without a price, both paths must keep the padding intact

    const indexed: any = new IndexedBids ();
    for (let i = 0; i < 1300; i++) {
        indexed.storeArray ([ i + 1, 1, 'id' + i ]);
    }
    assertIndexInvariants (indexed, 'indexed fill');
    assert (indexed.index.length === 2048, 'indexed: buffer doubled');
    // move the worst row to the very top and the best row to the very bottom
    indexed.storeArray ([ 5000, 1, 'id0' ]);
    assertIndexInvariants (indexed, 'indexed move to front');
    assert (indexed[0][2] === 'id0', 'indexed: moved row is now the best bid');
    indexed.storeArray ([ 0.5, 1, 'id1299' ]);
    assertIndexInvariants (indexed, 'indexed move to end');
    assert (indexed[indexed.length - 1][2] === 'id1299', 'indexed: moved row is now the worst bid');
    assert (indexed.length === 1300, 'indexed: moves keep the length');
    // an update without a price keeps the old level
    indexed.storeArray ([ undefined, 7, 'id650' ]);
    assertIndexInvariants (indexed, 'indexed priceless update');
    assert (indexed.length === 1300, 'indexed: priceless update keeps the length');
    // a delete without a price finds the level through the hashmap
    indexed.storeArray ([ undefined, 0, 'id650' ]);
    assertIndexInvariants (indexed, 'indexed priceless delete');
    assert (indexed.length === 1299, 'indexed: priceless delete removes the row');
    assert (indexed.hashmap.has ('id650') === false, 'indexed: deleted id left the hashmap');

    // ----------------------------------------------------------------------------
    // reset () refills the whole buffer with padding before storing the snapshot

    const book: any = new OrderBook ({});
    const snapshotAsks = [];
    const snapshotBids = [];
    for (let i = 0; i < 1200; i++) {
        snapshotAsks.push ([ 1000 + i, 1 ]);
        snapshotBids.push ([ 999 - i, 1 ]);
    }
    book.reset ({ 'asks': snapshotAsks, 'bids': snapshotBids });
    assertIndexInvariants (book.asks, 'reset asks');
    assertIndexInvariants (book.bids, 'reset bids');
    book.reset ({ 'asks': snapshotAsks.slice (0, 10), 'bids': snapshotBids.slice (0, 10) });
    assertIndexInvariants (book.asks, 'reset asks smaller');
    assertIndexInvariants (book.bids, 'reset bids smaller');
    assert (book.asks.length === 10, 'reset: smaller snapshot stored');
    assert (book.asks.index.length === 2048, 'reset: buffer kept');
}

export default testWsOrderBookNative;
