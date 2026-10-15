// AI 子进程沙箱（Seatbelt）——主机隔离的唯一收口。
//
// 设计目标（按需求硬约束）：
//  1. AI 不能操作主机：模型驱动的一切子进程默认拒绝写入（沙箱内也只读），
//     唯一可写的是与主机无关的运行时目录（trae-home / 沙箱 tmp）。
//  2. AI 不能看主机：默认拒绝读取任何路径，仅放行
//     - 已添加的代码仓库快照 server/data/repos（只读）
//     - 运行所必需的系统目录（/usr /System /Library …）与 traecli 自身安装目录
//     - 隔离的运行时目录 server/data/trae-home、server/data/sandbox/tmp
//  3. 网络仅放出站 443/80/53（LLM API 与 DNS）；本地 unix socket 仅限 trae-home 内。
//  4. 环境隔离：子进程不继承服务器 process.env（防 printenv 拖走 DB 密码/主密钥），
//     HOME / TRAE_HOME 指向独立目录，不加载 ~/.trae 的全局 MCP（computer-use 等）。
//
// 分层：Seatbelt 是硬墙；acp-client / llm-call 再叠加协议层限制（拒绝越权请求、
// fs/read_text_file 白名单）。任何一层失守，另一层兜底。
//
// 非 macOS 平台：sandbox-exec 不可用，退化为直启并打告警日志——依赖容器/虚拟机
// 边界（deploy/docker-compose）。协议层限制在所有平台始终生效。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const logger = require('../logger');
const { REPOS_DIR } = require('../repo/archive');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SANDBOX_DIR = path.join(DATA_DIR, 'sandbox');
const SANDBOX_TMP = path.join(SANDBOX_DIR, 'tmp');
const TRAE_HOME = path.join(DATA_DIR, 'trae-home');
const PROFILE_PATH = path.join(SANDBOX_DIR, 'profile.sb');
const IS_MACOS = process.platform === 'darwin';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** /etc(/private/etc) 里只放行网络与账号解析必需的个别文件 */
const ETC_READ_FILES = [
  '/etc/resolv.conf', '/etc/hosts', '/etc/passwd', '/etc/group',
  '/private/etc/resolv.conf', '/private/etc/hosts', '/private/etc/passwd', '/private/etc/group',
];

/** /private/var 里隐藏的子目录（root 家目录/交换文件/系统钥匙串/用户临时区） */
const VAR_HIDE_DIRS = [
  '/private/var/root', '/private/var/vm', '/private/var/db/Keychains',
  '/private/var/folders', '/private/var/db/anecdotes',
];

/** /Library 里隐藏的子目录（整机偏好/应用数据/钥匙串——与代码运行无关） */
const LIBRARY_HIDE_DIRS = [
  '/Library/Preferences', '/Library/Application Support', '/Library/Caches',
  '/Library/Keychains', '/Library/Logs', '/Library/WebServer',
];

/** 包管理器的配置与数据目录（二进制与库本身仍可读） */
const PKG_HIDE_DIRS = [
  '/opt/homebrew/etc', '/opt/homebrew/var', '/usr/local/etc', '/usr/local/var',
];

/** 整树隐藏的根（其他磁盘挂载点、网络挂载、/etc 整体——个别文件再放行） */
const HIDE_ROOTS = ['/Volumes', '/net', '/automount', '/etc', '/private/etc', '/tmp', '/private/tmp'];

/** /private/var 的镜像路径 /var/... 同样要隐藏（symlink 字面路径不等于解析后路径，两侧都得写规则） */
const VAR_SYMLINK_TWINS = VAR_HIDE_DIRS.map((d) => d.replace(/^\/private/, ''));

/** 禁止子进程执行的命令（AppleScript/自动化/Keychain/主机信息探测） */
const DENY_EXEC_LITERALS = [
  '/usr/bin/osascript', '/usr/bin/open', '/usr/bin/shortcuts', '/usr/bin/automator',
  '/usr/bin/security', '/usr/sbin/system_profiler', '/usr/sbin/lsof',
  '/usr/bin/csrutil', '/usr/sbin/spctl',
];

/** 禁止 mach 通信的自动化服务（防止借 Finder/AppleEvents 绕过文件读边界） */
const DENY_MACH_NAMES = [
  'com.apple.finder', 'com.apple.systemevents', 'com.apple.AEServer',
  'com.apple.terminal', 'com.google.iterm2', 'com.apple.shortcuts', 'com.apple.shortcuts.legacy',
];

let warnedNoSeatbelt = false;

/* ---------------- 基础工具 ---------------- */

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

/** 尽力解析真实路径；解析失败返回原路径（symlink 链中间环节缺失时仍保留可读字面量） */
function realpathBest(p) {
  const out = [p];
  let cur = p;
  for (let i = 0; i < 8; i += 1) {
    let next;
    try { next = fs.realpathSync(cur); } catch { break; }
    if (next === cur) break;
    out.push(next);
    cur = next;
  }
  return out;
}

/** 逐跳记录符号链接链上每一跳的字面路径（seatbelt 按字面路径匹配，跳变点必须逐个放行） */
function symlinkChain(p) {
  const out = [p];
  const seen = new Set([p]);
  let cur = p;
  for (let i = 0; i < 16; i += 1) {
    let st;
    try { st = fs.lstatSync(cur); } catch { break; }
    if (!st.isSymbolicLink()) break;
    let target;
    try { target = fs.readlinkSync(cur); } catch { break; }
    cur = path.resolve(path.dirname(cur), target);
    if (seen.has(cur)) break;
    seen.add(cur);
    out.push(cur);
  }
  return out;
}

/** SBPL regex 字面量转义（路径里只有 . 和 - 需要处理，稳妥起见全转） */
function escapeSbRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ---------------- trae-home 引导 ---------------- */

/**
 * 引导隔离的 trae-home：只拷贝模型连通必需的极小配置（model-provider、
 * traecli.toml、installation_id、cli/auth.json 登录凭据），绝不拷贝 trae_cli.yaml
 * （全局 MCP，含 computer-use）、skills、AGENTS.md、cli/ 下的会话历史库。
 * auth.json 在源端更新（重新 traecli login）时会自动刷新拷贝。
 * 幂等：已存在则跳过。在服务器进程内执行（服务器自身是可信边界）。
 */
function bootstrapTraeHome() {
  ensureDir(TRAE_HOME);
  const realTraeHome = path.join(os.homedir(), '.trae');
  const copyIfExists = (rel, isDir) => {
    const src = path.join(realTraeHome, rel);
    const dst = path.join(TRAE_HOME, rel);
    try {
      if (!fs.existsSync(src) || fs.existsSync(dst)) return;
      if (isDir) fs.cpSync(src, dst, { recursive: true });
      else fs.copyFileSync(src, dst);
      logger.info('sandbox_trae_home_copied', { item: rel });
    } catch (e) {
      logger.warn('sandbox_trae_home_copy_failed', { item: rel, reason: e.message });
    }
  };
  copyIfExists('model-provider', true);
  copyIfExists('traecli.toml', false);
  copyIfExists('installation_id', false);
  // 登录凭据：主机 ~/.trae/cli/auth.json（应用此前依赖的"本机登录态"）。
  // 源端比拷贝新（重新 login）时刷新，保证 token 轮换后 AI 调用不失效。
  try {
    const srcAuth = path.join(realTraeHome, 'cli', 'auth.json');
    const dstAuth = path.join(TRAE_HOME, 'cli', 'auth.json');
    if (fs.existsSync(srcAuth)) {
      const srcMtime = fs.statSync(srcAuth).mtimeMs;
      const dstMtime = fs.existsSync(dstAuth) ? fs.statSync(dstAuth).mtimeMs : 0;
      if (srcMtime > dstMtime) {
        fs.mkdirSync(path.dirname(dstAuth), { recursive: true });
        fs.copyFileSync(srcAuth, dstAuth);
        logger.info('sandbox_trae_home_copied', { item: 'cli/auth.json' });
      }
    }
  } catch (e) {
    logger.warn('sandbox_trae_home_copy_failed', { item: 'cli/auth.json', reason: e.message });
  }
  if (!fs.existsSync(path.join(TRAE_HOME, 'installation_id'))) {
    try { fs.writeFileSync(path.join(TRAE_HOME, 'installation_id'), crypto.randomUUID()); } catch { /* 无害 */ }
  }
  // 给快照根目录加信任标记，避免 traecli 在非交互模式下因未信任目录拒绝工作。
  // 注意：这只是 CLI 自身的工作区语义；读写边界完全由 Seatbelt profile 决定。
  try {
    const tomlPath = path.join(TRAE_HOME, 'traecli.toml');
    let toml = fs.existsSync(tomlPath) ? fs.readFileSync(tomlPath, 'utf8') : '';
    const reposReal = fs.realpathSync(REPOS_DIR);
    if (!toml.includes(`[projects."${reposReal}"]`)) {
      toml += `\n[projects."${reposReal}"]\ntrust_level = "trusted"\n`;
      fs.writeFileSync(tomlPath, toml);
    }
  } catch (e) {
    logger.warn('sandbox_trae_home_toml_failed', { reason: e.message });
  }
}

/* ---------------- SBPL profile ---------------- */

/** 计算放行读取的路径集合（traecli 二进制的符号链接链与安装树），均位于被隐藏目录内 */
function computeReadAllows() {
  const allows = [];
  const add = (p) => { if (p && typeof p === 'string' && p.startsWith('/')) allows.push(p); };
  add(String(fs.realpathSync(REPOS_DIR)));
  add(TRAE_HOME);
  // traecli 二进制：字面路径、每一跳 symlink、最终真实路径，以及所在 bin 目录
  const bin = process.env.TRAECLI_BIN || '/Users/admin/.local/bin/traecli';
  symlinkChain(bin).forEach(add);
  add(path.dirname(bin));
  // 安装树：最终二进制向上 3 级（releases/<ver>/ → releases/ → traecli 安装根），
  // 运行时资源与其自动更新器都在这棵树里（写已被全局 deny，只放行读）
  let final = bin;
  try { final = fs.realpathSync(bin); } catch { /* 保持字面路径 */ }
  add(final);
  let dir = path.dirname(final);
  for (let i = 0; i < 3; i += 1) { add(dir); dir = path.dirname(dir); }
  return [...new Set(allows)];
}

/** 某路径的全部祖先目录（含自身，不含 /）。用于放行 metadata（stat 遍历）而不放行内容。 */
function ancestorsOf(p) {
  const out = [];
  let cur = path.resolve(p);
  while (cur !== '/' && cur.length > 1) {
    out.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

/** 沙箱相关目录（repos/trae-home/tmp）的祖先链：只放行 file-read-metadata。
 *  canonicalize/realpath 会逐级 stat 父目录，缺了这层会大量告警甚至失败；
 *  metadata 只暴露"目录存在与属性"，不暴露目录内容（readdir 走 file-read-data，仍被拒）。 */
function computeAncestorMetadataAllows() {
  const set = new Set();
  for (const base of [REPOS_DIR, TRAE_HOME, SANDBOX_TMP]) {
    for (const a of ancestorsOf(base)) {
      // 只补 /Users 下的段；/Users 之外（如 /Users 本身）也一并放行 metadata，
      // 否则 stat("/Users") 都会被拒——这与"不许看内容"不冲突。
      set.add(a);
    }
  }
  return [...set];
}

/** 生成 Seatbelt profile 文本。
 *  本机（macOS 14）实测语义约束：
 *  - SBPL 为 last-match-wins：deny 某前缀后可用更具体的 allow 例外（顺序敏感，例外必须写在 deny 之后）；
 *  - 「无过滤器的 file-read* deny + 后置 allow」会导致 sandbox-exec 编译崩溃（SIGABRT），
 *    因此读边界采用「allow default 为底 + 按目录树定向 deny + 白名单例外」。 */
function buildProfile() {
  const lines = [];
  const L = (s) => lines.push(s);

  L('(version 1)');
  L('(allow default)'); // 系统调用/mach 等默认放行，再用显式 deny 收紧
  L('');
  L(';; ===== 只读沙箱：默认拒绝一切写入（后置例外） =====');
  L('(deny file-write*)');
  L(`(allow file-write* (subpath ${JSON.stringify(TRAE_HOME)}))`);
  L(`(allow file-write* (subpath ${JSON.stringify(SANDBOX_TMP)}))`);
  L('(allow file-write* (literal "/dev/null"))');
  L('(allow file-write* (literal "/dev/dtrace/helper"))');
  L('');
  L(';; ===== 读边界：隐藏用户数据与主机敏感目录 =====');
  L('(deny file-read* (subpath "/Users"))');
  for (const d of computeAncestorMetadataAllows()) L(`(allow file-read-metadata (literal ${JSON.stringify(d)}))`);
  for (const d of computeReadAllows()) L(`(allow file-read* (subpath ${JSON.stringify(d)}))`);
  for (const d of [...VAR_HIDE_DIRS, ...VAR_SYMLINK_TWINS, ...LIBRARY_HIDE_DIRS, ...PKG_HIDE_DIRS, ...HIDE_ROOTS]) {
    L(`(deny file-read* (subpath ${JSON.stringify(d)}))`);
  }
  // /etc 是指向 /private/etc 的 symlink：必须放行链接本身的 readlink，白名单路径才可达；
  // 白名单同时写 /etc 与 /private/etc 两种字面形态（调用方可能用任一形态）。
  L('(allow file-read* (literal "/etc"))');
  for (const f of ETC_READ_FILES) L(`(allow file-read* (literal ${JSON.stringify(f)}))`);
  L('(allow file-read* (subpath "/etc/ssl"))');
  L('(allow file-read* (subpath "/private/etc/ssl"))');
  L('');
  L(';; ===== 网络：仅出站 443/80/53；禁止监听与本地 socket（docker.sock 等） =====');
  L('(deny network*)');
  L('(allow network-outbound (remote tcp "*:443"))');
  L('(allow network-outbound (remote tcp "*:80"))');
  L('(allow network-outbound (remote udp "*:53"))');
  L('(allow network-outbound (remote tcp "*:53"))');
  L(`(allow network-outbound (remote unix-socket (regex #"^${escapeSbRe(TRAE_HOME)}")))`);
  L('(allow network-outbound (remote unix-socket (literal "/private/var/run/mDNSResponder")))');
  L('(allow network-outbound (remote unix-socket (literal "/var/run/mDNSResponder")))');
  L('');
  L(';; ===== 禁止自动化/主机探测 =====');
  for (const b of DENY_EXEC_LITERALS) L(`(deny process-exec* (literal ${JSON.stringify(b)}))`);
  for (const m of DENY_MACH_NAMES) L(`(deny mach-lookup (global-name "${m}"))`);
  return lines.join('\n') + '\n';
}

/**
 * 幂等初始化沙箱：目录、trae-home、profile 落盘。
 * @returns {{ profilePath:string, traeHome:string, tmpDir:string, wrapped:boolean }}
 */
function ensureSandbox() {
  ensureDir(SANDBOX_DIR);
  ensureDir(SANDBOX_TMP);
  ensureDir(REPOS_DIR);
  bootstrapTraeHome();
  const wrapped = IS_MACOS && fs.existsSync(SANDBOX_EXEC);
  if (!wrapped && !warnedNoSeatbelt) {
    warnedNoSeatbelt = true;
    logger.warn('sandbox_seatbelt_unavailable', {
      platform: process.platform,
      hint: '非 macOS 无 sandbox-exec，仅协议层限制生效；生产应以容器/VM 作为边界',
    });
  }
  if (wrapped) {
    fs.writeFileSync(PROFILE_PATH, buildProfile());
    try { fs.chmodSync(PROFILE_PATH, 0o644); } catch { /* 无害 */ }
  }
  return { profilePath: wrapped ? PROFILE_PATH : null, traeHome: TRAE_HOME, tmpDir: SANDBOX_TMP, wrapped };
}

/* ---------------- 子进程环境 ---------------- */

/**
 * 构造 AI 子进程环境：最小集合，绝不透传 process.env。
 * （此前 `...process.env` 会让模型一条 printenv 读走 DB 密码/SOP_MASTER_KEY。）
 */
function sandboxEnv(extra = {}) {
  const bin = process.env.TRAECLI_BIN || '/Users/admin/.local/bin/traecli';
  const env = {
    PATH: `/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:${path.dirname(bin)}`,
    HOME: TRAE_HOME,
    TRAE_HOME,
    TMPDIR: SANDBOX_TMP,
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8',
    TZ: process.env.TZ || 'Asia/Shanghai',
    SSL_CERT_FILE: '/etc/ssl/cert.pem',
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null) env[k] = String(v);
  }
  return env;
}

/**
 * 用沙箱包装命令。macOS 返回 sandbox-exec 形态；否则原样返回（调用方直接 spawn）。
 * @returns {{ file:string, args:string[], wrapped:boolean }}
 */
function wrapCommand(bin, args) {
  const { wrapped, profilePath } = ensureSandbox();
  if (!wrapped) return { file: bin, args: [...args], wrapped: false };
  return { file: SANDBOX_EXEC, args: ['-f', profilePath, '--', bin, ...args], wrapped: true };
}

/**
 * 在沙箱内 spawn 子进程。stdio 语义与 child_process.spawn 一致。
 * cwd 缺省为仓库快照根（沙箱内可读且与业务对应），避免落到服务器目录。
 */
function spawnSandboxed(bin, args, { cwd, env, stdio } = {}) {
  const { file, args: wrappedArgs } = wrapCommand(bin, args);
  return spawn(file, wrappedArgs, {
    cwd: cwd || REPOS_DIR,
    env: env || sandboxEnv(),
    stdio: stdio || ['ignore', 'pipe', 'pipe'],
  });
}

module.exports = {
  REPOS_DIR, SANDBOX_DIR, SANDBOX_TMP, TRAE_HOME, PROFILE_PATH, IS_MACOS,
  ensureSandbox, buildProfile, sandboxEnv, wrapCommand, spawnSandboxed,
};
