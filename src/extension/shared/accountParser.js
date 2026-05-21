/** Universal account format parser.
 *  Shared by Extension Host and Webview so previews match real imports.
 *  v25.0: supports JSON objects/arrays with sessionToken (pre-authed accounts). */
export function parseAccounts(text = '') {
  // v25.0: Try JSON parse first — supports single object or array of objects
  const jsonResult = _tryParseJson(text);
  if (jsonResult.length > 0) return jsonResult;

  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
  const LABEL_EMAIL_RE = /^(?:卡号\d*|账号|邮箱|email|account|用户名?)\s*[:：\s]\s*(.+)/i;
  const LABEL_PASS_RE = /^(?:卡密\d*|密码|pass(?:word)?|pwd|口令)\s*[:：\s]\s*(.+)/i;
  const results = [];

  let pendingEmail = null;
  let usedLabelMode = false;
  for (const line of lines) {
    const em = line.match(LABEL_EMAIL_RE);
    if (em) {
      const val = em[1].trim();
      if (EMAIL_RE.test(val)) { pendingEmail = val; usedLabelMode = true; continue; }
    }
    const pm = line.match(LABEL_PASS_RE);
    if (pm && pendingEmail) {
      const pass = pm[1].trim();
      if (pass) { results.push({ email: pendingEmail, password: pass }); pendingEmail = null; continue; }
    }
    if (em) pendingEmail = null;
  }
  if (usedLabelMode && results.length > 0) return results;

  const DELIMITERS = ['----', ':', ';', '=', '\t', '|', ' / ', ' '];
  for (const line of lines) {
    let email, password, found = false;
    for (const delim of DELIMITERS) {
      const idx = line.indexOf(delim);
      if (idx < 0) continue;
      const left = line.substring(0, idx).trim();
      const right = line.substring(idx + delim.length).trim();
      if (left && right && EMAIL_RE.test(left)) {
        email = left; password = right; found = true; break;
      }
    }
    if (!found) continue;
    if (email && password && EMAIL_RE.test(email)) results.push({ email, password });
  }
  if (results.length > 0) return results;

  const emailLines = [], passLines = [];
  for (const line of lines) {
    const m = line.match(EMAIL_RE);
    if (m) {
      emailLines.push(m[0]);
    } else if (line.length >= 4 && !/^[-=\s*#]+$/.test(line) && !/^(质保|以下|全部|卡号|卡密|账号|密码|注意|说明|备注)/i.test(line)) {
      passLines.push(line);
    }
  }
  for (let i = 0; i < Math.min(emailLines.length, passLines.length); i++) {
    results.push({ email: emailLines[i], password: passLines[i] });
  }
  return results;
}

/** v25.0: Parse JSON account format — single object or array.
 *  Recognized fields: email, password, sessionToken, auth1Token, accountId, primaryOrgId.
 *  Returns enriched objects; downstream addBatch uses extra fields for apiKey/metadata. */
function _tryParseJson(text) {
  const trimmed = String(text).trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return [];
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return []; }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const results = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const email = (item.email || item.Email || '').trim();
    if (!email || !email.includes('@')) continue;
    const entry = {
      email,
      password: (item.password || item.Password || '').trim(),
    };
    // Carry pre-auth tokens so addBatch can persist them
    if (item.sessionToken) entry.sessionToken = item.sessionToken;
    if (item.auth1Token) entry.auth1Token = item.auth1Token;
    if (item.accountId) entry.accountId = item.accountId;
    if (item.primaryOrgId) entry.primaryOrgId = item.primaryOrgId;
    results.push(entry);
  }
  return results;
}
