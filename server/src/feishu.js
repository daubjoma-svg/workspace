// 飞书开放平台消息推送模块（Q1：A 飞书自建应用定向发个人）。
// 分层：只依赖 db/settings + secret 解密 + logger，不依赖 engine/路由，避免循环引用。
// 失败降级铁律：站内 notifications 是主渠道，飞书是增量——任何一步失败只记 warn，绝不 throw 回调用方。
// 唯一例外 sendFeishuTest：Admin 测试按钮需要把错误抛回 admin.js（转 400 给前端展示）。

'use strict';

const { db, getSetting, setSetting } = require('./db');
const secret = require('./crypto/secret');
const logger = require('./logger');
const { buildFeishuCard } = require('./feishu-templates');

const API_BASE = 'https://open.feishu.cn/open-apis';
// 卡片里「打开需求 →」的落地地址；部署时用环境变量覆盖（前端为 SPA，此处按 Spec 约定的 /requirements/:id 拼链接）
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:4000';
const REQUEST_TIMEOUT_MS = 10000;
// 飞书 tenant_access_token 有效期 2 小时；缓存 90 分钟后自动重取，避免每次发消息都换 token
const TOKEN_CACHE_TTL_MS = 90 * 60 * 1000;

const APP_ID_KEY = 'feishu.app_id';
const APP_SECRET_KEY = 'feishu.app_secret';

// 缓存按 app_id+app_secret 键控：sendFeishuTest 用临时凭据时不会污染已存配置的缓存
let tokenCache = { appId: null, appSecret: null, token: null, expiresAt: 0 };

/* ---------- 配置 ---------- */

async function getFeishuCfg() {
  const appId = ((await getSetting(APP_ID_KEY, '')) || '').trim();
  // app_secret 以 AES-256-GCM 密文落 settings；解不开按未配置处理，不崩服务
  const appSecret = secret.tryDecrypt((await getSetting(APP_SECRET_KEY, '')) || '', logger, { scope: 'feishu.app_secret' }) || '';
  return { appId, appSecret };
}

/** GET 响应用：只回 app_id 与是否已配置，绝不返回 app_secret 明文 */
async function maskedFeishuCfg() {
  const { appId, appSecret } = await getFeishuCfg();
  return { app_id: appId, configured: !!(appId && appSecret) };
}

/**
 * 保存配置：app_id 明文存；app_secret 加密存。
 * app_secret 为空串 / 前端 MASK 哨兵时保留原值（编辑表单只改 app_id 的场景）。
 */
async function setFeishuConfig({ app_id, app_secret }) {
  if (app_id != null) await setSetting(APP_ID_KEY, String(app_id).trim());
  if (app_secret != null && app_secret !== '' && !secret.isMaskSentinel(app_secret)) {
    await setSetting(APP_SECRET_KEY, secret.encrypt(app_secret));
  }
}

/* ---------- 飞书 API 调用（内部，失败抛错由外层收敛） ---------- */

async function getTenantAccessToken(appId, appSecret) {
  if (tokenCache.appId === appId && tokenCache.appSecret === appSecret
      && tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const res = await fetch(`${API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败：HTTP ${res.status} ${body.msg || body.code || ''}`);
  }
  tokenCache = { appId, appSecret, token: body.tenant_access_token, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS };
  return body.tenant_access_token;
}

// feishu_key 可能是 user_id 或邮箱：含 @ 走 batch_get_id 按邮箱查，否则按 user_id 直查。
// 统一返回 open_id（供 im/v1/messages?receive_id_type=open_id 使用）。
async function resolveOpenId(token, key) {
  const target = String(key || '').trim();
  if (!target) throw new Error('缺少飞书目标（user_id 或邮箱）');
  if (target.includes('@')) {
    const res = await fetch(`${API_BASE}/contact/v3/users/batch_get_id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ emails: [target] }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.code !== 0) {
      throw new Error(`按邮箱查询飞书用户失败：HTTP ${res.status} ${body.msg || body.code || ''}`);
    }
    const hit = (body.data?.user_list || []).find((u) => u.email === target || (u.emails || []).includes(target));
    const openId = hit && (hit.open_id || hit.user_id);
    if (!openId) throw new Error(`未找到邮箱 ${target} 对应的飞书用户`);
    return openId;
  }
  const res = await fetch(`${API_BASE}/contact/v3/users/${encodeURIComponent(target)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.code !== 0) {
    throw new Error(`按 user_id 查询飞书用户失败：HTTP ${res.status} ${body.msg || body.code || ''}`);
  }
  const openId = body.data?.user && (body.data.user.open_id || body.data.user.user_id);
  if (!openId) throw new Error(`未找到 user_id ${target} 对应的飞书用户`);
  return openId;
}

async function sendTextMessage(token, openId, text) {
  const res = await fetch(`${API_BASE}/im/v1/messages?receive_id_type=open_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.code !== 0) {
    throw new Error(`发送飞书消息失败：HTTP ${res.status} ${body.msg || body.code || ''}`);
  }
  return body.data;
}

// 富文本卡片（post）：content 直接传 buildFeishuCard 生成的卡片 JSON。
// 注意：im/v1/messages 的 post content 是语言对象 {"zh_cn":...}，不带 "post" 外层包装
// （"post" 包装是旧 webhook 机器人格式）。buildFeishuCard 为可读性保留 post 包装，这里发送前剥掉。
async function sendPostMessage(token, openId, cardJson) {
  const payload = cardJson && cardJson.post ? cardJson.post : cardJson;
  const res = await fetch(`${API_BASE}/im/v1/messages?receive_id_type=open_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: openId, msg_type: 'post', content: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.code !== 0) {
    throw new Error(`发送飞书消息失败：HTTP ${res.status} ${body.msg || body.code || ''}`);
  }
  return body.data;
}

// 发消息主链：有 event 走富文本卡片，event 缺失（旧调用/未知事件）回退文本，保证不崩
async function sendFeishuChain(appId, appSecret, targetKey, event, ctx, title, content) {
  const token = await getTenantAccessToken(appId, appSecret);
  const openId = await resolveOpenId(token, targetKey);
  const card = buildFeishuCard(event, { ...(ctx || {}), baseUrl: APP_BASE_URL });
  if (card) {
    await sendPostMessage(token, openId, card);
    return;
  }
  const text = `【AI-SOP 通知】${title || ''}\n${content || ''}`;
  await sendTextMessage(token, openId, text);
}

/* ---------- 对外入口 ---------- */

// engine.notify 的增量渠道：站内为主、飞书为增量。
// 新形态 sendFeishuToUser(userId, event, ctx, title, content)：event 存在走富文本卡片；
// 兼容旧形态 sendFeishuToUser(userId, title, content)：自动识别并回退文本。
// 未绑定 feishu_key / 应用未配置 → 静默跳过；链路任何失败 → 只 warn，绝不 throw。
async function sendFeishuToUser(userId, event, ctx, title, content) {
  // 旧形态兼容：第二个参数是标题字符串而非事件名，第三个参数是内容字符串
  if (typeof event === 'string' && typeof ctx === 'string' && title === undefined) {
    title = event;
    content = ctx;
    event = null;
    ctx = null;
  }
  try {
    const u = await db.one('SELECT feishu_key FROM users WHERE id=?', [userId]);
    if (!u || !u.feishu_key) return; // 未绑定，静默跳过
    const cfg = await getFeishuCfg();
    if (!cfg.appId || !cfg.appSecret) {
      logger.debug('feishu_not_configured', { userId });
      return; // 应用未配置，静默跳过
    }
    await sendFeishuChain(cfg.appId, cfg.appSecret, u.feishu_key, event, ctx, title, content);
  } catch (e) {
    logger.warn('feishu_send_failed', { userId, reason: e.message });
  }
}

// Admin 测试按钮入口：直接传参，不依赖已存配置；错误抛给调用方（admin.js 转 400）。
// 测试固定走文本消息，不套模板，保证按钮只验证"账号 + 凭据 + 收件人"链路。
async function sendFeishuTest(appId, appSecret, targetKey) {
  if (!appId || !appSecret) throw new Error('请先填写 app_id 与 app_secret');
  const token = await getTenantAccessToken(appId, appSecret);
  const openId = await resolveOpenId(token, targetKey);
  await sendTextMessage(token, openId, '【AI-SOP 通知】飞书推送测试\n这是一条来自 AI-SOP 系统的测试消息');
  return { ok: true };
}

module.exports = {
  sendFeishuToUser, sendFeishuTest,
  getFeishuCfg, maskedFeishuCfg, setFeishuConfig,
};
