import fs from 'fs';
import path from 'path';

function _ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function safeReadJsonSync(filePath, fallback = undefined) {
  for (const p of [filePath, `${filePath}.bak`]) {
    try {
      if (!p || !fs.existsSync(p)) continue;
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {}
  }
  return fallback;
}

export function safeWriteJsonSync(filePath, data) {
  _ensureDir(filePath);
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const bakPath = `${filePath}.bak`;
  const json = JSON.stringify(data, null, 2);

  fs.writeFileSync(tmpPath, json, 'utf8');
  try {
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, bakPath);
  } catch {}
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }
}
