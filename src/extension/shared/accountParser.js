/** Universal account format parser.
 *  Shared by Extension Host and Webview so previews match real imports. */
export function parseAccounts(text = '') {
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
