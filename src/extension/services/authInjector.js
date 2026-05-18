import vscode from 'vscode';
import fs from 'fs';
import {
  dbDeleteKey,
  dbReadKey,
  dbTransaction,
  dbUpdateKeys,
  getStateDbPath,
} from '../infra/sqlite.js';
import { hotVerifyWithRetry, generateFingerprint, applyFingerprint } from './fingerprint.js';
import { S, _logInfo, _logWarn } from '../core/state.js';

export function createAuthInjector({ refreshOne, updatePoolBar }) {
  async function discoverAuthCommand() {
    if (S.discoveredAuthCmd) return S.discoveredAuthCmd;
    const allCommands = await vscode.commands.getCommands(true);
    const candidates = [
      ...allCommands.filter(
        (command) =>
          /provideAuthToken.*AuthProvider/i.test(command) &&
          !/Shit/i.test(command),
      ),
      ...allCommands.filter((command) =>
        /provideAuthToken.*Shit/i.test(command),
      ),
      ...allCommands.filter(
        (command) =>
          /windsurf/i.test(command) &&
          /auth/i.test(command) &&
          /token/i.test(command) &&
          command !== 'windsurf.loginWithAuthToken',
      ),
    ];
    const seen = new Set();
    const unique = candidates.filter((command) => {
      if (seen.has(command)) return false;
      seen.add(command);
      return true;
    });
    _logInfo('认证', `发现${unique.length}个认证命令: [${unique.join(', ')}]`);
    if (unique.length > 0) S.discoveredAuthCmd = unique;
    return unique;
  }

  async function checkAccount(context, index) {
    const account = S.am.get(index);
    if (!account) return { ok: false };

    const result = await refreshOne(index);
    S.activeIndex = index;
    context.globalState.update('wam-current-index', index);
    updatePoolBar();
    return { ok: true, credits: result.credits, usageInfo: result.usageInfo };
  }

  async function injectAuth(context, index) {
    const account = S.am.get(index);
    if (!account) return { ok: false };

    const config = vscode.workspace.getConfiguration('wam');
    if (config.get('rotateFingerprint', true)) {
      const alwaysFresh = config.get('alwaysFreshFingerprint', true);
      const fpResult = applyAccountFingerprintForSwitch(index, { forceFresh: alwaysFresh });
      // v20.3: 日志合并 — 原 3 行 (state.vscdb同步 + 已恢复 + 热重置#N) 压缩为 1 行
      // v20.2 (方案B): skipped 时不计数热重置、不 jitter、不 hotVerify
      if (fpResult?.ok && fpResult.skipped) {
        _logInfo('指纹', `#${index + 1} ${fpResult.shortId} 已一致 → 跳过写入`);
      } else if (fpResult?.ok) {
        S.hotResetCount++;
        const action = fpResult.isNew ? '生成' : (fpResult.forced ? '强制刷新' : '恢复');
        const sync = fpResult.vscdbSynced ? '+vscdb' : '';
        _logInfo('指纹', `#${index + 1} ${fpResult.shortId} ${action}${sync} (热重置#${S.hotResetCount})`);
        // v18.0: 随机延迟 200-2200ms, 降低时序规律性
        const jitter = 200 + Math.floor(Math.random() * 2000);
        await new Promise((resolve) => setTimeout(resolve, jitter));
      }
    }

    let injected = false;
    let method = 'none';
    let providerHint = null;
    const discoveredCommands = await discoverAuthCommand();

    // v23.4: Devin-only injection chain.
    // Post-2026-05-04 the only viable login path is:
    //   Auth1 password/login → WindsurfPostAuth → sessionToken (devin-session-token$xxx)
    // The sessionToken doubles as the IDE apiKey (the cascade gRPC backend
    // accepts it verbatim — see WindsurfAPI v2.0.90+ for the reverse-engineering
    // proof). RegisterUser only takes firebase id_token (which we can no
    // longer obtain since App Check enforcement) so the old S2 register_user
    // fallback is dead and removed. GetOneTimeAuthToken (S1) is also dead.
    //
    // Single chain now:
    //   1. login() → idToken (= sessionToken when provider=devin-auth)
    //   2. S0: provideAuthTokenToAuthProvider(idToken) via discovered commands
    //   3. S1 (fallback): direct state.vscdb write with the same token
    try {
      const loginResult = await S.auth.login(
        account.email,
        account.password,
        false,
      );
      providerHint = loginResult?.provider || loginResult?.channel || null;
      // Drop the legacy getFreshIdToken second attempt — when login() fails
      // here it has already exhausted devin-auth + firebase, retrying with
      // forceFresh=true just doubles the noise without changing the outcome.
      const idToken = loginResult?.ok ? loginResult.idToken : null;
      if (idToken) {
        try {
          const result = await vscode.commands.executeCommand(
            'windsurf.provideAuthTokenToAuthProvider',
            idToken,
          );
          if (result && result.error) {
            _logWarn('注入', `[S0] 命令返回错误: ${JSON.stringify(result.error)}`);
          } else {
            injected = true;
            method = 'S0-provideAuth-idToken';
            _logInfo(
              '注入',
              `[S0] 已注入idToken → 会话: ${result?.session?.account?.label || '未知'}`,
            );
          }
        } catch (error) {
          _logWarn('注入', `[S0] 主命令失败: ${error.message}`);
        }
        if (!injected) {
          for (const command of discoveredCommands || []) {
            if (injected) break;
            try {
              const result = await vscode.commands.executeCommand(
                command,
                idToken,
              );
              if (result && result.error) {
                _logWarn(
                  '注入',
                  `[S0-发现] ${command} 返回错误: ${JSON.stringify(result.error)}`,
                );
              } else {
                injected = true;
                method = `S0-${command}-idToken`;
                _logInfo('注入', `[S0-发现] 已通过${command}注入idToken`);
              }
            } catch {}
          }
        }
        // S1 DB-direct fallback — write the same sessionToken into
        // windsurfAuthStatus.apiKey. The cascade backend accepts it directly
        // (WindsurfAPI v2.0.89 probe matrix: 4/4 200 OK on GetUserStatus).
        if (!injected) {
          const dbResult = dbInjectApiKey(idToken);
          if (dbResult.ok) {
            injected = true;
            method = 'S1-db-inject';
            _logInfo(
              '注入',
              `[S1] DB直写sessionToken: ${dbResult.oldPrefix}→${dbResult.newPrefix}`,
            );
            // v23.0+: persist for next refresh's fast-path (same key as
            // windsurf-injected apiKey, just bypassed the IDE command).
            const source = providerHint === 'devin-auth' ? 'devin_auth' : 'login_chain';
            S.am.setApiKey?.(index, idToken, source);
            setTimeout(async () => {
              const reload = await vscode.window.showInformationMessage(
                'WAM: 账号已切换(DB注入)。需要重新加载窗口使新账号生效。',
                '立即重载',
                '稍后',
              );
              if (reload === '立即重载') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
              }
            }, 500);
          } else {
            _logWarn('注入', `[S1] DB注入失败: ${dbResult.error}`);
          }
        }
      } else {
        _logWarn('注入', `[S0] 无可用 idToken (login failed for #${index + 1})`);
      }
    } catch (error) {
      _logWarn('注入', '注入链异常', error.message);
    }

    if (injected) {
      await postInjectionRefresh();
    }

    return { ok: injected, injected, method };
  }

  async function loginToAccount(context, index) {
    const account = S.am.get(index);
    if (!account) return { ok: false, injected: false, method: 'missing_account' };

    const apiKeyBefore = readAuthApiKeyPrefix();
    const injectResult = await injectAuth(context, index);

    if (injectResult.injected) {
      const changed = await waitForApiKeyChange(apiKeyBefore, 2000);
      _logInfo(
        '登录',
        `✅ ${injectResult.method} → #${index + 1} | apiKey ${changed ? '已更新' : '未变'}`,
      );
      // v23.0: persist full apiKey for GetUserStatus fast-path (covers S0/S1/S2/S3 paths)
      try {
        const fullKey = readAuthApiKeyFull();
        if (fullKey && S.am.setApiKey) {
          S.am.setApiKey(index, fullKey, 'windsurf_inject');
        }
      } catch {}
    }

    updatePoolBar();
    return injectResult;
  }

  async function waitForApiKeyChange(oldPrefix, maxWaitMs = 2000) {
    const interval = 200;
    const maxAttempts = Math.ceil(maxWaitMs / interval);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      if (readAuthApiKeyPrefix() !== oldPrefix) return true;
    }
    return false;
  }

  async function postInjectionRefresh() {
    try {
      clearCachedPlanInfo();
      await Promise.allSettled([
        vscode.commands.executeCommand('windsurf.updatePlanInfo').catch(() => {}),
        vscode.commands
          .executeCommand('windsurf.refreshAuthenticationSession')
          .catch(() => {}),
      ]);
      _logInfo('注入后刷新', '已并行刷新PlanInfo+认证会话');
      await new Promise((resolve) => setTimeout(resolve, 500));

      const newApiKey = readAuthApiKeyPrefix();
      _logInfo(
        '注入后刷新',
        `刷新后apiKey: ${newApiKey?.slice(0, 16) || '未知'}`,
      );

      // v20.2 (方案B): skipped=true 时本次未实际写入磁盘，hotVerify 无意义
      // v23.5: switched to hotVerifyWithRetry — VS Code's built-in telemetry
      // service occasionally rewrites our IDs ~1-2s after we apply them, so
      // a one-shot verify silently misses the breakage. The retrying variant
      // re-applies up to 2 times before giving up, self-healing the binding.
      if (S.lastRotatedIds && !S.lastRotatedIdsSkipped) {
        setTimeout(async () => {
          try {
            const verify = await hotVerifyWithRetry(S.lastRotatedIds);
            if (verify.verified) {
              S.hotResetVerified++;
              const tail = verify.attempts > 1 ? ` (重试${verify.attempts - 1}次后生效)` : '';
              _logInfo(
                '热重置',
                `✅ 验证成功 (#${S.hotResetVerified}/${S.hotResetCount})${tail}`,
              );
            } else {
              _logWarn(
                '热重置',
                `⚠ 验证失败 (重试${verify.attempts - 1}次仍 mismatch): ${verify.mismatches.join(' | ')}`,
              );
            }
          } catch {}
        }, 3000);
      }
    } catch (error) {
      _logWarn('注入后刷新', '刷新序列异常(非关键)', error.message);
    }
  }

  function clearCachedPlanInfo() {
    try {
      const dbPath = getStateDbPath();
      if (!fs.existsSync(dbPath)) return;
      if (dbDeleteKey(dbPath, 'windsurf.settings.cachedPlanInfo')) {
        _logInfo('缓存', '已清除state.vscdb中的cachedPlanInfo');
      } else {
        _logWarn('缓存', '缓存清除跳过(非关键)');
      }
    } catch (error) {
      _logWarn('缓存', '清除cachedPlanInfo异常', error.message);
    }
  }

  function dbInjectApiKey(newApiKey) {
    try {
      const dbPath = getStateDbPath();
      if (!fs.existsSync(dbPath)) {
        return { ok: false, error: 'state.vscdb not found' };
      }
      const currentJson = dbReadKey(dbPath, 'windsurfAuthStatus');
      if (!currentJson) {
        return { ok: false, error: 'windsurfAuthStatus not found' };
      }

      const data = JSON.parse(currentJson);
      const oldPrefix = (data.apiKey || '').substring(0, 20);
      data.apiKey = newApiKey;

      const ok = dbTransaction(dbPath, [
        { type: 'write', key: 'windsurfAuthStatus', value: JSON.stringify(data) },
        { type: 'delete', key: 'windsurf.settings.cachedPlanInfo' },
      ]);
      if (!ok) return { ok: false, error: 'write failed' };

      const newPrefix = newApiKey.substring(0, 20);
      _logInfo('数据库', `apiKey更新: ${oldPrefix}→${newPrefix}`);
      return { ok: true, oldPrefix, newPrefix };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  function readAuthApiKeyPrefix() {
    try {
      const dbPath = getStateDbPath();
      if (!fs.existsSync(dbPath)) return null;
      const raw = dbReadKey(dbPath, 'windsurfAuthStatus');
      if (!raw) return null;
      const data = JSON.parse(raw);
      return (data.apiKey || '').substring(0, 20) || null;
    } catch {
      return null;
    }
  }

  // v23.0: full apiKey reader — used to persist windsurf-injected key per account
  function readAuthApiKeyFull() {
    try {
      const dbPath = getStateDbPath();
      if (!fs.existsSync(dbPath)) return null;
      const raw = dbReadKey(dbPath, 'windsurfAuthStatus');
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data.apiKey || null;
    } catch {
      return null;
    }
  }

  /** v18.0: Per-Account 指纹绑定 — 每个账号始终看到同一台"设备"
   *  首次使用 → 生成并保存专属指纹
   *  后续切换 → 恢复已保存的指纹 (不生成新的)
   *  解决: 同一账号从大量不同"设备"登录的封控风险
   *
   *  v22.x: forceFresh=true 时每次切号强制生成新指纹并覆盖缓存
   *  (适用场景: 当前账号被关联或风控时通过新指纹"破链") */
  function applyAccountFingerprintForSwitch(targetIndex, opts = {}) {
    const { forceFresh = false } = opts;
    // v20.3: 静默 apply — 日志合并到 injectAuth 的单行输出
    try {
      let fp = S.am.getFingerprint(targetIndex);
      const isNew = !fp;
      const forced = forceFresh && !isNew;  // forced 仅当原本有缓存被覆盖时为真
      if (!fp || forceFresh) {
        fp = generateFingerprint();
        S.am.setFingerprint(targetIndex, fp);
      }

      const result = applyFingerprint(fp);
      if (!result.ok) {
        _logWarn('\u6307\u7eb9', `\u5e94\u7528\u5931\u8d25: ${result.error}`);
        return { ok: false };
      }

      const id = fp['storage.serviceMachineId']?.slice(0, 8) || '?';
      // v20.2 (方案B): 磁盘已是目标状态 → 跳过 state.vscdb 同步
      if (result.skipped) {
        S.lastRotatedIds = fp;
        S.lastRotatedIdsSkipped = true;
        return { ok: true, skipped: true, isNew, forced, shortId: id };
      }

      // Sync to state.vscdb
      let vscdbSynced = false;
      const dbPath = getStateDbPath();
      if (fs.existsSync(dbPath)) {
        const pairs = [
          'storage.serviceMachineId',
          'telemetry.devDeviceId',
          'telemetry.machineId',
          'telemetry.macMachineId',
          'telemetry.sqmId',
        ]
          .filter((key) => fp[key])
          .map((key) => ({ key, value: fp[key] }));

        if (pairs.length > 0) {
          try {
            vscdbSynced = !!dbUpdateKeys(dbPath, pairs);
          } catch (error) {
            _logWarn('\u6307\u7eb9', 'state.vscdb\u540c\u6b65\u5931\u8d25(\u975e\u5173\u952e)', error.message);
          }
        }
      }

      S.lastRotatedIds = fp;
      S.lastRotatedIdsSkipped = false;
      return { ok: true, skipped: false, isNew, forced, shortId: id, vscdbSynced };
    } catch (error) {
      _logWarn('\u6307\u7eb9', '\u6307\u7eb9\u5e94\u7528\u5f02\u5e38(\u975e\u5173\u952e)', error.message);
      return { ok: false };
    }
  }

  return {
    injectAuth,
    _checkAccount: checkAccount,
    _loginToAccount: loginToAccount,
  };
}
