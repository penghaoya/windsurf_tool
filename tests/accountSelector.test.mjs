import assert from 'node:assert/strict';
import test from 'node:test';
import { selectOptimal } from '../src/extension/services/accountSelector.js';

function createManager(accounts) {
  return {
    count: () => accounts.length,
    get: (index) => accounts[index] || null,
    isRateLimited: (index) => !!accounts[index]?.rateLimited,
    isExpired: (index) => !!accounts[index]?.expired,
    isModelRateLimited: (index, modelUid) => !!accounts[index]?.modelRateLimited?.includes(modelUid),
    effectiveRemaining: (index) => accounts[index]?.remaining ?? null,
    getDailyRemaining: (index) => accounts[index]?.daily ?? null,
    getPlanDaysRemaining: (index) => accounts[index]?.planDays ?? null,
    getExpiryUrgency: (index) => accounts[index]?.urgency ?? -1,
    effectiveResetTime: (index) => accounts[index]?.resetTime ?? null,
    getLastUsedTs: (index) => accounts[index]?.lastUsed ?? 0,
    getSelectionMode: (index) => accounts[index]?.mode ?? 'unknown',
  };
}

test('selectOptimal filters depleted daily quota even when effective quota is high', () => {
  const manager = createManager([
    { email: 'current@test.com', remaining: 20, daily: 20, mode: 'quota' },
    { email: 'daily-empty@test.com', remaining: 80, daily: 0, mode: 'quota' },
    { email: 'healthy@test.com', remaining: 40, daily: 40, mode: 'quota' },
  ]);

  const ordered = selectOptimal(manager, 0, 5);

  assert.deepEqual(ordered.map((c) => c.email), ['healthy@test.com']);
});

test('selectOptimal keeps preferred quota accounts before credits accounts', () => {
  const manager = createManager([
    { email: 'current@test.com', remaining: 10, daily: 10, mode: 'quota' },
    { email: 'credits@test.com', remaining: 90, mode: 'credits' },
    { email: 'quota@test.com', remaining: 40, daily: 40, mode: 'quota' },
  ]);

  const ordered = selectOptimal(manager, 0, 5, [], { preferredMode: 'quota' });

  assert.equal(ordered[0].email, 'quota@test.com');
});
