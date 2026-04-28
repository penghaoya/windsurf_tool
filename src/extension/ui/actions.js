import vscode from 'vscode';
import fs from 'fs';
import {
  S,
  schedulerState,
  _clearAccountQuarantine,
  _getAccountEmail,
  _getAccountQuarantineByEmail,
  _getPreemptiveThreshold,
  _isTrialLikeAccount,
  _getTrialPoolCooldown,
} from '../core/state.js';
import { _readCurrentModelUid } from '../core/model.js';
import {
  _doPoolRotate,
  _performSwitch,
  _seamlessSwitch,
} from '../core/scheduler.js';
import { _syncSchedulerToShared } from '../core/window.js';
import { readFingerprint, generateFingerprint, applyFingerprint, hotVerify } from '../services/fingerprint.js';
import { dbUpdateKeys, getStateDbPath } from '../infra/sqlite.js';

export function createActionHandler(helpers) {
  const {
    refreshOne,
    updatePoolBar,
    refreshPanel,
    doExport,
    doImport,
    doResetFingerprint,
    doBatchAdd,
  } = helpers;

  return function handleAction(context, action, arg) {
    switch (action) {
      case 'login':
        return _seamlessSwitch(context, arg, 'manual_login');
      case 'checkAccount':
        return helpers.checkAccount(context, arg);
      case 'explicitSwitch':
        return _seamlessSwitch(context, arg, 'manual_explicit');
      case 'refreshAll':
        return helpers.doRefreshPool(context);
      case 'refreshOne':
        return refreshOne(arg).then(() => {
          updatePoolBar();
          refreshPanel();
        });
      case 'clearRateLimit':
        if (arg !== undefined) {
          S.am.clearRateLimit(arg);
          _clearAccountQuarantine(arg);
          schedulerState.poolCooldowns.clear();
          _syncSchedulerToShared();
          S.downgradeLockUntil = 0;
          S.lastTrialPoolCooldownFailTs = 0;
          updatePoolBar();
          refreshPanel();
        }
        return undefined;
      case 'getCurrentIndex':
        return S.activeIndex;
      case 'getProxyStatus':
        return S.auth ? S.auth.getProxyStatus() : { mode: '?', port: 0 };
      case 'getPoolStats':
        return S.am.getPoolStats(_getPreemptiveThreshold());
      case 'getActiveQuota':
        return S.am.getActiveQuota(S.activeIndex);
      case 'getSwitchCount':
        return S.switchCount;
      case 'getSwitchStatus':
        return S.switchStatus || null;
      case 'showLogs':
        S.outputChannel?.show(true);
        return undefined;
      case 'getAccountBlocked': {
        if (arg === undefined || arg === null) return null;
        const quarantine = _getAccountQuarantineByEmail(_getAccountEmail(arg));
        const modelUid = S.currentModelUid || _readCurrentModelUid();
        const poolCooldown = _isTrialLikeAccount(arg)
          ? _getTrialPoolCooldown(modelUid)
          : null;
        if (!quarantine && !poolCooldown) return null;
        return {
          quarantined: quarantine
            ? { until: quarantine.until, reason: quarantine.reason || null }
            : null,
          poolCooled: poolCooldown
            ? { until: poolCooldown.until, reason: poolCooldown.reason || null }
            : null,
        };
      }
      case 'setMode':
        if (S.auth && arg) {
          S.auth.setMode(arg);
          context.globalState.update('wam-proxy-mode', arg);
          updatePoolBar();
          refreshPanel();
        }
        return undefined;
      case 'setProxyPort':
        if (S.auth && arg) {
          S.auth.setPort(arg);
          context.globalState.update('wam-proxy-mode', 'local');
          updatePoolBar();
          refreshPanel();
        }
        return undefined;
      case 'reprobeProxy':
        if (S.auth) {
          return S.auth.reprobeProxy().then((result) => {
            context.globalState.update('wam-proxy-mode', result.mode);
            updatePoolBar();
            refreshPanel();
            return result;
          });
        }
        return undefined;
      case 'exportAccounts':
        return doExport(context);
      case 'importAccounts':
        return doImport(context);
      case 'resetFingerprint':
        return doResetFingerprint();
      case 'resetAccountFingerprint':
        return resetAccountFingerprint(arg, { updatePoolBar, refreshPanel });
      case 'panicSwitch':
        return _doPoolRotate(context, true);
      case 'batchAdd':
        return doBatchAdd(arg);
      case 'refreshAllAndRotate':
        return helpers.doRefreshPool(context);
      case 'getFingerprint':
        return readFingerprint();
      case 'smartRotate':
        return _doPoolRotate(context);
      case 'setAutoRotate':
        if (arg !== undefined) {
          return vscode.workspace
            .getConfiguration('wam')
            .update('autoRotate', !!arg, true);
        }
        return undefined;
      case 'setCreditThreshold':
      case 'setPreemptiveThreshold':
        if (arg !== undefined) {
          const next = Math.max(0, Math.min(100, Number(arg) || 0));
          return vscode.workspace
            .getConfiguration('wam')
            .update('preemptiveThreshold', next, true)
            .then(() => {
              updatePoolBar();
              refreshPanel();
            });
        }
        return undefined;
      default:
        return undefined;
    }
  };
}

function resetAccountFingerprint(index = S.activeIndex, hooks = {}) {
  if (!S.am) return { ok: false, error: 'account_manager_missing' };
  if (!Number.isInteger(index) || index < 0 || index >= S.am.count()) {
    return { ok: false, error: 'invalid_account' };
  }
  if (index !== S.activeIndex) {
    return { ok: false, error: 'only_active_account_supported' };
  }

  const account = S.am.get(index);
  if (!account) return { ok: false, error: 'account_missing' };

  const fp = generateFingerprint();
  const applied = applyFingerprint(fp);
  if (!applied.ok) return { ok: false, error: applied.error || 'apply_failed' };

  S.am.setFingerprint(index, fp);
  syncFingerprintToStateDb(fp);
  S.lastRotatedIds = fp;
  S.hotResetCount++;

  const verify = hotVerify(fp);
  if (verify.verified) S.hotResetVerified++;
  const id = fp['storage.serviceMachineId']?.slice(0, 8) || '?';
  _syncSchedulerToShared();
  hooks.updatePoolBar?.();
  hooks.refreshPanel?.();
  return {
    ok: true,
    email: account.email,
    fingerprintId: id,
    verified: verify.verified,
    mismatches: verify.mismatches || [],
  };
}

function syncFingerprintToStateDb(fp) {
  try {
    const dbPath = getStateDbPath();
    if (!fs.existsSync(dbPath)) return false;
    const pairs = [
      'storage.serviceMachineId',
      'telemetry.devDeviceId',
      'telemetry.machineId',
      'telemetry.macMachineId',
      'telemetry.sqmId',
    ]
      .filter((key) => fp[key])
      .map((key) => ({ key, value: fp[key] }));
    return pairs.length > 0 && dbUpdateKeys(dbPath, pairs);
  } catch {
    return false;
  }
}
