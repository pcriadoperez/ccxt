import { test } from 'node:test';
import assert from 'node:assert/strict';

// safeCompare() and resolveApiKey() used to be tested here. Both are gone: constant-time
// comparison is now a structural property of the store's hash-then-Map.get lookup (asserted by
// operation count in keyStore.test.ts, which a timing test could never prove), and the dev/env key
// fallbacks moved into the store's synthetic-record bridges and are covered there.
import { extractApiKey, isPublicPath } from './auth.js';

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

test('isPublicPath allowlists only the two probe paths', () => {
    assert.equal(isPublicPath('/health'), true);
    assert.equal(isPublicPath('/ready'), true);
    assert.equal(isPublicPath('/symbols'), false);
    assert.equal(isPublicPath('/exchanges/status'), false);
    assert.equal(isPublicPath('/route'), false);
});

test('isPublicPath ignores the query string rather than matching on it', () => {
    assert.equal(isPublicPath('/health?probe=1'), true);
    // A protected path must not become public by appending a query that mentions /health.
    assert.equal(isPublicPath('/symbols?redirect=/health'), false);
});
