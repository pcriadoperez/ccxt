/* eslint-disable max-classes-per-file */
// @ts-nocheck
import { Int } from '../types.js';

interface CustomArray extends Array<any> {
    hashmap: object;
}

class BaseCache extends Array {

    constructor (maxSize: Int = undefined) {
        super ()
        Object.defineProperty (this, 'maxSize', {
            __proto__: null, // make it invisible
            value: maxSize,
            writable: true,
        })
    }

    clear () {
        this.length = 0
    }

    // these caches subclass Array, so the receiver is not a pristine array and
    // Array.prototype.shift / splice fall back to their generic paths; splice
    // additionally runs ArraySpeciesCreate, which constructs a throw-away cache
    // instance (running every defineProperty in the constructor) just to hold
    // the one removed element. Sliding the tail down by hand stays on the fast
    // path and allocates nothing.
    removeAt (index) {
        const last = this.length - 1
        const removed = this[index]
        for (let i = index; i < last; i++) {
            this[i] = this[i + 1]
        }
        this.length = last
        return removed
    }

    // Array.prototype.push is on the same generic path for a subclassed receiver (a
    // length Get, an element Set and a length Set through the property machinery),
    // while an indexed store at this.length is the plain JSArray grow path and
    // about half the cost. Observable result is identical: one more element, length + 1
    pushLast (item) {
        this[this.length] = item
    }

    // finds the array position of the row object a keyed subclass holds in its
    // hashmap. The row is the very object stored in the array, so a pointer compare
    // is enough - no per-row property reads - and the scan runs from the tail because
    // the row being updated is almost always a recent one, which makes the common
    // case O(1) instead of a full pass. Returns -1 when the object is not in the array
    indexOfReference (reference) {
        for (let i = this.length - 1; i >= 0; i--) {
            if (this[i] === reference) {
                return i
            }
        }
        return -1
    }
}

class ArrayCache extends BaseCache implements CustomArray {

    hashmap: object = {};

    constructor (maxSize: Int = undefined) {
        super (maxSize);
        Object.defineProperty (this, 'nestedNewUpdatesBySymbol', {
            __proto__: null, // make it invisible
            value: false,
            writable: true,
        })
        Object.defineProperty (this, 'newUpdatesBySymbol', {
            __proto__: null, // make it invisible
            value: {},
            writable: true,
        })
        // the distinct ids/sides seen per key since the last getLimit (), kept by the
        // keyed subclasses; newUpdatesBySymbol only ever holds the resulting count
        Object.defineProperty (this, 'seenUpdatesBySymbol', {
            __proto__: null, // make it invisible
            value: {},
            writable: true,
        })
        // the same, but cleared only by the GLOBAL getLimit () scope - the two poll
        // scopes are independent, so each needs its own memory of what it has seen
        Object.defineProperty (this, 'seenUpdatesAll', {
            __proto__: null, // make it invisible
            value: {},
            writable: true,
        })
        Object.defineProperty (this, 'clearUpdatesBySymbol', {
            __proto__: null, // make it invisible
            value: {},
            writable: true,
        })
        Object.defineProperty (this, 'allNewUpdates', {
            __proto__: null, // make it invisible
            value: 0,
            writable: true,
        })
        Object.defineProperty (this, 'clearAllUpdates', {
            __proto__: null, // make it invisible
            value: false,
            writable: true,
        })
        Object.defineProperty (this, 'hashmap', {
            __proto__: null, // make it invisible
            value: {},
            writable: true,
            enumerable: false,
        })
    }

    getLimit (symbol, limit) {
        let newUpdatesValue: Bool = undefined

        if (symbol === undefined) {
            newUpdatesValue = this.allNewUpdates
            this.clearAllUpdates = true
        } else {
            newUpdatesValue = this.newUpdatesBySymbol[symbol];
            this.clearUpdatesBySymbol[symbol] = true
        }

        if (newUpdatesValue === undefined) {
            return limit
        } else if (limit !== undefined) {
            return Math.min (newUpdatesValue, limit)
        } else {
            return newUpdatesValue;
        }
    }

    clear () {
        super.clear ()
        // the keyed subclasses find existing rows through the hashmap, so a clear ()
        // that only truncates the array leaves the hashmap claiming rows that are
        // gone - the next append then merges into an orphaned reference, and the
        // move-to-end scan below finds no row, so the row is silently lost. The
        // update counters have to go too, or getLimit () keeps reporting updates
        // for rows that no longer exist.
        this.hashmap = {}
        this.newUpdatesBySymbol = {}
        this.seenUpdatesBySymbol = {}
        this.seenUpdatesAll = {}
        this.clearUpdatesBySymbol = {}
        this.allNewUpdates = 0
        this.clearAllUpdates = false
    }

    append (item) {
        // maxSize may be 0 when initialized by a .filter() copy-construction
        if (this.maxSize && (this.length === this.maxSize)) {
            this.removeAt (0)
        }
        this.pushLast (item)
        if (this.clearAllUpdates) {
            this.clearAllUpdates = false
            // the global poll consumes only the global scope: the symbol-scoped
            // seen sets, counts and pending flags belong to the symbol consumers
            // and survive until their own polls clear them
            this.allNewUpdates = 0
            this.seenUpdatesAll = {}
        }
        const symbol = item.symbol
        const newUpdatesBySymbol = this.newUpdatesBySymbol
        if (this.clearUpdatesBySymbol[symbol]) {
            this.clearUpdatesBySymbol[symbol] = false
            newUpdatesBySymbol[symbol] = 0
        }
        newUpdatesBySymbol[symbol] = (newUpdatesBySymbol[symbol] || 0) + 1
        this.allNewUpdates = (this.allNewUpdates || 0) + 1
    }
}

class ArrayCacheByTimestamp extends BaseCache {

    constructor (maxSize: Int = undefined) {
        super (maxSize)
        Object.defineProperty (this, 'hashmap', {
            __proto__: null, // make it invisible
            value: {},
            writable: true,
        })
        Object.defineProperty (this, 'sizeTracker', {
            __proto__: null, // make it invisible
            value: new Set (),
            writable: true,
        })
        Object.defineProperty (this, 'newUpdates', {
            __proto__: null, // make it invisible
            value: 0,
            writable: true,
        })
        Object.defineProperty (this, 'clearUpdates', {
            __proto__: null, // make it invisible
            value: false,
            writable: true,
        })
    }

    getLimit (symbol, limit) {
        this.clearUpdates = true
        if (limit === undefined) {
            return this.newUpdates
        }
        return Math.min (this.newUpdates, limit)
    }

    clear () {
        super.clear ()
        // without this the hashmap still claims every timestamp it has ever seen,
        // so re-appending a known timestamp merges into a reference that is no
        // longer in the array and the candle is dropped
        this.hashmap = {}
        this.sizeTracker.clear ()
        this.newUpdates = 0
        this.clearUpdates = false
    }

    append (item) {
        const timestamp = item[0]
        const hashmap = this.hashmap
        if (timestamp in hashmap) {
            const reference = hashmap[timestamp]
            if (reference !== item) {
                // OHLCV rows are arrays, so a "for prop in item" merge only walks the
                // indices the incoming row happens to have - a shorter update then
                // leaves the previous row's trailing values in place, e.g.
                // [100,1,2,3,4,5] followed by [100,9,9] used to yield [100,9,9,3,4,5].
                // Iterate the incoming item and drop whatever it does not cover.
                const itemLength = item.length
                for (let i = 0; i < itemLength; i++) {
                    reference[i] = item[i]
                }
                reference.length = itemLength
            }
        } else {
            hashmap[timestamp] = item
            if (this.maxSize && (this.length === this.maxSize)) {
                const deleteReference = this.removeAt (0)
                delete hashmap[deleteReference[0]]
            }
            this.pushLast (item)
        }
        if (this.clearUpdates) {
            this.clearUpdates = false
            this.sizeTracker.clear ()
        }
        this.sizeTracker.add (timestamp)
        this.newUpdates = this.sizeTracker.size
    }
}

class ArrayCacheBySymbolById extends ArrayCache {

    constructor (maxSize: Int = undefined) {
        super (maxSize)
        this.nestedNewUpdatesBySymbol = true
        // non-enumerable so it stays invisible to array equality/iteration (this extends Array);
        // the item field used as the first nesting level, overridden by ArrayCacheByOutcomeById
        Object.defineProperty (this, 'keyField', {
            __proto__: null, // make it invisible
            value: 'symbol',
            writable: true,
        })
        // number of ids held by each hashmap bucket. The eviction path has to drop a
        // bucket once its last id is gone, and Object.keys (bucket).length === 0 (or a
        // for-in, which V8 backs with the same key collection) walks every id of the
        // symbol on every eviction - on a full cache that single test cost more than
        // the rest of append () combined. Tracked here, off the bucket, so the public
        // hashmap[symbol] shape stays a plain id -> row map
        Object.defineProperty (this, 'bucketSizes', {
            __proto__: null, // make it invisible
            value: {},
            writable: true,
        })
    }

    clear () {
        super.clear ()
        this.bucketSizes = {}
    }

    append (item) {
        const keyField = this.keyField
        const key = item[keyField]
        const hashmap = this.hashmap
        let byId = hashmap[key]
        if (byId === undefined) {
            byId = {}
            hashmap[key] = byId
        }
        const itemId = item.id
        if (itemId in byId) {
            const reference = byId[itemId]
            if (reference !== item) {
                for (const prop in item) {
                    reference[prop] = item[prop]
                }
            }
            item = reference
            // move the order to the end of the array. The hashmap holds the very row
            // object that sits in the array, so it is located by identity (tail-first,
            // see BaseCache.indexOfReference). Should the hashmap ever point at an
            // object that is not in the array, fall back to matching on both the key
            // field (e.g. symbol) and id - different symbols can share an order id
            // (exchanges like binance use per-symbol id sequences), and matching on
            // id alone would remove the wrong row. A hashmap entry with no matching
            // row leaves the array untouched.
            let index = this.indexOfReference (reference)
            if (index === -1) {
                const itemKey = item[keyField]
                const arrayLength = this.length
                for (let i = 0; i < arrayLength; i++) {
                    const existing = this[i]
                    if ((existing.id === itemId) && (existing[keyField] === itemKey)) {
                        index = i
                        break
                    }
                }
            }
            if (index !== -1) {
                this.removeAt (index)
            }
        } else {
            byId[itemId] = item
            this.bucketSizes[key] = (this.bucketSizes[key] || 0) + 1
        }
        if (this.maxSize && (this.length === this.maxSize)) {
            const deleteReference = this.removeAt (0)
            const deleteKey = deleteReference[keyField]
            const deleteId = deleteReference.id
            delete hashmap[deleteKey][deleteId]
            // drop the outer bucket once its last id is gone, otherwise a stream with
            // many short-lived symbols leaks one empty object per symbol forever
            const remainingIds = this.bucketSizes[deleteKey] - 1
            if (remainingIds === 0) {
                delete hashmap[deleteKey]
                delete this.bucketSizes[deleteKey]
            } else {
                this.bucketSizes[deleteKey] = remainingIds
            }
            // the evicted id also leaves both seen scopes: a single-scope poller
            // never fires the other scope's clear, so without this the seen sets
            // grow by every distinct id for the process lifetime - the counts then
            // mean distinct ids within the retained window, which is exactly what
            // a consumer can slice anyway
            const evictedSymbolSeen = this.seenUpdatesBySymbol[deleteKey]
            if (evictedSymbolSeen !== undefined) {
                const droppedSymbolScope = evictedSymbolSeen.delete (deleteId)
                if (droppedSymbolScope) {
                    this.newUpdatesBySymbol[deleteKey] = this.newUpdatesBySymbol[deleteKey] - 1
                }
                if (evictedSymbolSeen.size === 0) {
                    delete this.seenUpdatesBySymbol[deleteKey]
                }
            }
            const evictedAllSeen = this.seenUpdatesAll[deleteKey]
            if (evictedAllSeen !== undefined) {
                const droppedGlobalScope = evictedAllSeen.delete (deleteId)
                if (droppedGlobalScope) {
                    this.allNewUpdates = this.allNewUpdates - 1
                }
                if (evictedAllSeen.size === 0) {
                    delete this.seenUpdatesAll[deleteKey]
                }
            }
        }
        this.pushLast (item)
        if (this.clearAllUpdates) {
            this.clearAllUpdates = false
            // the global poll consumes only the global scope: the symbol-scoped
            // seen sets, counts and pending flags belong to the symbol consumers
            // and survive until their own polls clear them
            this.allNewUpdates = 0
            this.seenUpdatesAll = {}
        }
        let idSet = this.seenUpdatesBySymbol[key]
        if (idSet === undefined) {
            idSet = new Set ()
            this.seenUpdatesBySymbol[key] = idSet
        }
        if (this.clearUpdatesBySymbol[key]) {
            this.clearUpdatesBySymbol[key] = false
            idSet.clear ()
        }
        // count distinct ids, in case an exchange updates the same order id twice
        idSet.add (itemId)
        this.newUpdatesBySymbol[key] = idSet.size
        // the global scope keeps its own seen sets: the symbol-scoped poll clears
        // the symbol set, and deriving the global count from that set double-counts
        // an id that updates again after a symbol poll
        let allIdSet = this.seenUpdatesAll[key]
        if (allIdSet === undefined) {
            allIdSet = new Set ()
            this.seenUpdatesAll[key] = allIdSet
        }
        const beforeAllLength = allIdSet.size
        allIdSet.add (itemId)
        this.allNewUpdates = (this.allNewUpdates || 0) + (allIdSet.size - beforeAllLength)
    }
}

class ArrayCacheByOutcomeById extends ArrayCacheBySymbolById {

    constructor (maxSize: Int = undefined) {
        super (maxSize)
        this.keyField = 'outcome'
    }
}

class ArrayCacheBySymbolBySide extends ArrayCache {

    constructor () {
        super ()
        this.nestedNewUpdatesBySymbol = true
        Object.defineProperty (this, 'hashmap', {
            __proto__: null, // make it invisible
            value: {},
            writable: true,
        })
    }

    append (item) {
        const symbol = item.symbol
        const side = item.side
        const hashmap = this.hashmap
        let bySide = hashmap[symbol]
        if (bySide === undefined) {
            bySide = {}
            hashmap[symbol] = bySide
        }
        if (side in bySide) {
            const reference = bySide[side]
            if (reference !== item) {
                for (const prop in item) {
                    reference[prop] = item[prop]
                }
            }
            item = reference
            // move the position to the end of the array: located by identity first
            // (see BaseCache.indexOfReference), with the (symbol, side) match as the
            // fallback; a stale hashmap entry with no matching row leaves the array
            // untouched
            let index = this.indexOfReference (reference)
            if (index === -1) {
                const itemSymbol = item.symbol
                const itemSide = item.side
                const arrayLength = this.length
                for (let i = 0; i < arrayLength; i++) {
                    const existing = this[i]
                    if ((existing.symbol === itemSymbol) && (existing.side === itemSide)) {
                        index = i
                        break
                    }
                }
            }
            if (index !== -1) {
                this.removeAt (index)
            }
        } else {
            bySide[side] = item
        }
        this.pushLast (item)
        if (this.clearAllUpdates) {
            this.clearAllUpdates = false
            // the global poll consumes only the global scope: the symbol-scoped
            // seen sets, counts and pending flags belong to the symbol consumers
            // and survive until their own polls clear them
            this.allNewUpdates = 0
            this.seenUpdatesAll = {}
        }
        let sideSet = this.seenUpdatesBySymbol[symbol]
        if (sideSet === undefined) {
            sideSet = new Set ()
            this.seenUpdatesBySymbol[symbol] = sideSet
        }
        if (this.clearUpdatesBySymbol[symbol]) {
            this.clearUpdatesBySymbol[symbol] = false
            sideSet.clear ()
        }
        // count distinct sides, in case an exchange updates the same side twice
        sideSet.add (side)
        this.newUpdatesBySymbol[symbol] = sideSet.size
        // independent global-scope memory, see ArrayCacheBySymbolById.append
        let allSideSet = this.seenUpdatesAll[symbol]
        if (allSideSet === undefined) {
            allSideSet = new Set ()
            this.seenUpdatesAll[symbol] = allSideSet
        }
        const beforeAllLength = allSideSet.size
        allSideSet.add (side)
        this.allNewUpdates = (this.allNewUpdates || 0) + (allSideSet.size - beforeAllLength)
    }
}

export {
    ArrayCache,
    ArrayCacheByTimestamp,
    ArrayCacheBySymbolById,
    ArrayCacheByOutcomeById,
    ArrayCacheBySymbolBySide,
};
