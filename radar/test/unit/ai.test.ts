import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numberCheck } from '../../ts/ai/numbercheck.js';
import { extractJson, OpenRouterClient, LlmUnavailable } from '../../ts/ai/llm.js';
import type { Llm, ChatMessage } from '../../ts/ai/llm.js';
import { Assistant } from '../../ts/ai/assistant.js';
import { Store } from '../../ts/db.js';
import { NewsDesk } from '../../ts/news.js';
import { makeState, setMajors } from '../helpers/fixtures.js';

class FakeLlm implements Llm {
    replies: string[];
    calls: ChatMessage[][] = [];
    constructor (replies: string[]) {
        this.replies = replies;
    }
    async complete (messages: ChatMessage[]): Promise<string> {
        this.calls.push (messages);
        const r = this.replies.shift ();
        if (r === undefined) {
            throw new LlmUnavailable ('no more replies');
        }
        return r;
    }
}

function setup (replies: string[]) {
    const now = { t: Date.now () };
    const state = makeState (now);
    setMajors (state, now.t, 100_000, 3_000);
    for (const v of [ 'binance', 'okx', 'kraken', 'coinbase' ]) {
        state.ok (v);
    }
    state.setFunding ('okx', new Map ([ [ 'ETH/USDT:USDT', { rate: 0.0001, intervalH: 8, intervalAssumed: false, ts: now.t } ] ]));
    const store = new Store (':memory:');
    store.ensureUser (7, { kind: 'dm', dailyBudget: 10 });
    const llm = new FakeLlm (replies);
    return { llm, assistant: new Assistant (llm, state, store, new NewsDesk ()), store };
}

test ('number check: allows data numbers (with rounding) and small counts, rejects invented ones', () => {
    const data = { BTC: { price: { medianUsd: 100123.45, venues: [ { price: 100150.1 } ] } }, funding: { rate8hPct: 0.0123 } };
    assert.equal (numberCheck ('BTC is 100,123.45 USD (median of 5 venues).', data).ok, true);
    assert.equal (numberCheck ('BTC is about 100,123 on 3 venues; funding 0.012%.', data).ok, true);
    const bad = numberCheck ('BTC will hit 150,000 soon.', data);
    assert.equal (bad.ok, false);
    assert.deepEqual (bad.offending, [ '150,000' ]);
});

test ('extractJson handles fences and prose', () => {
    assert.deepEqual (extractJson ('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual (extractJson ('{"intent":"other"} trailing'), { intent: 'other' });
    assert.throws (() => extractJson ('no json here'));
});

test ('plain language becomes a validated proposal (nothing is saved)', async () => {
    const { assistant, store } = setup ([ JSON.stringify ({
        intent: 'create_rule',
        rule: { kind: 'funding', base: 'eth', venues: [ 'Bybit' ], high: 0.001, low: -0.0005 },
        mode: 'repeat',
        assumptions: [ '"crazy" means above +0.10% or below −0.05% per 8h' ],
    }) ]);
    const r = await assistant.handle (7, 'ping me if eth funding on bybit goes crazy');
    assert.equal (r.kind, 'proposal');
    if (r.kind === 'proposal') {
        assert.equal (r.spec.kind, 'funding');
        assert.deepEqual ((r.spec as any).venues, [ 'bybit' ]);
        assert.equal (r.spec.kind === 'funding' && r.spec.base, 'ETH');
        assert.equal (r.assumptions.length, 1);
    }
    assert.equal (store.countRules (7), 0);
});

test ('invalid model output becomes a clarification, unknown coins are caught', async () => {
    const a = setup ([ JSON.stringify ({ intent: 'create_rule', rule: { kind: 'price', base: 'BTC', op: 'sideways', value: 1 } }) ]);
    assert.equal ((await a.assistant.handle (7, 'x')).kind, 'clarify');
    const b = setup ([ JSON.stringify ({ intent: 'create_rule', rule: { kind: 'price', base: 'NOTACOIN', op: 'above', value: 1 } }) ]);
    const r = await b.assistant.handle (7, 'x');
    assert.equal (r.kind, 'clarify');
    assert.match ((r as any).html, /couldn't find a <b>NOTACOIN<\/b>/);
});

test ('advice requests get the fixed refusal', async () => {
    const { assistant } = setup ([ JSON.stringify ({ intent: 'advice' }) ]);
    const r = await assistant.handle (7, 'should I buy eth now?');
    assert.equal (r.kind, 'refusal');
    assert.match ((r as any).html, /can't tell you what to buy/);
});

test ('questions are answered from data; a hallucinated number falls back to the data view', async () => {
    const good = setup ([
        JSON.stringify ({ intent: 'question', question: { assets: [ 'BTC' ], topics: [ 'price' ] } }),
        'BTC trades at 100,000 USD (median); all venues show the same price.',
    ]);
    const r1 = await good.assistant.handle (7, 'what is btc at?');
    assert.equal (r1.kind, 'answer');
    assert.match ((r1 as any).html, /^BTC trades at 100,000 USD/);
    assert.match (good.llm.calls[1][1].content, /"medianUsd":100000/);
    const bad = setup ([
        JSON.stringify ({ intent: 'question', question: { assets: [ 'BTC' ], topics: [ 'price' ] } }),
        'BTC is 123,456 right now.',
    ]);
    const r2 = await bad.assistant.handle (7, 'what is btc at?');
    assert.equal (r2.kind, 'answer');
    assert.match ((r2 as any).html, /Showing the data directly/);
    assert.match ((r2 as any).html, /median <code>100,000<\/code>/);
});

test ('provider failures degrade to an "unavailable" message', async () => {
    const { assistant } = setup ([]);
    const r = await assistant.handle (7, 'hello');
    assert.equal (r.kind, 'unavailable');
});

test ('OpenRouter client: request shape, daily cap and 429 handling', async () => {
    const seen: any[] = [];
    let status = 200;
    const fakeFetch = (async (url: string, init: any) => {
        seen.push ({ url, body: JSON.parse (init.body), headers: init.headers });
        return new Response (JSON.stringify ({ choices: [ { message: { content: '{"ok":true}' } } ] }), { status });
    }) as unknown as typeof fetch;
    const c = new OpenRouterClient ('key', 'openrouter/free', 'https://openrouter.ai/api/v1/', 2, fakeFetch);
    assert.equal (await c.complete ([ { role: 'user', content: 'hi' } ], { json: true }), '{"ok":true}');
    assert.equal (seen[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal (seen[0].body.model, 'openrouter/free');
    assert.deepEqual (seen[0].body.response_format, { type: 'json_object' });
    assert.equal (seen[0].headers.Authorization, 'Bearer key');
    status = 429;
    await assert.rejects (c.complete ([ { role: 'user', content: 'hi' } ]), LlmUnavailable);
    await assert.rejects (c.complete ([ { role: 'user', content: 'hi' } ]), /daily AI request cap/);
});
