// 快照落盘：下载 GitLab archive → 校验 → 解压 → 统计文件数。
// B4 修复三道并上：module_key 白名单 / execFileSync 数组参数（不经 shell）/ realpath 越界校验。

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { db } = require('../db');
const logger = require('../logger');
const gitlabApi = require('./gitlab-api');
const { assertModuleKey, assertSafeRelPath, assertRealpathInside, moduleRoot } = require('./paths');

const REPOS_DIR = path.join(__dirname, '..', '..', 'data', 'repos');
if (!fs.existsSync(REPOS_DIR)) fs.mkdirSync(REPOS_DIR, { recursive: true });

const MAX_ARCHIVE_MB = Number(process.env.MAX_ARCHIVE_MB || 200);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'target', 'vendor', '.idea']);

/** 遍历目录收集文件。跳过依赖/产物目录；跳过符号链接（防止顺着软链读到仓库外的文件） */
function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, out);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 解压 tar.gz 到 destReal。
 * 关键：execFileSync 传数组参数，参数不经 shell 解析，元字符失去意义；
 * 且 tar 未加 -P，成员名中的绝对路径与 `..` 会被 tar 自身拒绝。
 */
function extractTarGz(tarFile, destReal) {
  execFileSync('tar', ['-xzf', tarFile, '-C', destReal, '--strip-components=1', '--no-same-owner'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: Number(process.env.TAR_TIMEOUT_MS || 120000),
    maxBuffer: 1024 * 1024,
  });
}

function assertSizeLimit(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb > MAX_ARCHIVE_MB) {
    throw new Error(`仓库快照 ${mb.toFixed(1)}MB 超过上限 ${MAX_ARCHIVE_MB}MB，请改用 sub_path 缩小同步范围`);
  }
}

async function syncModule(moduleId) {
  const m = db.prepare('SELECT * FROM code_modules WHERE id=?').get(moduleId);
  if (!m) throw new Error('模块不存在');
  if (m.source_type !== 'GITLAB') throw new Error('该模块不是 GitLab 来源');

  // 校验先于任何文件系统操作：非法 key 绝不进入 rm/mkdir/tar 的参数
  assertModuleKey(m.module_key);
  assertSafeRelPath(m.sub_path, 'sub_path');

  db.prepare("UPDATE code_modules SET sync_status='SYNCING', error_msg=NULL WHERE id=?").run(moduleId);
  const started = Date.now();
  try {
    const ref = m.branch || 'main';
    const res = await gitlabApi.fetchArchive(m.gitlab_project_id, ref, m.sub_path || '');
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared) assertSizeLimit(declared);
    const buf = Buffer.from(await res.arrayBuffer());
    assertSizeLimit(buf.length);

    const dest = moduleRoot(REPOS_DIR, m.module_key);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    // 目录建好后再解析 realpath：即使 REPOS_DIR 下被放了指向外部的软链也会在此拦下
    const destReal = assertRealpathInside(REPOS_DIR, dest, '模块快照目录');

    const tmpTar = path.join(fs.realpathSync(REPOS_DIR), `.tmp-${m.module_key}.tar.gz`);
    fs.writeFileSync(tmpTar, buf);
    try {
      extractTarGz(tmpTar, destReal);
    } finally {
      fs.rmSync(tmpTar, { force: true });
    }

    const sha = await gitlabApi.fetchCommitSha(m.gitlab_project_id, ref);
    const files = walk(destReal);
    db.prepare(`UPDATE code_modules SET sync_status='OK', last_synced_at=datetime('now','localtime'),
      commit_sha=?, file_count=?, error_msg=NULL WHERE id=?`).run(sha, files.length, moduleId);
    logger.info('module_sync_ok', {
      module: m.module_key, files: files.length, bytes: buf.length, ms: Date.now() - started,
    });
    return { ok: true, file_count: files.length, commit_sha: sha };
  } catch (e) {
    db.prepare("UPDATE code_modules SET sync_status='FAILED', error_msg=? WHERE id=?").run(e.message, moduleId);
    logger.warn('module_sync_failed', { module: m.module_key, reason: e.code || e.message, ms: Date.now() - started });
    throw e;
  }
}

module.exports = { REPOS_DIR, MAX_ARCHIVE_MB, walk, extractTarGz, syncModule };
