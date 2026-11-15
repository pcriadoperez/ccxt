import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../ts/db.js';
import { Dispatcher } from '../../ts/delivery.js';
import type { Alert } from '../../ts/alerts.js';

function alert (chatId: number, summary: string, extra: Partial<Alert> = {}): Alert {
    return { chatId, priority: 2, ttlMs: 60_000, html: '<b>' + summary + '</b>', summary, countsAgainstBudget: true, buttons: 'alert', createdAt: Date.now (), context: { kind: 'price' }, ...extra };
}

function setup (send?: (chatId: number | string, html: string) => Promise<{ message_id: number }>) {
    const store = new Store (':memory:');
    const sent: Array<{ chatId: number | string, html: string, markup: unknown }> = [];
    let id = 0;
    const d = new Dispatcher (store, async (chatId, html, markup) => {
        if (send) {
            return send (chatId, html);
        }
        sent.push ({ chatId, html, markup });
        return { message_id: ++id };
    }, (did) => ({ did }), 25);
    return { store, d, sent };
}

test ('alerts are sent with a keyboard and logged', async () => {
    const { store, d, sent } = setup ();
    store.ensureUser (1, { kind: 'dm', dailyBudget: 10 });
    assert.equal (d.enqueue (alert (1, 'A')), 'queued');
    await d.pump ();
    assert.equal (sent.length, 1);
    assert.ok ((sent[0].markup as any).did.startsWith ('d_'));
    const last = store.lastDeliveryWithContext (1)!;
    assert.equal (store.getDelivery (last.id)!.status, 'sent');
});

test ('several alerts for one chat merge into one message', async () => {
    const { store, d, sent } = setup ();
    store.ensureUser (1, { kind: 'dm', dailyBudget: 10 });
    d.enqueue (alert (1, 'low', { priority: 3 }));
    d.enqueue (alert (1, 'urgent', { priority: 1 }));
    d.enqueue (alert (1, 'mid', { priority: 2 }));
    await d.pump ();
    assert.equal (sent.length, 1);
    assert.match (sent[0].html, /^<b>3 of your alerts fired<\/b>\n\n<b>urgent<\/b>/);
    assert.match (sent[0].html, /• mid\n• low/);
    assert.equal (d.stats.merged, 2);
});

test ('daily budget: alerts over budget are held for the Brief', async () => {
    const { store, d, sent } = setup ();
    store.ensureUser (1, { kind: 'dm', dailyBudget: 2 });
    assert.equal (d.enqueue (alert (1, 'a')), 'queued');
    assert.equal (d.enqueue (alert (1, 'b')), 'queued');
    assert.equal (d.enqueue (alert (1, 'c')), 'held');
    assert.deepEqual (store.takeDigestItems (1), [ 'c' ]);
    await d.pump ();
    assert.equal (sent.length, 1);
});

test ('quiet hours hold alerts unless the rule breaks through', () => {
    const { store, d } = setup ();
    store.ensureUser (1, { kind: 'dm', dailyBudget: 10 });
    const m = new Date ().getUTCHours () * 60 + new Date ().getUTCMinutes ();
    store.updateUser (1, { tz: 'UTC', quietStart: (m + 1440 - 30) % 1440, quietEnd: (m + 30) % 1440 });
    assert.equal (d.enqueue (alert (1, 'q')), 'held');
    assert.equal (d.enqueue (alert (1, 'q2', { breakQuiet: true })), 'queued');
});

test ('paused and unknown users get nothing', () => {
    const { store, d } = setup ();
    store.ensureUser (1, { kind: 'dm', dailyBudget: 10 });
    store.updateUser (1, { pausedUntil: Date.now () + 60_000 });
    assert.equal (d.enqueue (alert (1, 'x')), 'dropped');
    assert.equal (d.enqueue (alert (2, 'x')), 'dropped');
});

test ('expired alerts are dropped, never sent late', async () => {
    const { store, d, sent } = setup ();
    store.ensureUser (1, { kind: 'dm', dailyBudget: 10 });
    d.enqueue (alert (1, 'old', { createdAt: Date.now () - 120_000, ttlMs: 60_000 }));
    await d.pump ();
    assert.equal (sent.length, 0);
    assert.equal (d.stats.expired, 1);
});

test ('per-chat gap of 1s and the global token bucket', async () => {
    const { store, d, sent } = setup ();
    for (let i = 1; i <= 40; i++) {
        store.ensureUser (i, { kind: 'dm', dailyBudget: 10 });
        d.enqueue (alert (i, 'x' + i));
    }
    await d.pump ();
    assert.equal (sent.length, 25, 'one burst is capped by the 25 msg/s bucket');
    d.enqueue (alert (1, 'again'));
    await d.pump ();
    assert.ok (!sent.slice (25).some ((s) => s.chatId === 1), 'chat 1 must wait 1s');
});

test ('429 pauses everyone and requeues; 403 marks the user blocked', async () => {
    let calls = 0;
    const { store, d } = setup (async (chatId) => {
        calls += 1;
        if (chatId === 1) {
            throw Object.assign (new Error ('flood'), { error_code: 429, parameters: { retry_after: 5 } });
        }
        throw Object.assign (new Error ('blocked'), { error_code: 403 });
    });
    store.ensureUser (1, { kind: 'dm', dailyBudget: 10 });
    store.ensureUser (2, { kind: 'dm', dailyBudget: 10 });
    d.enqueue (alert (1, 'a', { priority: 1 }));
    await d.pump ();
    assert.ok (d.pausedUntil > Date.now ());
    assert.equal (d.pending (), 1, 'requeued');
    d.pausedUntil = 0;
    d.queues.clear ();
    d.enqueue (alert (2, 'b'));
    await d.pump ();
    assert.equal (store.getUser (2)!.status, 'blocked');
    assert.equal (calls, 2);
});

test ('channel posts bypass user checks', async () => {
    const { d, sent } = setup ();
    d.enqueueRaw ('@ccxt_listings', 'hello');
    await d.pump ();
    assert.deepEqual (sent.map ((s) => s.chatId), [ '@ccxt_listings' ]);
});
