import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEV_API_KEY, extractApiKey, isPublicPath, resolveApiKey, safeCompare } from './auth.js';

test('safeCompare matches identical strings and rejects different ones', () => {
    assert.equal(safeCompare('secret', 'secret'), true);
    assert.equal(safeCompare('secret', 'secrez'), false);
});

test('safeCompare handles differing lengths without throwing', () => {
    // Naive timingSafeEqual on raw buffers throws on length mismatch; the digest-first approach
    // must not, or an attacker could DoS/probe with a short key.
    assert.doesNotThrow(() => safeCompare('a', 'a-much-longer-key'));
    assert.equal(safeCompare('a', 'a-much-longer-key'), false);
    assert.equal(safeCompare('', 'nonempty'), false);
});

test('safeCompare does not treat a prefix as a match', () => {
    assert.equal(safeCompare('secret', 'secret-extra'), false);
    assert.equal(safeCompare('secret-extra', 'secret'), false);
});

test('extractApiKey reads X-API-Key', () => {
    assert.equal(extractApiKey({ 'x-api-key': 'abc' }), 'abc');
});

test('extractApiKey reads Authorization: Bearer, case-insensitively', () => {
    assert.equal(extractApiKey({ authorization: 'Bearer abc' }), 'abc');
    assert.equal(extractApiKey({ authorization: 'bearer abc' }), 'abc');
    assert.equal(extractApiKey({ authorization: '  Bearer   abc' }), 'abc');
});

test('extractApiKey prefers X-API-Key when both are present', () => {
    assert.equal(extractApiKey({ 'x-api-key': 'from-header', authorization: 'Bearer from-bearer' }), 'from-header');
});

test('extractApiKey returns undefined for missing/empty/malformed credentials', () => {
    assert.equal(extractApiKey({}), undefined);
    assert.equal(extractApiKey({ 'x-api-key': '' }), undefined);
    assert.equal(extractApiKey({ authorization: 'Basic abc' }), undefined);
    assert.equal(extractApiKey({ authorization: 'Bearer' }), undefined);
    assert.equal(extractApiKey({ 'x-api-key': 123 }), undefined);
});

test('isPublicPath allowlists only /health', () => {
    assert.equal(isPublicPath('/health'), true);
    assert.equal(isPublicPath('/symbols'), false);
    assert.equal(isPublicPath('/exchanges/status'), false);
    assert.equal(isPublicPath('/route'), false);
});

test('isPublicPath ignores the query string rather than matching on it', () => {
    assert.equal(isPublicPath('/health?probe=1'), true);
    // A protected path must not become public by appending a query that mentions /health.
    assert.equal(isPublicPath('/symbols?redirect=/health'), false);
});

test('resolveApiKey falls back to the dev key and flags it as default', () => {
    const previous = process.env['ORDER_ROUTER_API_KEY'];
    delete process.env['ORDER_ROUTER_API_KEY'];
    try {
        const resolved = resolveApiKey();
        assert.equal(resolved.apiKey, DEV_API_KEY);
        assert.equal(resolved.isDefault, true);
    } finally {
        if (previous !== undefined) process.env['ORDER_ROUTER_API_KEY'] = previous;
    }
});

test('resolveApiKey prefers a configured key and flags it as non-default', () => {
    const previous = process.env['ORDER_ROUTER_API_KEY'];
    process.env['ORDER_ROUTER_API_KEY'] = 'configured-production-key';
    try {
        const resolved = resolveApiKey();
        assert.equal(resolved.apiKey, 'configured-production-key');
        assert.equal(resolved.isDefault, false);
    } finally {
        if (previous === undefined) delete process.env['ORDER_ROUTER_API_KEY'];
        else process.env['ORDER_ROUTER_API_KEY'] = previous;
    }
});
