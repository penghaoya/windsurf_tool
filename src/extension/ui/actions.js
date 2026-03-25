import vscode from 'vscode';
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
import { readFingerprint } from '../services/fingerprint.js';

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
        return _seamlessSwitch(context, arg);
      case 'checkAccount':
        return helpers.checkAccount(context, arg);
      case 'explicitSwitch':
        return _seamlessSwitch(context, arg);
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
