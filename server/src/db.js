'use strict';

const mysql = require('mysql2/promise');
const logger = require('./logger');

/**
 * 服务端与本连接统一使用 UTC：TIMESTAMP 读回来是 UTC 墙钟、NOW() 也写 UTC 墙钟，
 * 与下面的 timezone 解析口径一致。否则本地 MySQL（SYSTEM=CST）会把时间戳整体偏移 8 小时，
 * 前端按 updated_at 计算的“已分析 N 秒”会算出负数并恒定显示 0。
 */
const DB_TIMEZONE = process.env.DB_TIMEZONE || '+00:00';

/**
 * MySQL 连接配置只允许来自运行环境，避免把生产凭据写入仓库。
 * MySQL 8 默认使用 utf8mb4，保证需求描述和提示词可以完整存储。
 */
const config = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'sop_app',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sop_system',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: DB_TIMEZONE,
};

const pool = mysql.createPool(config);

pool.pool.on('connection', (connection) => {
  connection.query(`SET time_zone = '${DB_TIMEZONE}'`, (error) => {
    if (error) logger.error('db_session_timezone_failed', { timezone: DB_TIMEZONE, reason: error.message });
  });
});

/** 执行写操作，返回 mysql2 的 affectedRows/insertId 等结果。 */
async function execute(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  // 兼容原有调用方的 better-sqlite3 返回字段，迁移期避免业务含义偏差。
  result.lastInsertRowid = result.insertId;
  result.changes = result.affectedRows;
  return result;
}

/** 查询最多一行记录。 */
async function one(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows[0] || null;
}

/** 查询多行记录。 */
async function many(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/**
 * 在同一连接中执行事务。业务回调抛错时自动回滚，避免多表操作部分成功。
 */
async function transaction(work) {
  const connection = await pool.getConnection();
  const tx = {
    execute: async (sql, params = []) => {
      const [result] = await connection.execute(sql, params);
      // 与顶层 execute 保持同一兼容层语义，否则事务内读取 result.changes 会得到 undefined。
      result.lastInsertRowid = result.insertId;
      result.changes = result.affectedRows;
      return result;
    },
    one: async (sql, params = []) => (await connection.execute(sql, params))[0][0] || null,
    many: async (sql, params = []) => (await connection.execute(sql, params))[0],
  };
  try {
    await connection.beginTransaction();
    const result = await work(tx);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/** 启动前探测连接，连接失败时给出不含凭据的日志上下文。 */
async function verifyConnection() {
  try {
    await pool.query('SELECT 1');
    logger.info('database_connected', { host: config.host, port: config.port, database: config.database });
  } catch (error) {
    logger.error('database_connection_failed', {
      host: config.host,
      port: config.port,
      database: config.database,
      reason: error.message,
    });
    throw error;
  }
}

async function close() {
  await pool.end();
}

async function getSetting(key, fallback = null) {
  const row = await one('SELECT value FROM settings WHERE `key`=?', [key]);
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  await execute(
    'INSERT INTO settings(`key`, value) VALUES(?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)',
    [key, String(value)],
  );
}

/**
 * 兼容层：SQLite 迁移期，历史代码统一以 `const { db } = require('./db')` 解构，
 * 再调用 db.one / db.many / db.execute / db.transaction。这里把同名助手聚合到 db 上，
 * 既保留新函数式导出，又避免逐个文件改调用点。新代码请优先用顶层函数导出。
 */
const db = { execute, one, many, transaction, pool, getSetting, setSetting, verifyConnection, close, config };

module.exports = {
  db,
  close,
  config,
  execute,
  getSetting,
  many,
  one,
  pool,
  setSetting,
  transaction,
  verifyConnection,
};
