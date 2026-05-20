/**
 * OAuth Browser Authorization Service (v25.0)
 * Adapted from windsurf-pool-7.7.0 windsurfOAuthService.js
 *
 * Supports Google/SSO accounts that have no password set.
 * Flow: local HTTP callback server → browser sign-in → Firebase idToken → RegisterUser → apiKey
 *
 * Unlike signInWithPassword (blocked by App Check since 2026-05-04), the browser
 * handles App Check attestation internally, so the returned Firebase idToken is valid.
 */
import crypto from 'crypto';
import http from 'http';
import vscode from 'vscode';

const WINDSURF_AUTH_BASE_URL = 'https://www.windsurf.com';
const WINDSURF_REGISTER_URL = 'https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser';
const WINDSURF_DEFAULT_API_SERVER_URL = 'https://server.codeium.com';
const WINDSURF_CLIENT_ID = '3GUryQ7ldAeKEuD2obYnppsnmj58eP5u';
const OAUTH_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

let _info = (tag, msg) => console.log(`WAM: [${tag}] ${msg}`);
let _warn = (tag, msg) => console.log(`WAM: [WARN][${tag}] ${msg}`);

export function setOAuthLogger(info, warn) {
  if (info) _info = info;
  if (warn) _warn = warn;
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function pickString(obj, keys) {
  for (const key of keys) {
    const v = obj?.[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return '';
}

function buildAuthUrl(redirectUri, state) {
  const params = new URLSearchParams();
  params.set('response_type', 'token');
  params.set('client_id', WINDSURF_CLIENT_ID);
  params.set('redirect_uri', redirectUri);
  params.set('state', state);
  params.set('prompt', 'login');
  params.set('redirect_parameters_type', 'query');
  params.set('workflow', 'onboarding');
  return `${WINDSURF_AUTH_BASE_URL}/windsurf/signin?${params.toString()}`;
}

function successHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Windsurf 授权成功</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0}.box{max-width:460px;padding:24px;border-radius:12px;background:#111827;border:1px solid #1f2937;text-align:center}h1{color:#22c55e;margin:0 0 10px;font-size:24px}p{margin:0;opacity:.9}</style></head>
<body><div class="box"><h1>授权成功</h1><p>可以关闭此页面，返回 Windsurf 号池管理。</p></div></body></html>`;
}

function failHtml(message) {
  const escaped = message.replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch] || ch));
  return `<!doctype html><html><head><meta charset="utf-8"><title>Windsurf 授权失败</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0}.box{max-width:520px;padding:24px;border-radius:12px;background:#111827;border:1px solid #1f2937;text-align:center}h1{color:#ef4444;margin:0 0 10px;font-size:24px}p{margin:0;opacity:.9;word-break:break-word}</style></head>
<body><div class="box"><h1>授权失败</h1><p>${escaped}</p></div></body></html>`;
}

/**
 * HTTPS POST (standalone, no proxy — OAuth exchange is one-shot)
 */
function httpsPost(url, body, headers = {}) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => resolve({ status: res.statusCode || 0, body: buf }));
    });
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function createOAuthCallbackServer() {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(24).toString('base64url');
    let server = null;
    let timer = null;
    let tokenResolve = null;
    let tokenReject = null;
    const tokenPromise = new Promise((res, rej) => {
      tokenResolve = res;
      tokenReject = rej;
    });

    const close = () => {
      if (timer) clearTimeout(timer);
      try { server?.close(); } catch {}
    };

    const finish = (err, accessToken) => {
      close();
      if (err) tokenReject?.(err);
      else tokenResolve?.(accessToken || '');
    };

    server = http.createServer((req, res) => {
      const host = req.headers.host || '127.0.0.1';
      const url = new URL(req.url || '/', `http://${host}`);
      if (url.pathname !== '/windsurf-auth-callback') {
        res.writeHead(404); res.end('Not Found');
        return;
      }
      const gotState = url.searchParams.get('state') || '';
      const error = url.searchParams.get('error') || '';
      const errorDescription = url.searchParams.get('error_description') || '';
      const accessToken = url.searchParams.get('access_token') || '';

      if (gotState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(failHtml('state 校验失败，请重新授权。'));
        finish(new Error('OAuth state 校验失败'));
        return;
      }
      if (error) {
        const message = errorDescription ? `${error} (${errorDescription})` : error;
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(failHtml(message));
        finish(new Error(`授权失败: ${message}`));
        return;
      }
      if (!accessToken.trim()) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(failHtml('回调缺少 access_token，请重新授权。'));
        finish(new Error('回调缺少 access_token'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(successHtml());
      finish(undefined, accessToken);
    });

    server.on('error', err => finish(err instanceof Error ? err : new Error(String(err))));
    server.listen(0, '127.0.0.1', () => {
      const addr = server?.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('读取本地 OAuth 回调端口失败'));
        return;
      }
      const callbackUrl = `http://127.0.0.1:${addr.port}/windsurf-auth-callback`;
      const authUrl = buildAuthUrl(callbackUrl, state);
      timer = setTimeout(() => finish(new Error('等待 Windsurf OAuth 授权超时')), OAUTH_TIMEOUT_MS);
      resolve({ authUrl, tokenPromise, close });
    });
  });
}

/**
 * Exchange Firebase idToken (from OAuth browser sign-in) for apiKey + email
 */
async function exchangeFirebaseToken(firebaseIdToken) {
  // Step 1: RegisterUser → apiKey
  const register = await httpsPost(
    WINDSURF_REGISTER_URL,
    { firebase_id_token: firebaseIdToken },
    { Accept: 'application/json', 'Connect-Protocol-Version': '1' },
  );
  if (register.status !== 200) {
    const msg = safeJsonParse(register.body)?.message || register.body.slice(0, 160);
    throw new Error(`RegisterUser 失败: HTTP ${register.status}${msg ? ' ' + msg : ''}`);
  }
  const rd = safeJsonParse(register.body);
  const apiKey = pickString(rd, ['apiKey', 'api_key']);
  const apiServerUrl = pickString(rd, ['apiServerUrl', 'api_server_url']) || WINDSURF_DEFAULT_API_SERVER_URL;
  const registerName = pickString(rd, ['name']);
  if (!apiKey) throw new Error('RegisterUser 响应缺少 apiKey');

  // Step 2: GetUserStatus → email
  const status = await httpsPost(
    `${apiServerUrl.replace(/\/$/, '')}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
    {
      metadata: {
        apiKey,
        ideName: 'windsurf',
        ideVersion: '1.0.0',
        extensionName: 'windsurf-next',
        extensionVersion: '1.0.0',
        locale: 'en',
      },
    },
    { Accept: 'application/json', 'Connect-Protocol-Version': '1' },
  );

  let email = '';
  let name = registerName;
  if (status.status === 200) {
    const sd = safeJsonParse(status.body);
    const user = sd?.userStatus || {};
    email = email || pickString(user, ['email', 'userName', 'username']);
    name = name || pickString(user, ['name', 'userName', 'username']);
  }
  if (!email) {
    throw new Error(`OAuth 已换取 apiKey，但 GetUserStatus 未返回邮箱 (HTTP ${status.status})`);
  }

  return { email, apiKey, apiServerUrl, name: name || email.split('@')[0] };
}

/**
 * Main entry: open browser → OAuth sign-in → return account data
 * Returns: { email, apiKey, apiServerUrl, name }
 * Throws on failure or user cancellation.
 */
export async function loginByWindsurfOAuth() {
  _info('OAuth', '启动浏览器授权流程...');
  const oauthState = await createOAuthCallbackServer();
  try {
    await vscode.env.openExternal(vscode.Uri.parse(oauthState.authUrl));
    _info('OAuth', '等待浏览器回调...');
    const accessToken = await oauthState.tokenPromise;
    if (!accessToken) throw new Error('OAuth 回调未返回 access_token');
    _info('OAuth', '收到 access_token，换取 apiKey...');
    const result = await exchangeFirebaseToken(accessToken);
    _info('OAuth', `授权成功: ${result.email}`);
    return result;
  } finally {
    oauthState.close();
  }
}
