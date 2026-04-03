import vscode from 'vscode';
import fs from 'fs';
import path from 'path';
import {
  dbDeleteKey,
  dbReadKey,
  dbTransaction,
  dbUpdateKeys,
  getStateDbPath,
} from '../infra/sqlite.js';
import { hotVerify, generateFingerprint, applyFingerprint } from './fingerprint.js';
import { S, _logError, _logInfo, _logWarn } from '../core/state.js';
import { _getWindsurfGlobalStoragePath } from '../core/window.js';

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
      applyAccountFingerprintForSwitch(index);
      S.hotResetCount++;
      _logInfo('热重置', `指纹已应用 (第${S.hotResetCount}次)`);
      // v18.0: 随机延迟 200-2200ms, 降低时序规律性
      const jitter = 200 + Math.floor(Math.random() * 2000);
      await new Promise((resolve) => setTimeout(resolve, jitter));
    }

    let injected = false;
    let method = 'none';
    const discoveredCommands = await discoverAuthCommand();

    try {
      const loginResult = await S.auth.login(
        account.email,
        account.password,
        false,
      );
      const idToken = loginResult?.ok
        ? loginResult.idToken
        : await S.auth.getFreshIdToken(account.email, account.password);
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
      }
    } catch (error) {
      _logWarn('注入', '[S0] idToken注入失败', error.message);
    }

    if (!injected) {
      try {
        const authToken = await S.auth.getOneTimeAuthToken(
          account.email,
          account.password,
        );
        if (authToken && authToken.length >= 30 && authToken.length <= 200) {
          try {
            await vscode.commands.executeCommand(
              'windsurf.provideAuthTokenToAuthProvider',
              authToken,
            );
            injected = true;
            method = 'S1-provideAuth-otat';
            _logInfo('注入', '[S1] 已注入OneTimeAuthToken');
          } catch {}
          if (!injected) {
            for (const command of discoveredCommands || []) {
              if (injected) break;
              try {
                await vscode.commands.executeCommand(command, authToken);
                injected = true;
                method = `S1-${command}-otat`;
                _logInfo('注入', `[S1-发现] 已通过${command}注入OneTimeAuthToken`);
              } catch {}
            }
          }
          if (injected) writeAuthFilesCompat(authToken);
        }
      } catch (error) {
        _logWarn('注入', '[S1] OneTimeAuthToken降级失败', error.message);
      }
    }

    if (!injected) {
      try {
        const regResult = await S.auth.registerUser(
          account.email,
          account.password,
        );
        if (regResult && regResult.apiKey) {
          for (const command of discoveredCommands || []) {
            if (injected) break;
            try {
              await vscode.commands.executeCommand(command, regResult.apiKey);
              injected = true;
              method = `S2-${command}-apiKey`;
              _logInfo('注入', `[S2] 已通过${command}注入apiKey`);
            } catch (error) {
              _logError('注入', `[S2] ${command}失败`, error.message);
            }
          }
          if (!injected) {
            const dbResult = dbInjectApiKey(regResult.apiKey);
            if (dbResult.ok) {
              injected = true;
              method = 'S3-db-inject';
              _logInfo(
                '注入',
                `[S3] DB直写: ${dbResult.oldPrefix}→${dbResult.newPrefix}`,
              );
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
              _logWarn('注入', `[S3] DB注入失败: ${dbResult.error}`);
            }
          }
        }
      } catch (error) {
        _logWarn('注入', '[S2/S3] registerUser+DB降级失败', error.message);
      }
    }

    if (injected) {
      await postInjectionRefresh();
    }

    return { ok: injected, injected, method };
  }

  async function loginToAccount(context, index) {
    const account = S.am.get(index);
    if (!account) return;

    S.activeIndex = index;
    context.globalState.update('wam-current-index', index);

    const apiKeyBefore = readAuthApiKeyPrefix();
    const injectResult = await injectAuth(context, index);

    if (injectResult.injected) {
      const changed = await waitForApiKeyChange(apiKeyBefore, 2000);
      _logInfo(
        '登录',
        `✅ ${injectResult.method} → #${index + 1} | apiKey ${changed ? '已更新' : '未变'}`,
      );
    }

    S.am.incrementLoginCount(index);
    updatePoolBar();
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

  function writeAuthFilesCompat(authToken) {
    if (!authToken || authToken.length < 30 || authToken.length > 60) return;
    try {
      const globalStoragePath = _getWindsurfGlobalStoragePath();
      if (!fs.existsSync(globalStoragePath)) return;
      const authData = JSON.stringify(
        {
          authToken,
          token: authToken,
          api_key: authToken,
          timestamp: Date.now(),
        },
        null,
        2,
      );
      fs.writeFileSync(
        path.join(globalStoragePath, 'windsurf-auth.json'),
        authData,
        'utf8',
      );
      fs.writeFileSync(
        path.join(globalStoragePath, 'cascade-auth.json'),
        authData,
        'utf8',
      );
      _logInfo('认证', '认证文件已写入(跨扩展兼容)');
    } catch (error) {
      _logWarn('认证', '认证文件写入跳过', error.message);
    }
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

      if (S.lastRotatedIds) {
        setTimeout(() => {
          try {
            const verify = hotVerify(S.lastRotatedIds);
            if (verify.verified) {
              S.hotResetVerified++;
              _logInfo(
                '热重置',
                `✅ 验证成功 (#${S.hotResetVerified}/${S.hotResetCount})`,
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

  /** v18.0: Per-Account 指纹绑定 — 每个账号始终看到同一台"设备"
   *  首次使用 → 生成并保存专属指纹
   *  后续切换 → 恢复已保存的指纹 (不生成新的)
   *  解决: 同一账号从大量不同"设备"登录的封控风险 */
  function applyAccountFingerprintForSwitch(targetIndex) {
    try {
      let fp = S.am.getFingerprint(targetIndex);
      const isNew = !fp;
      if (!fp) {
        fp = generateFingerprint();
        S.am.setFingerprint(targetIndex, fp);
      }

      const result = applyFingerprint(fp);
      if (!result.ok) {
        _logWarn('\u6307\u7eb9', `\u5e94\u7528\u5931\u8d25: ${result.error}`);
        return;
      }

      // Sync to state.vscdb
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
            if (dbUpdateKeys(dbPath, pairs)) {
              _logInfo('\u6307\u7eb9', 'state.vscdb\u5df2\u540c\u6b65');
            }
          } catch (error) {
            _logWarn('\u6307\u7eb9', 'state.vscdb\u540c\u6b65\u8df3\u8fc7(\u975e\u5173\u952e)', error.message);
          }
        }
      }

      S.lastRotatedIds = fp;
      const id = fp['storage.serviceMachineId']?.slice(0, 8) || '?';
      _logInfo('\u6307\u7eb9', `${isNew ? '\u5df2\u751f\u6210\u5e76\u4fdd\u5b58' : '\u5df2\u6062\u590d'} #${targetIndex + 1} \u4e13\u5c5e\u6307\u7eb9: ${id}`);
    } catch (error) {
      _logWarn('\u6307\u7eb9', '\u6307\u7eb9\u5e94\u7528\u5f02\u5e38(\u975e\u5173\u952e)', error.message);
    }
  }

  return {
    injectAuth,
    _checkAccount: checkAccount,
    _loginToAccount: loginToAccount,
  };
}
