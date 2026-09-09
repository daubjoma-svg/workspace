// GitLab REST 访问层：连接配置（Token 加密存取）+ 连接测试 + 项目/分支列表 + archive 下载。
// 只读：系统对仓库不做任何写操作。

'use strict';

const { getSetting, setSetting } = require('../db');
const secret = require('../crypto/secret');
const logger = require('../logger');

const TOKEN_KEY = 'gitlab.token';
const TOKEN_ENC_KEY = 'gitlab.token_enc';
const BASE_URL_KEY = 'gitlab.base_url';
const REQUEST_TIMEOUT_MS = Number(process.env.GITLAB_TIMEOUT_MS || 30000);

// 模块级 token 临时覆盖（仅单次同步期间生效，不进日志/响应/配置）。空串表示用全局 token。
let tokenOverride = '';

/** 读取配置（token 为解密后的明文，仅用于发起请求，不得进日志/响应体） */
function getGitlabCfg() {
  const enc = getSetting(TOKEN_ENC_KEY, '') || '';
  const legacy = getSetting(TOKEN_KEY, '') || '';
  const { value, source } = secret.readSecret(enc, legacy, logger, { scope: 'gitlab.token' });
  return {
    baseUrl: (getSetting(BASE_URL_KEY, '') || '').replace(/\/+$/, ''),
    token: tokenOverride || value,
    tokenSource: tokenOverride ? 'module' : source,
  };
}

/** 写入配置：token 一律加密落 gitlab.token_enc，明文列清空 */
function setGitlabCfg({ base_url, token }) {
  if (base_url != null) setSetting(BASE_URL_KEY, base_url);
  if (token != null && !secret.isMaskSentinel(token)) {
    if (token === '') {
      setSetting(TOKEN_ENC_KEY, '');
      setSetting(TOKEN_KEY, '');
    } else {
      setSetting(TOKEN_ENC_KEY, secret.encrypt(token));
      setSetting(TOKEN_KEY, '');
    }
  }
}

function maskedCfg() {
  const c = getGitlabCfg();
  return { base_url: c.baseUrl, token_set: !!c.token, token: secret.mask(!!c.token) };
}

/** GitLab API v4 请求。带超时，非 2xx 抛错（错误体截断，避免把仓库内容灌进日志） */
async function gl(pathname, init = {}) {
  const { baseUrl, token } = getGitlabCfg();
  if (!baseUrl || !token) throw new Error('请先在「模块管理」中配置 GitLab 地址与 Token');
  const started = Date.now();
  let res;
  try {
    res = await fetch(`${baseUrl}/api/v4${pathname}`, {
      ...init,
      headers: { 'PRIVATE-TOKEN': token, ...(init.headers || {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    logger.warn('gitlab_request_failed', { path: pathname, error: e.name, timedOut, ms: Date.now() - started });
    throw new Error(timedOut ? `GitLab 请求超时（${REQUEST_TIMEOUT_MS}ms）` : `GitLab 请求失败：${e.message}`);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    logger.warn('gitlab_response_error', { path: pathname, status: res.status, ms: Date.now() - started });
    const err = new Error(`GitLab API ${res.status}: ${txt.slice(0, 200) || res.statusText}`);
    err.status = res.status;
    err.retryAfter = res.headers.get('retry-after');
    throw err;
  }
  return res;
}

async function testConnection() {
  try {
    const res = await gl('/user');
    const user = await res.json();
    const projRes = await gl('/projects?membership=true&per_page=1&simple=true');
    const total = projRes.headers.get('x-total');
    return { ok: true, user: user.username || user.name, project_count: total != null ? +total : null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function listProjects(search = '') {
  const q = search ? `&search=${encodeURIComponent(search)}` : '';
  const res = await gl(`/projects?membership=true&per_page=100&simple=true&order_by=last_activity_at${q}`);
  const list = await res.json();
  return list.map((p) => ({ id: p.id, path: p.path_with_namespace, name: p.name, default_branch: p.default_branch }));
}

async function listBranches(projectId) {
  // 拉分支列表 + 项目元数据（拿 default_branch）
  // GitLab 默认按最后提交排序返回前 N 个，master 可能在第 101+ 位被截断；
  // 这里把 default_branch 加到列表头部去重，保证主分支永远可见
  const [brRes, projRes] = await Promise.all([
    gl(`/projects/${encodeURIComponent(projectId)}/repository/branches?per_page=100`),
    gl(`/projects/${encodeURIComponent(projectId)}`).catch(() => null),
  ]);
  const branches = await brRes.json();
  const names = new Set(branches.map((b) => b.name));
  let defaultBranch = '';
  if (projRes) {
    try { const p = await projRes.json(); defaultBranch = p.default_branch || ''; } catch { /* ignore */ }
  }
  const result = branches.map((b) => b.name);
  if (defaultBranch && !names.has(defaultBranch)) result.unshift(defaultBranch);
  return result;
}

/** 拉取 archive（tar.gz）。subPath 非空时下推服务端 path 参数，减少 monorepo 全量下载
 * - 优先尝试 GitLab archive API（更快）；若服务端禁用（406/403）→ fallback 到 git clone + 本地 tar 打包
 * - token 非空时用模块级 token 覆盖全局（仅本次调用生效，finally 恢复）
 * - 返回的语义保持不变（archive.js 调 .arrayBuffer() 读 tar 字节流，无感知）
 */
async function fetchArchive(projectId, ref, subPath = '', token = '') {
  const prev = tokenOverride;
  if (token) tokenOverride = token;
  try {
    const pid = encodeURIComponent(projectId);
    const q = [`sha=${encodeURIComponent(ref)}`];
    if (subPath) q.push(`path=${encodeURIComponent(subPath)}`);
    try {
      const res = await gl(`/projects/${pid}/repository/archive.tar.gz?${q.join('&')}`);
      if (res.status === 406 || res.status === 403 || res.status === 404) {
        logger.warn('gitlab_archive_disabled', { projectId, ref, status: res.status });
        return fetchArchiveViaGitClone(projectId, ref, '', token);
      }
      return res;
    } catch (e) {
      // 网络/超时等异常也尝试 git clone fallback（避免单点失败）
      logger.warn('gitlab_archive_error_fallback_git_clone', { reason: e.message });
      return fetchArchiveViaGitClone(projectId, ref, subPath, token);
    }
  } finally {
    tokenOverride = prev;
  }
}

/** git clone fallback：项目禁用 archive 时，用 git 协议克隆再 tar 打包返回
 * - URL 走 http(s) + token 当 basic auth；macOS/Linux 自带 git + tar，无需新依赖
 * - --depth 1 只拉单分支最新 commit，速度与 archive 相当
 */
async function fetchArchiveViaGitClone(projectId, ref, subPath = '', token = '') {
  const prev = tokenOverride;
  if (token) tokenOverride = token;
  try {
    const { execSync } = require('child_process');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { baseUrl, token: effToken } = getGitlabCfg();
    if (!effToken) throw new Error('请先在「模块管理」中配置 GitLab 地址与 Token');
    // 取项目 http_url_to_repo（带 namespace）
    const projRes = await gl(`/projects/${encodeURIComponent(projectId)}`);
    const proj = await projRes.json();
    const repoUrl = proj.http_url_to_repo;
    if (!repoUrl) throw new Error('项目无可用的 http clone 地址');
    // token 用 oauth2 / 空密码 当 basic auth 注入 URL（GitLab 推荐方式）
    const authedUrl = repoUrl.replace(/^https?:\/\//, `https://oauth2:${encodeURIComponent(effToken)}@`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sop-gitclone-'));
    try {
      // --depth 1 --single-branch --branch <ref> 只拉单分支最新 commit；--quiet 抑制进度
      execSync(`git clone --depth 1 --single-branch --branch ${shellEscape(ref)} ${shellEscape(authedUrl)} ${shellEscape(tmp + '/repo')}`, { stdio: 'pipe', timeout: REQUEST_TIMEOUT_MS });
      // 若指定 subPath，下推：只打包 subPath 子目录（与 archive API path 参数语义一致）
      const srcDir = subPath ? path.join(tmp, 'repo', subPath) : path.join(tmp, 'repo');
      // 打包成 tar.gz：先写文件再读 buffer（避免 spawnSync stdout buffer ENOBUFS，大项目 tar 输出超 64KB）
      const tarPath = path.join(tmp, 'archive.tar.gz');
      execSync(`tar -C ${shellEscape(srcDir)} -czf ${shellEscape(tarPath)} .`, { stdio: ['ignore', 'ignore', 'pipe'], timeout: REQUEST_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 64 });
      const tarBuf = fs.readFileSync(tarPath);
      logger.info('gitlab_archive_git_clone_ok', { projectId, ref, subPath, bytes: tarBuf.length });
      // 包装成 fetch 的 Response-like（archive.js 仅用 .arrayBuffer()）
      return new Response(tarBuf, { status: 200, headers: { 'content-type': 'application/gzip' } });
    } catch (e) {
      logger.error('gitlab_archive_git_clone_failed', { projectId, ref, reason: String(e.message || e).slice(0, 200) });
      throw new Error(`archive 不可用且 git clone 也失败：${e.message}`);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响主流程 */ }
    }
  } finally {
    tokenOverride = prev;
  }
}

/** shell 单参数转义（避免 ref 含特殊字符破坏命令） */
function shellEscape(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function fetchCommitSha(projectId, ref, token = '') {
  const prev = tokenOverride;
  if (token) tokenOverride = token;
  try {
    const res = await gl(`/projects/${encodeURIComponent(projectId)}/repository/commits/${encodeURIComponent(ref)}`);
    return (await res.json()).id || '';
  } catch {
    return '';
  } finally {
    tokenOverride = prev;
  }
}

module.exports = {
  TOKEN_KEY, TOKEN_ENC_KEY, BASE_URL_KEY,
  getGitlabCfg, setGitlabCfg, maskedCfg, gl,
  testConnection, listProjects, listBranches, fetchArchive, fetchCommitSha,
};
