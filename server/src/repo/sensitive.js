// F2 敏感信息过滤（BLOCKER-6 根治，F3 硬前置）。
// L1 isSensitiveFile：按文件名/扩展名剔除，命中的文件永不进入 prompt。
// L2 redactSecrets：对通过 L1 的文件做内容嗅探，把疑似凭据的值替换掉，保留代码骨架。
// 两个都是纯函数，不碰 fs、不碰 db，正则测试集直接覆盖。

'use strict';

const REDACTED = '***REDACTED***';

// L1-a：整文件名匹配（配置文件本体）
const SENSITIVE_NAME_RE = [
  /^application([-.].*)?\.(properties|yml|yaml)$/i,   // Spring Boot
  /^bootstrap([-.].*)?\.(yml|yaml|properties)$/i,     // Spring Cloud
  /^logback([-.].*)?\.xml$/i,                         // 日志配置常含凭据引用
  /^(nacos|sentinel|seata|apollo).*\.(properties|yml|yaml|xml)$/i,
  /^(docker-compose|compose)([-.].*)?\.(yml|yaml)$/i,
  /^\.?env(\..*)?$/i,                                 // .env / .env.production / env
  /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/i,
  /^\.?(npmrc|netrc|pgpass|htpasswd)$/i,
  /^(kubeconfig|\.kube.?config)$/i,
];

// L1-b：文件名包含敏感词
const SENSITIVE_WORD_RE = /(credential|secret|password|passwd|private[-_.]?key|keystore|truststore|token[-_.]?store)/i;

// L1-c：扩展名黑名单（密钥/证书/密钥库）
const SENSITIVE_EXT_RE = /\.(env|key|pem|p12|jks|pfx|crt|cer|der|kdbx|asc|gpg|ppk)$/i;

/**
 * 判断某个仓库内相对路径是否敏感（命中即不注入 prompt）。
 * 只看路径本身，不读文件内容。
 */
function isSensitiveFile(relPath) {
  if (typeof relPath !== 'string' || relPath === '') return false;
  const norm = relPath.replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  if (SENSITIVE_EXT_RE.test(base)) return true;
  if (SENSITIVE_WORD_RE.test(base)) return true;
  if (SENSITIVE_NAME_RE.some((re) => re.test(base))) return true;
  // 目录级：.ssh/ 、secrets/ 下的任何文件
  if (/(^|\/)(\.ssh|secrets?|credentials?)\//i.test(norm)) return true;
  return false;
}

// L2：键值型凭据。捕获"键 + 分隔符"，只替换值，保留结构便于 AI 理解配置形状。
const KV_RULES = [
  // key: value / key = value / "key": "value"
  /(["']?\b(?:password|passwd|pwd|secret|secret[-_]?key|api[-_]?key|apikey|access[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|private[-_]?key|client[-_]?secret|db[-_]?password|jwt[-_]?secret)\b["']?\s*[:=]\s*)(["']?)([^\s"',;}\]]+)\2/gi,
  // JDBC / URI 内联口令：scheme://user:pass@host
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi,
  // Authorization: Bearer xxx / Basic xxx
  /(\b(?:bearer|basic)\s+)([A-Za-z0-9\-._~+/=]{12,})/gi,
];

// L2：整块/整串型凭据（无键名，靠形状识别）
const BLOCK_RULES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,                       // AWS Access Key ID
  /\bASIA[0-9A-Z]{16}\b/g,                       // AWS 临时凭证
  /\bAIza[0-9A-Za-z\-_]{35}\b/g,                 // Google API Key
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,             // GitHub token
  /\bglpat-[A-Za-z0-9\-_]{20,}\b/g,              // GitLab PAT
  /\bsk-[A-Za-z0-9]{20,}\b/g,                    // OpenAI 风格 key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,           // Slack token
];

/**
 * 对文件内容做脱敏。返回 { content, redactions }，redactions 为命中次数，用于观测。
 * 不改变行数与整体结构，只替换值。
 */
function redactSecretsDetailed(content) {
  if (typeof content !== 'string' || content === '') return { content: content || '', redactions: 0 };
  let out = content;
  let n = 0;
  for (const re of BLOCK_RULES) {
    out = out.replace(re, () => { n += 1; return REDACTED; });
  }
  for (const re of KV_RULES) {
    if (re.source.startsWith('(\\b[a-z]')) {
      out = out.replace(re, (_m, pre, _v, post) => { n += 1; return `${pre}${REDACTED}${post}`; });
    } else if (re.source.startsWith('(\\b(?:bearer')) {
      out = out.replace(re, (_m, pre) => { n += 1; return `${pre}${REDACTED}`; });
    } else {
      out = out.replace(re, (_m, pre, quote) => { n += 1; return `${pre}${quote}${REDACTED}${quote}`; });
    }
  }
  return { content: out, redactions: n };
}

function redactSecrets(content) {
  return redactSecretsDetailed(content).content;
}

module.exports = { REDACTED, isSensitiveFile, redactSecrets, redactSecretsDetailed };
