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

/** 读取配置（token 为解密后的明文，仅用于发起请求，不得进日志/响应体） */
function getGitlabCfg() {
  const enc = getSetting(TOKEN_ENC_KEY, '') || '';
  const legacy = getSetting(TOKEN_KEY, '') || '';
  const { value, source } = secret.readSecret(enc, legacy, logger, { scope: 'gitlab.token' });
  return {
    baseUrl: (getSetting(BASE_URL_KEY, '') || '').replace(/\/+$/, ''),
    token: value,
    tokenSource: source,
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
  const res = await gl(`/projects/${encodeURIComponent(projectId)}/repository/branches?per_page=100`);
  const list = await res.json();
  return list.map((b) => b.name);
}

/** 拉取 archive（tar.gz）。subPath 非空时下推服务端 path 参数，减少 monorepo 全量下载 */
async function fetchArchive(projectId, ref, subPath = '') {
  const pid = encodeURIComponent(projectId);
  const q = [`sha=${encodeURIComponent(ref)}`];
  if (subPath) q.push(`path=${encodeURIComponent(subPath)}`);
  return gl(`/projects/${pid}/repository/archive.tar.gz?${q.join('&')}`);
}

async function fetchCommitSha(projectId, ref) {
  try {
    const res = await gl(`/projects/${encodeURIComponent(projectId)}/repository/commits/${encodeURIComponent(ref)}`);
    return (await res.json()).id || '';
  } catch {
    return '';
  }
}

module.exports = {
  TOKEN_KEY, TOKEN_ENC_KEY, BASE_URL_KEY,
  getGitlabCfg, setGitlabCfg, maskedCfg, gl,
  testConnection, listProjects, listBranches, fetchArchive, fetchCommitSha,
};
