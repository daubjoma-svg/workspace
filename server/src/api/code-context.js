// AC-12：GET /requirements/:id/code-context —— 回显本次 AI 实际读取的文件清单。
// openapi.yaml:232（需登录，任意角色）。路由层只做参数校验与包络，逻辑在 services/code-context-view。

'use strict';

const express = require('express');
const { auth } = require('./../authn');
const engine = require('./../engine');
const { ok, badRequest, notFound } = require('./../http/envelope');
const { buildCodeContextView } = require('./../services/code-context-view');

const router = express.Router();

router.get('/requirements/:id/code-context', auth, async (req, res, next) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return badRequest(res, '需求 ID 不合法');
  const requirement = await engine.getReq(id);
  if (!requirement) return notFound(res, `需求 #${id} 不存在`);
  try {
    return ok(res, await buildCodeContextView(requirement));
  } catch (e) {
    return next(e);   // 交给 index.js 兜底处理器，不向客户端泄漏路径与堆栈
  }
});

module.exports = router;
