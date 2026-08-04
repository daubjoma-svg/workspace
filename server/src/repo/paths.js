// B4 命令注入 + 路径穿越防护的唯一收口点。
// 任何把 module_key / sub_path / path_prefix 拼进文件系统路径或子进程参数的地方，
// 必须先过这里的校验函数。纯函数 + 同步 fs 校验，便于单测覆盖。

'use strict';

const fs = require('fs');
const path = require('path');

// 白名单：小写字母数字开头，后续允许 [a-z0-9_-]，总长 1-64。
// 排除了空格、引号、分号、$ ` | & > < 等全部 shell 元字符与路径分隔符。
const MODULE_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function isValidModuleKey(key) {
  return typeof key === 'string' && MODULE_KEY_RE.test(key);
}

function assertModuleKey(key) {
  if (!isValidModuleKey(key)) {
    const err = new Error('module_key 仅允许小写字母、数字、下划线、短横线，须以字母或数字开头，长度 1-64');
    err.status = 400;
    err.code = 'INVALID_MODULE_KEY';
    throw err;
  }
  return key;
}

/**
 * 仓库内相对子路径校验（sub_path / path_prefix）。
 * 拒绝：绝对路径、盘符、`..` 段、NUL 字节、反斜杠（Windows 风格分隔符绕过）。
 * 允许：空串（表示仓库根）。
 */
function isSafeRelPath(rel) {
  if (rel == null || rel === '') return true;
  if (typeof rel !== 'string') return false;
  if (rel.includes('\0')) return false;
  if (rel.includes('\\')) return false;
  if (path.isAbsolute(rel)) return false;
  if (/^[a-zA-Z]:/.test(rel)) return false;
  return rel.split('/').every((seg) => seg !== '..');
}

function assertSafeRelPath(rel, label = 'sub_path') {
  if (!isSafeRelPath(rel)) {
    const err = new Error(`${label} 不合法：不允许绝对路径、上级目录（..）或反斜杠`);
    err.status = 400;
    err.code = 'INVALID_REL_PATH';
    throw err;
  }
  return rel || '';
}

/** 词法层面判断 target 是否落在 base 之内（base 自身不算"之内"） */
function isInside(baseAbs, targetAbs) {
  const rel = path.relative(baseAbs, targetAbs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 安全拼接：base + rel，词法归一化后必须仍在 base 内（或等于 base）。
 * 双保险：即使 rel 侥幸通过了正则，归一化后越界依然会被拦下。
 */
function safeJoin(baseAbs, rel, label = 'sub_path') {
  assertSafeRelPath(rel, label);
  const target = path.resolve(baseAbs, rel || '');
  if (target !== path.resolve(baseAbs) && !isInside(path.resolve(baseAbs), target)) {
    const err = new Error(`${label} 越界：解析结果不在仓库目录内`);
    err.status = 400;
    err.code = 'PATH_ESCAPE';
    throw err;
  }
  return target;
}

/**
 * realpath 校验：解析符号链接后仍必须落在 base 内。
 * 防御"目录被替换成指向外部的软链"这类 TOCTOU 变体。target 必须已存在。
 */
function assertRealpathInside(baseAbs, targetAbs, label = '目标目录') {
  const baseReal = fs.realpathSync(baseAbs);
  const targetReal = fs.realpathSync(targetAbs);
  if (targetReal !== baseReal && !isInside(baseReal, targetReal)) {
    const err = new Error(`${label} 越界：真实路径 ${targetReal} 不在 ${baseReal} 内`);
    err.status = 400;
    err.code = 'PATH_ESCAPE';
    throw err;
  }
  return targetReal;
}

/** 模块快照根目录：module_key 先过白名单，再拼路径，再做词法越界检查 */
function moduleRoot(reposDir, moduleKey) {
  assertModuleKey(moduleKey);
  const baseAbs = path.resolve(reposDir);
  const dest = path.resolve(baseAbs, moduleKey);
  if (!isInside(baseAbs, dest)) {
    const err = new Error('module_key 解析越界');
    err.status = 400;
    err.code = 'PATH_ESCAPE';
    throw err;
  }
  return dest;
}

module.exports = {
  MODULE_KEY_RE,
  isValidModuleKey, assertModuleKey,
  isSafeRelPath, assertSafeRelPath,
  isInside, safeJoin, assertRealpathInside, moduleRoot,
};
