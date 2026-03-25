import vscode from 'vscode';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { _logError } from '../core/state.js';

function loadWisdomBundle(context) {
  try {
    const bundlePath = path.join(path.dirname(__dirname), 'data', 'wisdom_bundle.json');
    if (fs.existsSync(bundlePath)) {
      return JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
    }
    const extensionPath = context.extensionPath || context.extensionUri?.fsPath;
    if (extensionPath) {
      const altPath = path.join(extensionPath, 'data', 'wisdom_bundle.json');
      if (fs.existsSync(altPath)) {
        return JSON.parse(fs.readFileSync(altPath, 'utf8'));
      }
    }
  } catch (error) {
    _logError('WISDOM', 'failed to load wisdom bundle', error.message);
  }
  return null;
}

async function doEmbeddedWisdom(context, targetPath, action) {
  const bundle = loadWisdomBundle(context);
  if (!bundle || !bundle.templates) {
    vscode.window.showErrorMessage('WAM: 智慧模板包未找到。请重新安装插件。');
    return;
  }

  const root =
    targetPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  if (!root) {
    vscode.window.showWarningMessage('WAM: 未指定目标工作区。');
    return;
  }

  const templates = bundle.templates;
  const overwrite = action === 'inject_overwrite';

  if (action === 'scan') {
    let exists = 0;
    let missing = 0;
    const missingList = [];
    for (const [key, template] of Object.entries(templates)) {
      const filePath = path.join(root, template.path);
      if (fs.existsSync(filePath)) exists++;
      else {
        missing++;
        missingList.push(key);
      }
    }
    const selection = await vscode.window.showInformationMessage(
      `WAM: 扫描(内置) — ${exists}已安装 / ${missing}缺失 / ${Object.keys(templates).length}总计\n` +
        `缺失: ${missingList.slice(0, 8).join(', ')}${missingList.length > 8 ? '...' : ''}`,
      missing > 0 ? '注入缺失项' : '已完整',
    );
    if (selection === '注入缺失项') {
      await doEmbeddedWisdom(context, root, 'inject');
    }
    return;
  }

  const category = await vscode.window.showQuickPick(
    [
      {
        label: '🌟 全部注入',
        description: `${Object.keys(templates).length}个模板`,
        value: 'all',
      },
      {
        label: '📐 仅规则',
        description: 'kernel + protocol (Agent行为框架)',
        value: 'rule',
      },
      {
        label: '🎯 仅技能',
        description: '32个通用技能 (错误诊断/代码质量/Git等)',
        value: 'skill',
      },
      {
        label: '🔄 仅工作流',
        description: '13个工作流 (审查/循环/开发等)',
        value: 'workflow',
      },
      {
        label: '🔧 选择性注入',
        description: '手动选择要注入的模板',
        value: 'pick',
      },
    ],
    { placeHolder: `注入到: ${root}`, title: '选择注入范围' },
  );
  if (!category) return;

  let selectedKeys;
  if (category.value === 'all') {
    selectedKeys = Object.keys(templates);
  } else if (category.value === 'pick') {
    const items = Object.entries(templates).map(([key, template]) => ({
      label: `${template.category === 'rule' ? '📐' : template.category === 'skill' ? '🎯' : '🔄'} ${key}`,
      description: template.desc.slice(0, 60),
      picked: true,
      key,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: '选择要注入的模板',
      title: `${items.length}个可用模板`,
    });
    if (!picked || picked.length === 0) return;
    selectedKeys = picked.map((item) => item.key);
  } else {
    selectedKeys = Object.entries(templates)
      .filter(([_, template]) => template.category === category.value)
      .map(([key]) => key);
  }

  let injected = 0;
  let skipped = 0;
  let errors = 0;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'WAM: 注入智慧模板',
      cancellable: false,
    },
    async (progress) => {
      for (let i = 0; i < selectedKeys.length; i++) {
        const key = selectedKeys[i];
        const template = templates[key];
        if (!template) continue;
        progress.report({
          message: `${key} (${i + 1}/${selectedKeys.length})`,
          increment: 100 / selectedKeys.length,
        });

        const filePath = path.join(root, template.path);
        if (fs.existsSync(filePath) && !overwrite) {
          skipped++;
          continue;
        }

        try {
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(filePath, template.content, 'utf8');
          if (template.supporting) {
            const parentDir = path.dirname(filePath);
            for (const [name, content] of Object.entries(template.supporting)) {
              fs.writeFileSync(path.join(parentDir, name), content, 'utf8');
            }
          }
          injected++;
        } catch (error) {
          errors++;
          _logError('WISDOM', `inject ${key} failed`, error.message);
        }
      }
    },
  );

  vscode.window.showInformationMessage(
    `WAM: 注入完成 — ${injected}成功 / ${skipped}跳过 / ${errors}失败\n路径: ${root}/.windsurf/`,
  );
}

export async function _doInitWorkspace(context) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const defaultPath =
    workspaceFolders && workspaceFolders.length > 0
      ? workspaceFolders[0].uri.fsPath
      : '';

  const targetPath = await vscode.window.showInputBox({
    prompt: '目标工作区路径 (智慧部署)',
    placeHolder: defaultPath || '输入工作区绝对路径',
    value: defaultPath,
  });
  if (targetPath === undefined) return;

  const action = await vscode.window.showQuickPick(
    [
      { label: '🔍 扫描', description: '查看智慧模板安装状态', value: 'scan' },
      {
        label: '⬇ 注入智慧框架',
        description: '部署规则+技能+工作流到目标工作区',
        value: 'inject',
      },
      {
        label: '⬇ 注入(覆盖)',
        description: '覆盖已有文件重新注入',
        value: 'inject_overwrite',
      },
      {
        label: '✨ 生成源启动提示词',
        description: '生成激活认知框架的初始提示词',
        value: 'prompt',
      },
      {
        label: '🖥 检测环境',
        description: '检测IDE/OS/MCP/Python环境',
        value: 'detect',
      },
      {
        label: '🌐 打开智慧部署器',
        description: '在浏览器打开 http://localhost:9876/',
        value: 'browser',
      },
    ],
    { placeHolder: '选择操作', title: '工作区配置向导' },
  );
  if (!action) return;

  if (action.value === 'browser') {
    vscode.env.openExternal(vscode.Uri.parse('http://localhost:9876/'));
    vscode.window.showInformationMessage(
      'WAM: 已打开智慧部署器 (需先启动: python 安全管理/windsurf_wisdom.py serve)',
    );
    return;
  }

  const base = 'http://127.0.0.1:9876';
  const target = targetPath.trim();

  const callApi = (apiPath, method = 'GET', body = null) =>
    new Promise((resolve, reject) => {
      const url = new URL(base + apiPath);
      const bodyStr = body ? JSON.stringify(body) : null;
      const options = {
        hostname: url.hostname,
        port: parseInt(url.port, 10) || 80,
        path: url.pathname + url.search,
        method,
        headers: bodyStr
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(bodyStr),
            }
          : {},
        timeout: 10000,
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ raw: data });
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });

  const query = target ? `?target=${encodeURIComponent(target)}` : '';

  try {
    if (action.value === 'scan') {
      const result = await callApi('/api/scan' + query);
      const installed = (result.exists || []).length;
      const missing = (result.missing || []).length;
      vscode.window
        .showInformationMessage(
          `WAM: 扫描 — ${installed}已安装 / ${missing}缺失\n${(result.missing || [])
            .slice(0, 5)
            .map((item) => '❌ ' + item.key)
            .join(', ')}`,
          missing > 0 ? '注入缺失项' : '已完整',
        )
        .then((selection) => {
          if (selection === '注入缺失项') _doInitWorkspace(context);
        });
    } else if (
      action.value === 'inject' ||
      action.value === 'inject_overwrite'
    ) {
      const result = await callApi('/api/inject', 'POST', {
        target: target || undefined,
        overwrite: action.value === 'inject_overwrite',
      });
      vscode.window.showInformationMessage(
        `WAM: 注入完成 — ${result.summary}\n注入项: ${(result.injected || [])
          .slice(0, 8)
          .map((item) => item.key)
          .join(', ')}`,
      );
    } else if (action.value === 'prompt') {
      const result = await callApi('/api/prompt' + query);
      const prompt = result.prompt || '';
      await vscode.env.clipboard.writeText(prompt);
      vscode.window
        .showInformationMessage(
          `WAM: 源启动提示词已生成并复制到剪贴板！(${result.ide} / ${(result.installed.rules || []).length}规则 / ${(result.installed.skills || []).length}技能)`,
          '打开智慧部署器',
        )
        .then((selection) => {
          if (selection === '打开智慧部署器') {
            vscode.env.openExternal(vscode.Uri.parse('http://localhost:9876/'));
          }
        });
    } else if (action.value === 'detect') {
      const result = await callApi('/api/detect' + query);
      const mcps = Object.entries(result.mcps_installed || {})
        .map(([name, installed]) => (installed ? '✅' : '❌') + name)
        .join(' ');
      vscode.window.showInformationMessage(
        `WAM: 环境 — IDE:${result.ide} OS:${result.os} Python:${result.python_ok ? '✅' : '❌'} 安全中枢:${result.security_hub_running ? '✅' : '❌'}\nMCP: ${mcps}`,
      );
    }
  } catch (error) {
    if (
      action.value === 'inject' ||
      action.value === 'inject_overwrite' ||
      action.value === 'scan'
    ) {
      await doEmbeddedWisdom(context, target, action.value);
    } else {
      const choice = await vscode.window.showWarningMessage(
        'WAM: 智慧部署服务未运行。已切换到内置模板模式。\n可直接注入47个智慧模板(规则+技能+工作流)。',
        '内置注入',
        '启动服务器',
        '取消',
      );
      if (choice === '内置注入') {
        await doEmbeddedWisdom(context, target, 'inject');
      } else if (choice === '启动服务器') {
        const terminal = vscode.window.createTerminal('智慧部署器');
        terminal.sendText('python 安全管理/windsurf_wisdom.py serve');
        terminal.show();
      }
    }
  }
}
