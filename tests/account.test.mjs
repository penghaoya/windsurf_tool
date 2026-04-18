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

test('AccountManager onChange ignores lastChecked-only usage updates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-account-'));
  const am = new AccountManager(dir, { isolated: true });
  try {
    assert.equal(am.add('quota@example.com', 'quota-pass'), true);

    let calls = 0;
    am.onChange(() => { calls++; });

    const usage = {
      mode: 'quota',
      billingStrategy: 'quota',
      daily: { remaining: 80 },
      weekly: { remaining: 70 },
      plan: 'Trial',
      resetTime: 123,
      weeklyReset: 456,
    };

    am.updateUsage(0, usage);
    am.updateUsage(0, usage);

    assert.equal(calls, 1);
  } finally {
    am.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AccountManager updateUsage skips save when only lastChecked changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-account-'));
  const am = new AccountManager(dir, { isolated: true });
  try {
    assert.equal(am.add('fresh@example.com', 'fresh-pass'), true);

    let saves = 0;
    am._save = () => { saves++; };

    const usage = {
      mode: 'quota',
      billingStrategy: 'quota',
      daily: { remaining: 66 },
      weekly: { remaining: 55 },
      plan: 'Trial',
      resetTime: 111,
      weeklyReset: 222,
    };

    am.updateUsage(0, usage);
    const firstChecked = am.get(0).usage.lastChecked;
    await new Promise(resolve => setTimeout(resolve, 2));
    am.updateUsage(0, usage);

    assert.equal(saves, 1);
    assert.ok(am.get(0).usage.lastChecked > firstChecked);
  } finally {
    am.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AccountManager isRateLimited does not write while reading expired limits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-account-'));
  const am = new AccountManager(dir, { isolated: true });
  try {
    assert.equal(am.add('limited@example.com', 'limited-pass'), true);
    am._accounts[0].rateLimit = {
      until: Date.now() - 1000,
      resetsIn: 60,
      type: 'quota',
      model: null,
    };

    let saves = 0;
    am._save = () => { saves++; };

    assert.equal(am.isRateLimited(0), false);
    assert.ok(am._accounts[0].rateLimit);
    assert.equal(saves, 0);

    assert.deepEqual(am.sweepExpiredRateLimits(), { changed: true, saved: true });
    assert.equal(am._accounts[0].rateLimit, undefined);
    assert.equal(saves, 1);
  } finally {
    am.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AccountManager sweep removes recoverable message rate limits explicitly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-account-'));
  const am = new AccountManager(dir, { isolated: true });
  try {
    assert.equal(am.add('recover@example.com', 'recover-pass'), true);
    am.updateUsage(0, {
      mode: 'quota',
      billingStrategy: 'quota',
      daily: { remaining: 90 },
      weekly: { remaining: 90 },
      plan: 'Trial',
    });
    am._accounts[0].rateLimit = {
      until: Date.now() + 1000,
      resetsIn: 600,
      type: 'message_rate',
      model: null,
    };

    let saves = 0;
    am._save = () => { saves++; };

    assert.equal(am.isRateLimited(0), false);
    assert.ok(am._accounts[0].rateLimit);

    assert.deepEqual(am.sweepExpiredRateLimits(), { changed: true, saved: true });
    assert.equal(am._accounts[0].rateLimit, undefined);
    assert.equal(saves, 1);
  } finally {
    am.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
