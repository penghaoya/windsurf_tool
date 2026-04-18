import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAccounts } from '../src/extension/shared/accountParser.js';

test('parseAccounts supports seller label pairs', () => {
  const parsed = parseAccounts(`
卡号1: one@example.com
卡密1: pass-one
卡号2: two@example.com
卡密2: pass-two
`);

  assert.deepEqual(parsed, [
    { email: 'one@example.com', password: 'pass-one' },
    { email: 'two@example.com', password: 'pass-two' },
  ]);
});

test('parseAccounts supports compact delimiter formats', () => {
  const parsed = parseAccounts(`
alpha@example.com----alpha-pass
beta@example.com:beta-pass
`);

  assert.deepEqual(parsed, [
    { email: 'alpha@example.com', password: 'alpha-pass' },
    { email: 'beta@example.com', password: 'beta-pass' },
  ]);
});
