import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts snapshots process.env at import time, so these drive the module through a fresh import
// with the variable set rather than mutating an already-built config object.
async function loadConfigWith (name: string, value: string | undefined): Promise<unknown> {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    try {
        // a distinct query string per call defeats the module cache
        return await import(`./config.js?cfg=${Math.random()}`);
    } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
    }
}

test('a non-numeric setting refuses to start instead of becoming NaN', async () => {
    // NaN fails every comparison, so it does not throw and does not filter: a NaN staleness cutoff
    // makes no book stale, a NaN penalty makes every candidate score NaN, and the caller gets a
    // 200 whose amounts are all null with unroutableReason still null. A typo in a unit file must
    // not be able to produce a confidently wrong answer.
    await assert.rejects(
        () => loadConfigWith('ORDER_ROUTER_STALE_BOOK_MS', 'not-a-number'),
        /ORDER_ROUTER_STALE_BOOK_MS must be a finite number/,
    );
});

test('an infinite setting is refused too', async () => {
    await assert.rejects(
        () => loadConfigWith('ORDER_ROUTER_HOP_PENALTY_BPS', 'Infinity'),
        /ORDER_ROUTER_HOP_PENALTY_BPS must be a finite number/,
    );
});

test('an empty value falls back to the default rather than parsing as 0', async () => {
    // Number('') is 0, which for a staleness cutoff would silently mean "every book is stale".
    const mod = await loadConfigWith('ORDER_ROUTER_STALE_BOOK_MS', '') as { config: { staleBookMs: number } };
    assert.equal(mod.config.staleBookMs, 5000);
});

test('a valid override is still honoured', async () => {
    const mod = await loadConfigWith('ORDER_ROUTER_STALE_BOOK_MS', '250') as { config: { staleBookMs: number } };
    assert.equal(mod.config.staleBookMs, 250);
});

test('the one-shot rebalance is off by default', async () => {
    // On, it stopped every shard two minutes after boot — including shards whose assignment did
    // not change — so every book aged past the staleness cutoff and /route answered
    // all_books_stale for as long as the cache took to rewarm.
    const mod = await loadConfigWith('ORDER_ROUTER_REBALANCE_AFTER_MS', undefined) as {
        config: { rebalanceAfterMs: number };
    };
    assert.equal(mod.config.rebalanceAfterMs, 0);
});
