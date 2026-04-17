import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { safeReadJsonSync, safeWriteJsonSync } from '../src/extension/infra/safeJson.js';

test('safeWriteJsonSync writes atomically and keeps a backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-safe-json-'));
  const filePath = path.join(dir, 'accounts.json');

  safeWriteJsonSync(filePath, [{ email: 'a@test.com' }]);
  safeWriteJsonSync(filePath, [{ email: 'b@test.com' }]);

  assert.deepEqual(safeReadJsonSync(filePath), [{ email: 'b@test.com' }]);
  assert.deepEqual(safeReadJsonSync(`${filePath}.bak`), [{ email: 'a@test.com' }]);
});

test('safeReadJsonSync falls back to backup when main JSON is corrupted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-safe-json-'));
  const filePath = path.join(dir, 'accounts.json');

  safeWriteJsonSync(filePath, { ok: true });
  safeWriteJsonSync(filePath, { ok: false });
  fs.writeFileSync(filePath, '{bad json', 'utf8');

  assert.deepEqual(safeReadJsonSync(filePath), { ok: true });
});
