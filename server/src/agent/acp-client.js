'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { spawnSandboxed, sandboxEnv, REPOS_DIR } = require('../sandbox/seatbelt');
const { isInside } = require('../repo/paths');
const { isSensitiveFile, redactSecretsDetailed } = require('../repo/sensitive');

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function mimeForImage(p) {
  return MIME_BY_EXT[path.extname(String(p)).toLowerCase()] || 'image/png';
}

/**
 * 通过 ACP（Agent Client Protocol）驱动 traecli 原生 Agent（JSON-RPC over stdio）。
 *
 * 为什么不用 `exec -i`：exec 通道把本地图片转成内部 CDN 短路径再交给自定义
 * OpenAI 兼容 provider，阿里云 MaaS 会以 `Unsupported image_url format` 拒绝。
 * ACP 的 session/prompt 直接把图片以 base64 content block 交给模型，
 * 多模态读图 + 自主检索/读文件能力都能正常工作。
 *
 * 沙箱（主机隔离）三道闸：
 *  1. 子进程整体跑在 Seatbelt 沙箱里（spawnSandboxed）：只能只读仓库快照、
 *     不能写任何文件、不能访问除 443/80/53 出站外的网络（见 sandbox/seatbelt.js）；
 *  2. permissionMode 永不 bypass：请求一律按 default 模式，权限请求自动拒绝；
 *  3. fs/read_text_file 代理只允许读会话仓库根内的路径并做脱敏。
 *
 * @returns {Promise<{content:string, stopReason?:string, usage?:object}>}
 */
function runAcpPrompt({
  bin,
  model,
  cwd,
  addDirs = [],
  permissionMode,
  prompt,
  images = [],
  timeoutMs = 240000,
  env,
  extraConfigs = [],
}) {
  // 安全闸：bypass_permissions 一律降级为 default（历史上默认值就是 bypass，等于裸奔）
  if (permissionMode && String(permissionMode).startsWith('bypass')) {
    logger.warn('acp_bypass_permissions_blocked', {});
    permissionMode = null;
  }
  const args = [];
  if (permissionMode) args.push('--permission-mode', String(permissionMode));
  args.push('--sandbox', 'read-only'); // 模型生成的 shell 命令按只读策略执行
  for (const c of extraConfigs) args.push('-c', String(c));
  if (model) args.push('-c', `model=${JSON.stringify(String(model))}`);
  args.push('acp', 'serve');

  const sessionRoots = [cwd, ...addDirs]
    .filter(Boolean).map(String)
    .map((p) => { try { return fs.realpathSync(p); } catch { return p; } });

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnSandboxed(bin, args, {
        cwd: cwd || REPOS_DIR,
        env: sandboxEnv({ TRAECLI_PERSONAL_ACCESS_TOKEN: (env && env.TRAECLI_PERSONAL_ACCESS_TOKEN) || '' }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(new Error('traecli(acp) 启动失败: ' + (e && e.message ? e.message : e)));
      return;
    }

    let settled = false;
    let buf = '';
    let stderr = '';
    let nextId = 1;
    let sessionId = null;
    let reply = '';
    let stopReason = null;
    let usage = null;
    const pending = new Map();

    const cleanup = () => {
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* 已关闭 */ }
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ content: reply.trim(), stopReason, usage });
    };

    const timer = setTimeout(() => {
      fail(new Error(`traecli(acp) 调用超时（${Math.round(timeoutMs / 1000)}s 未返回）`));
    }, Number(timeoutMs) || 240000);

    child.on('error', (e) => fail(new Error('traecli(acp) 启动失败: ' + (e && e.message ? e.message : e))));
    child.on('exit', (code) => {
      if (!settled && !reply.trim()) {
        fail(new Error(`traecli(acp) 退出（code ${code}）: ${stderr.slice(0, 300) || '无输出'}`));
      } else if (!settled) {
        done();
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.stdin.on('error', () => { /* 子进程提前退出时忽略 EPIPE */ });

    const send = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) {
        pending.delete(id);
        rej(e);
      }
    });

    const respond = (id, result) => {
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); } catch { /* 通道关闭 */ }
    };
    const respondError = (id, message) => {
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } }) + '\n');
      } catch { /* 通道关闭 */ }
    };

    const handle = (msg) => {
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.res(msg.result);
        return;
      }
      if (msg.method === 'session/update') {
        const u = (msg.params && msg.params.update) || {};
        if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') {
          reply += u.content.text;
        }
        return;
      }
      if (msg.method === 'session/request_permission') {
        // 只读探索策略：一律拒绝。Agent 只被允许读仓库快照（Seatbelt 之外的第二道闸），
        // 任何需要批准的动作（越权读、写、联网命令）都直接取消，让模型改走合规工具。
        const options = (msg.params && msg.params.options) || [];
        const rejected = options.find((o) => /^(reject|deny|cancel)/i.test(o.optionId || ''));
        logger.info('acp_permission_denied', { options: options.map((o) => o.optionId).join(',') });
        respond(msg.id, {
          outcome: rejected
            ? { outcome: 'selected', optionId: rejected.optionId }
            : { outcome: 'cancelled' },
        });
        return;
      }
      if (msg.method === 'fs/read_text_file') {
        // 读盘代理：只允许读会话仓库根内的文件（realpath 防符号链接逃逸），并做敏感内容脱敏。
        // 该处理器运行在服务器进程内、不受 Seatbelt 约束，必须自设白名单。
        const p = msg.params && msg.params.path;
        try {
          if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('需要绝对路径');
          const real = fs.realpathSync(p);
          const root = sessionRoots.find((r) => real === r || isInside(r, real));
          if (!root) throw new Error(`路径不在会话仓库内: ${p}`);
          const rel = path.relative(root, real);
          if (isSensitiveFile(rel)) throw new Error(`敏感文件已拒绝: ${rel}`);
          const red = redactSecretsDetailed(fs.readFileSync(real, 'utf8'));
          respond(msg.id, { content: red.content });
        } catch (e) {
          respondError(msg.id, String((e && e.message) || e));
        }
        return;
      }
      if (msg.method && msg.id !== undefined) respondError(msg.id, 'unsupported client method: ' + msg.method);
    };

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        handle(msg);
      }
    });

    (async () => {
      try {
        await send('initialize', { protocolVersion: 1, clientCapabilities: {} });
        const sess = await send('session/new', {
          cwd: cwd || process.cwd(),
          mcpServers: [],
          additionalDirectories: addDirs.filter(Boolean),
        });
        sessionId = sess && sess.sessionId;
        if (!sessionId) throw new Error('ACP session/new 未返回 sessionId');
        const promptBlocks = [{ type: 'text', text: String(prompt || '') }];
        for (const img of images) {
          if (!img || !fs.existsSync(img)) continue;
          promptBlocks.push({ type: 'image', data: fs.readFileSync(img).toString('base64'), mimeType: mimeForImage(img) });
        }
        const result = await send('session/prompt', { sessionId, prompt: promptBlocks });
        stopReason = result && result.stopReason;
        usage = result && result.usage;
        done();
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  });
}

module.exports = { runAcpPrompt, mimeForImage };
