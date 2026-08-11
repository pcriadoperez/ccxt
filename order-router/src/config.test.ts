import { test } from 'node:test';
test('DEPTH1 must fail loudly', () => { throw new Error('DEPTH1 RAN AND FAILED'); });
