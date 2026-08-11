import { test } from 'node:test';
test('DEPTH3 must fail loudly', () => { throw new Error('DEPTH3 RAN AND FAILED'); });
