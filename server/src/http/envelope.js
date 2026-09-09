// openapi.yaml components.schemas.Envelope 的服务端落地：{ code, data, message }。
// 仅供【新增】端点使用；存量裸 JSON 端点不改造（openapi.yaml:12-13 已声明）。

'use strict';

// 错误码与 openapi responses 示例对齐：1001 参数校验失败 / 1004 资源不存在
const CODE = { OK: 0, BAD_REQUEST: 1001, FORBIDDEN: 1003, NOT_FOUND: 1004, INTERNAL: 5000 };

function ok(res, data, message = '') {
  return res.json({ code: CODE.OK, data, message });
}

function fail(res, httpStatus, code, message) {
  return res.status(httpStatus).json({ code, data: null, message });
}

const badRequest = (res, message) => fail(res, 400, CODE.BAD_REQUEST, message);
const forbidden = (res, message = '无权操作') => fail(res, 403, CODE.FORBIDDEN, message);
const notFound = (res, message = '资源不存在') => fail(res, 404, CODE.NOT_FOUND, message);

/** 分页入参归一化：page >= 1，limit 1..max，非法值回落默认而不是抛 500 */
function pageParams(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const rawLimit = Number.parseInt(query.limit, 10);
  const limit = Math.min(maxLimit, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

function pageBody({ items, total, page, limit }) {
  return { items, total, page, limit, hasMore: page * limit < total };
}

module.exports = { CODE, ok, fail, badRequest, forbidden, notFound, pageParams, pageBody };
