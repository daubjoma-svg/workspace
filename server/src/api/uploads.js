// 图片上传接口（供前端富文本编辑器粘贴图片用）。
// POST /api/uploads —— body: { data: 'data:image/png;base64,iVBOR...' }
// 设计决策：
//   - 零新依赖：package.json 无 multer，故走 base64 JSON（Express 内置 express.json 即可解析）；
//   - auth 保护：仅登录用户可上传（静态读取 /uploads 无需鉴权，图片 URL 公开供 <img> 引用）；
//   - 白名单：data URL 前缀 + 文件魔数双重校验，杜绝伪装图片；
//   - 文件名由 Date.now()+randomBytes 生成，绝不拼接用户输入，杜绝路径穿越；
//   - 返回相对 URL（不含原始文件名），前端拼 http://localhost:4000 前缀。

'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { auth } = require('../authn');
const logger = require('../logger');

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const MAX_BYTES = 5 * 1024 * 1024; // 5MB

// data URL 类型白名单：data:image/<mime>;base64,<payload>
const ALLOWED = {
  'image/png': 'png',
  'image/jpg': 'jpg',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;

// 魔数校验：与声明类型一致才放行（防把文本/脚本改名成图片上传）
function magicMatches(mime, buf) {
  if (buf.length < 12) return false;
  if (mime === 'image/png') return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (mime === 'image/jpg' || mime === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'image/gif') return buf.slice(0, 4).toString('latin1') === 'GIF8';
  if (mime === 'image/webp') return buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP';
  return false;
}

router.post('/uploads', auth, (req, res) => {
  const data = req.body && req.body.data;
  if (typeof data !== 'string' || !data.startsWith('data:')) {
    return res.status(400).json({ error: '仅支持图片格式' });
  }
  const m = DATA_URL_RE.exec(data);
  if (!m) return res.status(400).json({ error: '仅支持图片格式' });
  const ext = ALLOWED[m[1]];
  if (!ext) return res.status(400).json({ error: '仅支持图片格式' });

  let buf;
  try {
    buf = Buffer.from(m[2], 'base64');
  } catch {
    return res.status(400).json({ error: '图片数据无法解码' });
  }
  if (buf.length === 0) return res.status(400).json({ error: '图片内容为空' });
  if (buf.length > MAX_BYTES) return res.status(400).json({ error: '图片超过 5MB 上限' });
  if (!magicMatches(m[1], buf)) return res.status(400).json({ error: '仅支持图片格式' });

  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  const filePath = path.join(UPLOADS_DIR, filename);
  try {
    fs.writeFileSync(filePath, buf);
  } catch (err) {
    logger.error('upload_write_failed', { reason: err.message });
    return res.status(500).json({ error: '图片保存失败' });
  }
  logger.info('upload_ok', { user_id: req.user.id, bytes: buf.length, type: m[1], file: filename });
  res.json({ ok: true, url: `/uploads/${filename}` });
});

module.exports = router;
