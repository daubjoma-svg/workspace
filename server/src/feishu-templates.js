// 飞书富文本卡片模板（msg_type:'post'）。
// 纯函数模块：不依赖 db / 路由，数据全部由调用方传入 ctx，方便单测与复用。
// P0-1：正文与标题一律不用 emoji 字符，链接用「打开需求 →」纯文本标记，分隔线用制表字符 ────。

'use strict';

const DEFAULT_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:4000';

// 角色 → 任务提示（NODE_ARRIVED 用；未知角色回落到通用提示）
const ROLE_TASK_HINT = {
  CSM: '请提交需求并确认',
  PO: '请评审需求，补充 PRD 文档后流转研发',
  RD: '请根据开发提示词开发，完成后提测',
  QA: '请执行测试用例，完成后确认上线',
};

const SEP = '────────';

function roleTaskHint(role) {
  return ROLE_TASK_HINT[role] || '请处理该需求';
}

function baseUrlOf(ctx) {
  return (ctx && ctx.baseUrl) || DEFAULT_BASE_URL;
}

/* ---------------- 文本片段 ---------------- */

function reqNo(req) {
  return req.req_no || `#${req.id}`;
}

function buildHeader(req) {
  return `需求：${req.title}（${reqNo(req)}）`;
}

function buildMeta(req) {
  const parts = [
    `优先级：${req.priority || 'P2'}`,
    `客户：${req.customer_name || '—'}`,
    `目标版本：${req.target_version || '待定'}`,
  ];
  return parts.join(' · ');
}

function buildFooter(req, ctx) {
  return `打开需求 → ${baseUrlOf(ctx)}/requirements/${req.id}`;
}

// 组装单段文本卡（content 内层为 tag/text 对象数组，符合飞书 post schema）
function card(title, bodyText) {
  return {
    post: {
      zh_cn: {
        title,
        content: [[{ tag: 'text', text: bodyText }]],
      },
    },
  };
}

/* ---------------- 4 种事件模板 ---------------- */

// 流转到人工节点：role = 收件人角色，决定任务提示
function buildNodeArrived(ctx) {
  const { req, node } = ctx;
  const nodeName = (node && node.name) || '';
  const hint = roleTaskHint(ctx.role);
  const sourceLabel = ctx.sourceName ? `${ctx.sourceName}(CSM)` : 'CSM';
  const body = [
    buildHeader(req),
    buildMeta(req),
    `来源：${sourceLabel} → 当前节点：${nodeName}`,
    SEP,
    `任务：${hint}`,
    '',
    buildFooter(req, ctx),
  ].join('\n');
  return card(`【待处理 · ${nodeName}】`, body);
}

// 打回：operator 打回到 targetName，附原因
function buildSendBack(ctx) {
  const { req } = ctx;
  const targetName = ctx.targetName || '';
  const body = [
    buildHeader(req),
    buildMeta(req),
    SEP,
    `${ctx.operator || '系统'} 打回到 ${targetName}：${ctx.reason || ''}`,
    '',
    '任务：请根据打回原因修改后重新提交',
    '',
    buildFooter(req, ctx),
  ].join('\n');
  return card(`【打回 · ${targetName}】`, body);
}

// 澄清：列出 AI 提出的问题
function buildClarify(ctx) {
  const { req } = ctx;
  const questions = Array.isArray(ctx.questions) ? ctx.questions : [];
  const lines = questions.map((q, i) => `${i + 1}. ${q}`).join('\n') || '（无具体问题）';
  const body = [
    buildHeader(req),
    buildMeta(req),
    SEP,
    'AI 提出了以下问题，请逐条回复：',
    lines,
    '',
    buildFooter(req, ctx),
  ].join('\n');
  return card(`【待澄清 · ${questions.length} 个问题】`, body);
}

// 完成：全流程走完
function buildDone(ctx) {
  const { req } = ctx;
  const body = [
    buildHeader(req),
    buildMeta(req),
    SEP,
    '全流程已走完，可归档',
    '',
    buildFooter(req, ctx),
  ].join('\n');
  return card('【已完成】', body);
}

// 测试完成（QA 节点确认后立即提醒 CSM）：不等到整个流程走完
function buildTestDone(ctx) {
  const { req } = ctx;
  const version = req.target_version || '待定';
  const body = [
    buildHeader(req),
    buildMeta(req),
    SEP,
    `测试已完成，等待目标版本 ${version} 即可上线`,
    '',
    buildFooter(req, ctx),
  ].join('\n');
  return card('【测试完成】', body);
}

/* ---------------- 出口 ---------------- */

/**
 * 按事件类型渲染飞书 post 卡片 content JSON。
 * @param {string} event NODE_ARRIVED | SEND_BACK | CLARIFY | DONE | TEST_DONE
 * @param {object} ctx  见各 build* 实现；ctx.baseUrl 可选，默认读 APP_BASE_URL
 * @returns {object|null} 飞书 post 的 content 对象；未知事件返回 null（调用方回退文本消息）
 */
function buildFeishuCard(event, ctx = {}) {
  switch (event) {
    case 'NODE_ARRIVED': return buildNodeArrived(ctx);
    case 'SEND_BACK': return buildSendBack(ctx);
    case 'CLARIFY': return buildClarify(ctx);
    case 'DONE': return buildDone(ctx);
    case 'TEST_DONE': return buildTestDone(ctx);
    default: return null;
  }
}

module.exports = { buildFeishuCard, roleTaskHint };
