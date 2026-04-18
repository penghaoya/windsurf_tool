import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountManager } from '../src/extension/services/account.js';
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

test('AccountManager onChange disposer removes listener', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-account-'));
  const am = new AccountManager(dir, { isolated: true });
  try {
    let calls = 0;
    const dispose = am.onChange(() => { calls++; });

    assert.equal(am.add('first@example.com', 'first-pass'), true);
    assert.equal(calls, 1);

    dispose();
    assert.equal(am.add('second@example.com', 'second-pass'), true);
    assert.equal(calls, 1);
  } finally {
    am.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
