'use strict';

const { db } = require('./db');
const secret = require('./crypto/secret');
const logger = require('./logger');

// 产品统一使用公司 Jira 站点，地址不由产品账号自行配置。
const DEFAULT_JIRA_BASE_URL = 'https://jira.fenbeijinfu.com';

const DEFAULT_FIELDS = {
  customer_name: '',
  product_manager: '',
  rd: '',
  fe: '',
  participants: '',
  reporter: '',
  qa: '',
  online_time: '',
  priority: '',
  modules: '',
};

// 同步得到的元数据放全局 settings：项目/需求类型/字段映射与具体账号无关，任一产品同步一次即可全员共用。
const SHARED_META_KEY = 'jira.shared_meta';

// Jira 自定义字段中文名 → 内部字段 key 的候选别名。站点上字段名由各团队自建，
// 先按精确同名匹配，再用包含匹配兜底（如「需求上线时间」命中「上线时间」）。
const FIELD_ALIASES = {
  customer_name: ['客户名称', '客户名'],
  product_manager: ['产品经理', '产品负责人'],
  rd: ['研发负责人', '开发负责人', '后端负责人'],
  fe: ['前端负责人'],
  participants: ['参与人员', '参与人', '相关人员'],
  reporter: ['报告人', '提出人', '需求提出人'],
  qa: ['QA', '测试负责人', '测试人员', '测试'],
  online_time: ['上线时间', '计划上线时间', '期望上线时间'],
  priority: ['优先级'],
  modules: ['业务模块', '所属模块'],
};

// Issue Type 命名各站点不统一，按常见叫法依次回退。
const ISSUE_TYPE_PREFERENCE = ['产品需求', '需求', 'Story', 'Task', '任务'];

// 这几个项目字段是产品常用的创建默认值；同步时缓存有限候选项，设置页可直接选择，避免手填中文导致值不合法。
const DEFAULT_VALUE_OPTION_FIELDS = new Set(['平台子业务线', '涉及的研发端', '归属BU']);

// 客户名称字段是 KHNAME 项目的问题选择器，只能关联该项目中的客户 issue。
// Jira 的字段过滤条件已固定为 project = KHNAME，跨项目单号会被 Jira 拒绝创建。
const CUSTOMER_ISSUE_PROJECT_KEY = 'KHNAME';

// 默认项目 Key：仅有系统级环境变量这一个「人工兜底」，其余情况一律由同步自动挑选。
function defaultProjectKey() {
  return String(process.env.JIRA_DEFAULT_PROJECT_KEY || '').trim();
}

function normalizeName(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

// 别名「包含匹配」的最小长度：中文别名不足 4 个字时只做精确同名，不做包含匹配。
// 否则「测试」「优先级」会命中「计划测试完成日期」（日期）「优先级排序」（数字）这类语义无关字段，
// 把人员名/优先级值塞进日期或数字字段，被 Jira 以 “Error parsing date string” 整单 400 拒绝。
const FUZZY_ALIAS_MIN_LENGTH = 4;

/** 字段名是否命中别名：优先精确同名，命中不了再对足够长的别名做包含匹配。 */
function matchAlias(name, aliases) {
  const n = normalizeName(name);
  const targets = aliases.map(normalizeName);
  if (targets.includes(n)) return true;
  return targets.some((t) => t.length >= FUZZY_ALIAS_MIN_LENGTH && n.includes(t));
}

/** 是否精确同名；用于在「精确 + 包含」两类命中里优先选取精确的那个。 */
function matchAliasExactly(name, aliases) {
  const n = normalizeName(name);
  return aliases.map(normalizeName).includes(n);
}

/** 带 Basic 认证的 Jira REST 调用；把 Jira 的错误信息原样抛给上层，便于前端提示。 */
async function jiraGet(profile, path) {
  const auth = Buffer.from(`${profile.username}:${profile.api_token}`).toString('base64');
  const response = await fetch(`${profile.base_url}${path}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    // 状态码必须带上：401/403 与「地址填错」是两类完全不同的排查方向
    const detail = payload?.errorMessages?.join('; ') || payload?.message || '';
    throw new Error(detail ? `${detail}（HTTP ${response.status}）` : `HTTP ${response.status}`);
  }
  return payload;
}

/**
 * 读取创建元数据（createmeta）。文档要点：不带 projectKeys 时只返回当前账号「有创建权限」的项目，
 * 因此它同时是「可创建项目清单」和「某项目可创建的问题类型 + 字段 schema（含 allowedValues）」的唯一来源。
 * 必须带 expand，否则不会返回字段清单与候选值。
 */
async function fetchCreateMeta(profile, projectKey) {
  const query = projectKey ? `?projectKeys=${encodeURIComponent(projectKey)}` : '?';
  const meta = await jiraGet(profile, `/rest/api/2/issue/createmeta${query}&expand=projects.issuetypes.fields`);
  return (meta?.projects || []).filter((p) => p && p.key);
}

/**
 * 用 Jira 字段清单匹配出内部字段映射。
 * 只取自定义字段：系统字段（如 priority）在 Jira API 里要传对象而非字符串，硬塞会直接创建失败。
 */
function matchFields(fields) {
  const custom = fields.filter((f) => f?.id && f.name && f.custom);
  const mapping = { ...DEFAULT_FIELDS };
  const unmapped = [];
  for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
    const exact = custom.find((f) => matchAliasExactly(f.name, aliases));
    const hit = exact || custom.find((f) => matchAlias(f.name, aliases));
    if (hit) mapping[key] = hit.id;
    else unmapped.push(key);
  }
  return { mapping, unmapped };
}

/**
 * 按「目标项目 + 问题类型」的 createmeta 字段清单重新匹配内部字段。
 * 共享元数据里的 field_mapping 是站点级快照，同一站点不同项目的字段配置并不一致
 * （例如「客户名称」在 PINGTAI 是必填的问题选择器 customfield_11811，在 ANDROID 是可选的标签 customfield_10604），
 * 直接复用会把字段值写到错误字段或被 Jira 以 “cannot be set” 拒绝。
 * 同名命中多个字段时优先取必填的那个，因为必填字段才是创建单子真正需要的。
 * 只匹配自定义字段：系统字段（priority 等）写入格式不同，由 Jira 默认值兜底。
 */
function matchSchemaFields(schemas) {
  const mapping = {};
  const unmapped = [];
  for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
    const candidates = Object.entries(schemas).filter(([, spec]) => spec?.schema?.custom && matchAlias(spec.name, aliases));
    // 必填字段优先于可选字段：同一业务名可能同时存在标签字段和真正的必填字段，
    // 例如「客户名称」与「客户名称：」并存时，必须绑定创建页面要求的那个字段，
    // 否则自动值会被写入无关标签字段，人工补填的必填字段又继续缺失。
    const exact = candidates.filter(([, spec]) => matchAliasExactly(spec.name, aliases));
    const required = candidates.filter(([, spec]) => spec.required);
    const pool = required.length ? required : (exact.length ? exact : candidates);
    const hit = pool.find(([, spec]) => matchAliasExactly(spec.name, aliases)) || pool[0];
    if (hit) mapping[key] = hit[0];
    else unmapped.push(key);
  }
  return { mapping, unmapped };
}

async function getSharedMeta() {
  const raw = await db.getSetting(SHARED_META_KEY, '');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    logger.warn('jira_shared_meta_parse_failed', { raw_length: String(raw).length });
    return null;
  }
}

/** 解析产品级 Jira 默认值；只接受 fieldId → 原始值映射，避免把凭据等无关数据写入配置。 */
function parseFieldDefaults(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .filter(([key, val]) => /^customfield_\d+$/.test(key) && val != null && String(val).trim() !== '')
      .slice(0, 100)
      .map(([key, val]) => [key, Array.isArray(val)
        ? val.map((v) => String(v).trim()).filter(Boolean).slice(0, 50)
        : String(val).trim().slice(0, 500)]));
  } catch {
    return {};
  }
}

/**
 * 同步 Jira 元数据（项目 / Issue Type / 自定义字段映射）并写入全局共享配置。
 * 调用方需保证凭据已落库；同步失败不回滚凭据，由上层决定提示方式。
 */
async function syncMeta(userId, profileOverride) {
  const profile = profileOverride || await getProfile(userId, true);
  if (!profile?.base_url || !profile?.username || !profile?.api_token) {
    throw new Error('请先填写 Jira 账号和密码');
  }
  // 默认项目必须从「可创建」清单里挑：/project 返回的是可见项目，账号未必有创建权限，
  // 早期按 Key 排序取首个会选中 ANDROID 这类只读项目，导致创建时报「没有可创建的问题类型」。
  let creatable;
  try {
    creatable = (await fetchCreateMeta(profile))
      .map((p) => ({ ...p, issuetypes: (p.issuetypes || []).filter((t) => t && !t.subtask) }))
      .filter((p) => p.issuetypes.length);
  } catch (e) {
    throw new Error(`同步失败（${profile.base_url}）：无法读取可创建项目：${e.message}`);
  }
  if (!creatable.length) throw new Error('该 Jira 账号在任何项目下都没有创建权限，请确认账号权限与项目角色');

  // 默认项目优先级：当前产品保存的项目 → 环境变量指定 → 站点主需求池 PINGTAI → 唯一可创建项目 → Key 排序首个。
  const envKey = defaultProjectKey();
  const configuredKey = String(profile.project_key || '').trim();
  const picked = creatable.find((p) => p.key === configuredKey)
    || creatable.find((p) => p.key === envKey)
    || creatable.find((p) => p.key === 'PINGTAI')
    || (creatable.length === 1 ? creatable[0] : null)
    || [...creatable].sort((a, b) => String(a.key).localeCompare(String(b.key)))[0];

  const issueType = ISSUE_TYPE_PREFERENCE
    .map((name) => picked.issuetypes.find((t) => t.name === name))
    .find(Boolean)?.name || picked.issuetypes[0]?.name || '';

  const fields = await jiraGet(profile, '/rest/api/2/field');
  const { mapping, unmapped } = matchFields(Array.isArray(fields) ? fields : []);

  const syncer = await db.one('SELECT name, username FROM users WHERE id=?', [userId]);
  const meta = {
    base_url: profile.base_url,
    project_key: picked.key,
    project_name: picked.name || '',
    project_candidates: creatable.map((p) => ({ key: p.key, name: p.name || '' })),
    issue_type: issueType,
    field_mapping: mapping,
    unmapped_fields: unmapped,
    synced_at: new Date().toISOString(),
    synced_by: { id: userId, name: syncer?.name || syncer?.username || '' },
    // 产品级默认值配置只需要字段描述，不缓存 allowedValues，避免把数千条客户候选写进 settings。
    create_fields: Object.entries(picked.issuetypes.find((t) => t.name === issueType)?.fields || {})
      .filter(([, spec]) => spec?.schema?.custom)
      .map(([id, spec]) => ({
        id,
        name: spec.name || id,
        required: !!spec.required,
        type: spec.schema?.type || 'string',
        items: spec.schema?.items || '',
        custom: spec.schema?.custom || '',
        allowed_values: DEFAULT_VALUE_OPTION_FIELDS.has(spec.name) && Array.isArray(spec.allowedValues)
          ? spec.allowedValues.slice(0, 200).map((o) => ({ id: String(o.id ?? o.value ?? ''), value: String(o.value ?? o.name ?? '') })).filter((o) => o.value)
          : [],
      })),
  };
  await db.setSetting(SHARED_META_KEY, JSON.stringify(meta));
  logger.info('jira_meta_synced', {
    user_id: userId,
    project_key: meta.project_key,
    issue_type: meta.issue_type,
    creatable_project_count: creatable.length,
    mapped_field_count: Object.values(mapping).filter(Boolean).length,
  });
  return meta;
}

function parseMapping(value) {
  if (!value) return { ...DEFAULT_FIELDS };
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return { ...DEFAULT_FIELDS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULT_FIELDS };
  }
}

/**
 * 取账号的 Jira 配置：凭据按账号独立，项目/类型/字段映射读全局共享元数据。
 * 存量账号在同步前仍回退到 users 表里的旧值，避免升级后一键创建直接失效。
 */
async function getProfile(userId, includeSecret = false) {
  const row = await db.one(
    'SELECT id,jira_base_url,jira_username,jira_api_token_enc,jira_project_key,jira_issue_type,jira_field_mapping,jira_field_defaults FROM users WHERE id=?',
    [userId]
  );
  if (!row) return null;
  const shared = await getSharedMeta();
  const out = {
    base_url: DEFAULT_JIRA_BASE_URL,
    username: row.jira_username || '',
    token_configured: !!row.jira_api_token_enc,
    // 产品单独配置优先于全局同步默认值，允许不同产品选择不同默认项目。
    project_key: row.jira_project_key || shared?.project_key || '',
    issue_type: row.jira_issue_type || shared?.issue_type || '产品需求',
    field_mapping: shared?.field_mapping || parseMapping(row.jira_field_mapping),
    field_defaults: parseFieldDefaults(row.jira_field_defaults),
    sync: shared
      ? {
        project_name: shared.project_name || '',
        project_candidates: shared.project_candidates || [],
        unmapped_fields: shared.unmapped_fields || [],
        synced_at: shared.synced_at || '',
        synced_by: shared.synced_by || null,
        stale: !!shared.base_url && shared.base_url !== DEFAULT_JIRA_BASE_URL,
        create_fields: shared.create_fields || [],
      }
      : null,
  };
  if (includeSecret) out.api_token = secret.tryDecrypt(row.jira_api_token_enc, logger, { user_id: userId }) || '';
  return out;
}

/**
 * 保存账号的 Jira 凭据（地址/账号/密码），保存成功后自动同步一次共享元数据。
 * 同步失败只回传原因，不清空已保存的凭据，避免用户反复重填。
 */
async function saveProfile(userId, body) {
  const current = await db.one('SELECT * FROM users WHERE id=?', [userId]);
  if (!current) throw new Error('用户不存在');
  // 地址固定为公司 Jira 站点，忽略客户端传入值并回写历史账号的旧地址。
  const baseUrl = DEFAULT_JIRA_BASE_URL;
  const username = String(body.username ?? current.jira_username ?? '').trim();
  const projectKey = String(body.project_key ?? current.jira_project_key ?? '').trim();
  const issueType = String(body.issue_type ?? current.jira_issue_type ?? '').trim();
  let token = current.jira_api_token_enc;
  if (body.api_token !== undefined && body.api_token !== '__KEEP__' && !secret.isMaskSentinel(body.api_token)) {
    token = secret.encrypt(String(body.api_token || '').trim());
  }
  const fieldDefaults = body.field_defaults === undefined
    ? parseFieldDefaults(current.jira_field_defaults)
    : parseFieldDefaults(body.field_defaults);
  await db.execute(
    'UPDATE users SET jira_base_url=?,jira_username=?,jira_api_token_enc=?,jira_project_key=?,jira_issue_type=?,jira_field_defaults=? WHERE id=?',
    [baseUrl || null, username || null, token, projectKey || null, issueType || null, JSON.stringify(fieldDefaults), userId]
  );
  // 只记录操作者与配置范围，不落 Jira 密码/Token。
  logger.info('jira_profile_saved', {
    user_id: userId,
    has_base_url: !!baseUrl,
    has_username: !!username,
    token_configured: !!token,
    default_field_count: Object.keys(fieldDefaults).length,
  });
  const profile = await getProfile(userId, true);
  try {
    await syncMeta(userId, profile);
  } catch (e) {
    logger.warn('jira_meta_sync_failed', { user_id: userId, reason: String(e.message || e).slice(0, 240) });
    profile.sync_error = e.message;
  }
  const saved = await getProfile(userId);
  saved.sync_error = profile.sync_error;
  return saved;
}

// 从需求自动推导可默认带入 Jira 的字段值：人员、上线时间（目标版本）、优先级、业务模块。
// 人员类字段返回数组（Jira 的多用户选择器需要数组），描述文案再按需拼接。
async function describeValues(req) {
  const assignees = [...new Set([req.rd_name, req.fe_name, req.qa_name].filter(Boolean))];
  const moduleNames = await resolveModuleNames(req.id);
  const logins = await resolveUserLogins(req);
  return {
    customer_name: req.customer_name || '',
    product_manager: req.po_name || '',
    rd: req.rd_name || '',
    fe: req.fe_name || '',
    participants: assignees,
    reporter: req.csm_name || '',
    qa: req.qa_name || '',
    online_time: req.target_version || req.expect_date || '',
    priority: req.priority || '',
    modules: moduleNames,
    // 显示名 → Jira 登录名：成员在用户管理里配置过 Jira 账号时优先直用，避免反查失败
    logins,
  };
}

/** 取需求相关人员已配置的 Jira 登录名（显示名 → username），未配置的不返回。 */
async function resolveUserLogins(req) {
  const ids = [req.csm_id, req.po_id, req.rd_id, req.fe_id, req.qa_id].filter(Boolean);
  if (!ids.length) return {};
  try {
    const rows = await db.many(
      `SELECT name, jira_username FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    const map = {};
    for (const row of rows) if (row.name && row.jira_username) map[row.name] = row.jira_username;
    return map;
  } catch {
    return {};
  }
}

async function resolveModuleNames(reqId) {
  if (!reqId) return '';
  try {
    const rows = await db.many(
      `SELECT bm.name FROM requirement_business_modules rbm
        JOIN business_modules bm ON bm.id = rbm.business_module_id
        WHERE rbm.requirement_id=? ORDER BY bm.name`,
      [reqId]
    );
    return rows.map((r) => r.name).filter(Boolean).join(', ');
  } catch {
    return '';
  }
}

function toPlainText(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .trim();
}

/** 描述文案里的人员展示：数组用「、」连接，非数组直接转字符串。 */
function joinNames(value) {
  return (Array.isArray(value) ? value : [value]).filter(Boolean).join('、');
}

/** 拆出可枚举的字符串集合：兼容数组与「逗号/顿号/分号」分隔的文本。 */
function toArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value || '').split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean);
}

/** Jira 候选项名称本身可能含顿号或逗号；精确命中时保留完整名称，避免拆成无效选项。 */
function toOptionValues(value, allowedValues) {
  if (typeof value === 'string' && isAllowedOption(allowedValues, value)) return [value];
  return toArray(value);
}

/**
 * 把界面上的显示名解析为 Jira 可写入的用户名。
 * 优先用成员在用户管理里配置的 Jira 登录名：Jira 只认用户名，中文显示名经 user/picker 反查经常落空，
 * 而必填的人员字段一旦解析不到就会被整单拒绝。未配置时才回退到 user/picker。
 * 解析结果按本次创建调用缓存，避免同一人重复请求；解析失败返回 null 由调用方跳过该字段。
 */
async function resolveJiraUser(profile, displayName, cache, logins) {
  const key = String(displayName || '').trim();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  let name = logins?.[key] || null;
  if (!name) {
    try {
      const res = await jiraGet(profile, `/rest/api/2/user/picker?query=${encodeURIComponent(key)}&maxResults=20`);
      const users = Array.isArray(res) ? res : (res?.users || []);
      const hit = users.find((u) => u.displayName === key)
        || users.find((u) => String(u.displayName || '').includes(key))
        || null;
      name = hit?.name || null;
    } catch (e) {
      logger.warn('jira_user_resolve_failed', { query: key, reason: String(e.message || e).slice(0, 160) });
    }
  }
  cache.set(key, name);
  return name;
}

/**
 * 值是否命中 Jira 该字段的候选值（createmeta allowedValues，按 value 或 id 比对）。
 * 无候选值时不做限制；有候选值却对不上时返回 false，交由调用方跳过该字段：
 * 提交不在候选内的值会被 Jira 以 “The value is not valid for field” 整单 400。
 */
function isAllowedOption(allowedValues, value) {
  if (!Array.isArray(allowedValues) || !allowedValues.length) return true;
  return allowedValues.some((o) => String(o.value) === String(value) || String(o.id) === String(value));
}

/**
 * 按 Jira 字段 schema 生成合法的写入值，格式依据 Jira DC REST API 文档「Field input formats」。
 * 各类字段的写入形态差异很大（人员/组/版本是对象、选项是 {value}、数字必须是数字而非字符串），
 * 直接塞字符串是「创建失败」的常见根因。
 * 除形态之外还按 schema 做取值合法性校验（日期格式、候选值范围）：对不上就返回 undefined 跳过，
 * 由调用方按「必填字段缺值」提示用户补填，避免一个字段把整单创建打回。
 */
async function buildFieldValue(profile, spec, value, cache, logins) {
  const schema = spec?.schema || {};
  const allowed = Array.isArray(spec?.allowedValues) ? spec.allowedValues : [];
  const type = schema.type;
  const items = schema.items;
  // 自定义字段类型后缀（userpicker / multiselect / labels…）：自定义字段的 type 会被 Jira 归一化，
  // 例如下拉框的 type 就是 string，只能靠 custom 区分，不能只看 type。
  const custom = String(schema.custom || '');
  const suffix = custom ? custom.slice(custom.lastIndexOf(':') + 1) : '';

  // 人员字段：单选 {name}，多选 [{name}]
  if (type === 'user' || items === 'user') {
    const resolved = await Promise.all(toArray(value).map((n) => resolveJiraUser(profile, n, cache, logins)));
    const users = [...new Set(resolved.filter(Boolean))].map((name) => ({ name }));
    if (!users.length) return undefined;
    return type === 'array' ? users : users[0];
  }
  // 用户组字段：按 name 引用，格式同人员
  if (type === 'group' || items === 'group') {
    const groups = toArray(value).map((name) => ({ name }));
    return type === 'array' ? groups : groups[0];
  }
  // 版本字段（fixVersions 及各团队的「上线时间」版本选择器）：按 name 引用，且必须是该项目已有版本
  if (type === 'version' || items === 'version' || suffix === 'version' || suffix === 'multiversion') {
    const versions = toArray(value).filter((v) => isAllowedOption(allowed, v)).map((name) => ({ name }));
    if (!versions.length) return undefined;
    return type === 'array' || suffix === 'multiversion' ? versions : versions[0];
  }
  // labels 字段：单纯的字符串数组
  if (suffix === 'labels' || (type === 'array' && items === 'string')) {
    const arr = toArray(value);
    return arr.length ? arr : undefined;
  }
  // 选项类字段（下拉/单选按钮 = {value}；多选/复选框 = [{value}]），传字符串会被 400 拒绝。
  // multicheckboxes 是多选复选框的官方后缀，漏掉它会把值当成纯字符串数组提交，被 Jira 拒绝。
  // cascadingselect（option-with-child）需要 { value, child: { value } }，这里至少提交父级。
  if (suffix === 'select' || suffix === 'radiobuttons' || suffix === 'multiselect'
    || suffix === 'multicheckboxes' || suffix === 'checkbox' || suffix === 'cascadingselect') {
    // 只保留在候选值范围内的选项；自动带入的值（如中文优先级）对不上时整字段跳过，交给用户补填。
    const opts = toOptionValues(value, allowed).filter((v) => isAllowedOption(allowed, v)).map((v) => ({ value: v }));
    if (!opts.length) return undefined;
    const single = suffix === 'select' || suffix === 'radiobuttons' || suffix === 'cascadingselect';
    return single ? opts[0] : opts;
  }
  // 问题选择器（如「客户名称：」）：ScriptRunner 的 issue-picker 字段只接受「单号字符串」或字符串数组，
  // 传 {key}/{id} 对象会被 Jira 以 “string expected at index 0” 整单 400 拒绝（已在真实站点验证）。
  // 只接受合法单号（PINGTAI-123）或纯数字 ID；需求里自动带入的「客户名称」是纯文本，无法反查成单号，
  // 这里过滤掉非法值，由前端弹窗让产品手动补填，避免整单因一个字段失败。
  if (suffix === 'issue-picker-cf' || suffix === 'multiple-issue-picker-cf' || items === 'issuelinks') {
    const refs = toArray(value)
      .map((t) => (/^\d+$/.test(t) ? t : (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(t) ? t.toUpperCase() : null)))
      .filter(Boolean);
    if (!refs.length) return undefined;
    return suffix === 'issue-picker-cf' ? refs[0] : refs;
  }
  // 数字字段必须是数字类型，官方明确「not a number in a string」
  if (type === 'number' || suffix === 'float') {
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  }
  // 日期必须是 YYYY-MM-DD；日期时间必须是可解析的 ISO 8601。
  // 需求里的「上线时间」多为版本号（26M10V1），一旦被别名误匹配到日期字段就是 “Error parsing date string”，
  // 这里先把非法格式挡掉，不能解析就跳过该字段。
  if (type === 'date') {
    const s = String(value).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
  }
  if (type === 'datetime') {
    const s = String(value).trim();
    return Number.isNaN(Date.parse(s)) ? undefined : s;
  }
  if (type === 'string') return String(value);
  if (type === 'array') {
    const arr = toArray(value);
    return arr.length ? arr : undefined;
  }
  return undefined;
}

async function createIssue(req, userId, overrides = {}) {
  const profile = await getProfile(userId, true);
  if (!profile || !profile.base_url || !profile.username || !profile.api_token) {
    throw new Error('请先在 Jira 设置中填写地址、账号和 API Token');
  }
  const projectKey = String(overrides.project_key || profile.project_key || defaultProjectKey()).trim();
  if (!projectKey) {
    throw new Error('缺少项目 Key：请在 Jira 设置中保存配置以完成自动同步，或配置环境变量 JIRA_DEFAULT_PROJECT_KEY');
  }
  const values = await describeValues(req);
  const description = [
    toPlainText(overrides.description || req.description || ''),
    '',
    '--- 需求协作信息 ---',
    `客户名称：${values.customer_name || '未填写'}`,
    `产品经理：${values.product_manager || '未指派'}`,
    `研发负责人：${values.rd || '未指派'}`,
    `前端负责人：${values.fe || '未指派'}`,
    `参与人员：${joinNames(values.participants) || '未指派'}`,
    `报告人：${values.reporter || '未填写'}`,
    `QA：${joinNames(values.qa) || '未指派'}`,
    `上线时间：${values.online_time || '未指定'}`,
    `优先级：${values.priority || '未指定'}`,
    `业务模块：${values.modules || '未指定'}`,
  ].join('\n');
  // 项目/类型以 createmeta 为准：用户可切换项目，共享元数据里的默认类型未必在该项目下存在。
  // 旧实现用共享元数据的类型名去查 createmeta，一旦该项目没有该类型就查不到字段，进而把全部字段原样提交并整单失败。
  let issueType = String(overrides.issue_type || profile.issue_type || '').trim();
  let fieldSchemas = null;
  try {
    const meta = await jiraGet(profile, `/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&expand=projects.issuetypes.fields`);
    const types = (meta?.projects?.[0]?.issuetypes || []).filter((t) => t && !t.subtask);
    // 文档：createmeta 只返回当前账号「有创建权限」的项目；查不到类型基本就是没权限或创建屏幕未配置。
    if (!types.length) {
      throw new Error(`当前 Jira 账号在项目 ${projectKey} 下没有可创建的问题类型，请确认创建权限与创建屏幕配置`);
    }
    const picked = types.find((t) => t.name === issueType)
      || ISSUE_TYPE_PREFERENCE.map((name) => types.find((t) => t.name === name)).find(Boolean)
      || types[0];
    issueType = picked.name;
    if (picked.fields && typeof picked.fields === 'object') fieldSchemas = picked.fields;
  } catch (e) {
    // 拿不到创建元数据就无从判断字段的合法写入格式，继续提交只会得到含糊的 400，直接失败并说明原因。
    logger.warn('jira_create_meta_failed', { user_id: userId, project_key: projectKey, reason: String(e.message || e).slice(0, 180) });
    throw new Error(`无法获取 Jira 项目 ${projectKey} 的创建配置：${e.message}`);
  }
  const fields = {
    project: { key: projectKey },
    summary: String(overrides.summary || req.title).trim(),
    description,
    issuetype: { name: issueType || 'Task' },
  };
  // 客户端补填的必填字段（fieldId → 原始值）：与自动带入值合并，客户端优先。
  const extraFields = overrides.fields && typeof overrides.fields === 'object' ? overrides.fields : {};
  if (!fieldSchemas) {
    // 极少数站点不返回字段清单：只提交基础字段，协作信息已写进描述，至少保证单子能建出来。
    logger.warn('jira_createmeta_fields_missing', { user_id: userId, project_key: projectKey, issue_type: issueType });
  } else {
    const cache = new Map();
    // 以目标项目的 createmeta 字段清单为准重新匹配，避免复用其他项目的过期字段 ID。
    const { mapping } = matchSchemaFields(fieldSchemas);
    for (const [name, fieldId] of Object.entries(mapping)) {
      if (!fieldId) continue;
      const spec = fieldSchemas[fieldId];
      // 字段不在该项目/类型的创建页面时直接跳过；硬塞会触发 “cannot be set” 并导致整单失败。
      if (!spec) continue;
      const raw = values[name];
      const value = raw == null || raw === '' ? undefined : await buildFieldValue(profile, spec,raw, cache, values.logins);
      if (value !== undefined) fields[fieldId] = value;
    }
    // 产品默认值只补空缺字段；需求自动带入值优先，弹窗额外填写值最后覆盖默认值。
    for (const [fieldId, raw] of Object.entries(profile.field_defaults || {})) {
      if (fields[fieldId] !== undefined) continue;
      const spec = fieldSchemas[fieldId];
      if (!spec || raw == null || raw === '') continue;
      if (fieldId === mapping.customer_name) {
        const invalid = toArray(raw).find((value) => !new RegExp(`^${CUSTOMER_ISSUE_PROJECT_KEY}-\\d+$`, 'i').test(value));
        if (invalid) {
          logger.warn('jira_customer_default_invalid', { user_id: userId, field_id: fieldId });
          continue;
        }
      }
      const value = await buildFieldValue(profile, spec, raw, cache, values.logins);
      if (value !== undefined) fields[fieldId] = value;
    }
    for (const [fieldId, raw] of Object.entries(extraFields)) {
      const spec = fieldSchemas[fieldId];
      if (!spec) continue;
      // 客户名称问题选择器的 Jira 过滤器固定为 KHNAME；即使前端手上残留旧单号，也要在服务端拦截。
      if (fieldId === mapping.customer_name) {
        const invalid = toArray(raw).find((value) => !new RegExp(`^${CUSTOMER_ISSUE_PROJECT_KEY}-\\d+$`, 'i').test(value));
        if (invalid) {
          throw new Error(`客户名称必须选择 ${CUSTOMER_ISSUE_PROJECT_KEY} 项目中的客户，不能使用 ${invalid}`);
        }
      }
      const value = raw == null || raw === '' ? undefined : await buildFieldValue(profile, spec,raw, cache, values.logins);
      if (value !== undefined) fields[fieldId] = value;
    }
    // 必填字段最终没有可用值时，Jira 只会回一句 “XX is required”；这里提前失败并指名道姓，
    // 产品才能判断是该在弹窗补填、补需求指派，还是给成员配 Jira 账号。
    // reporter 留空时 Jira 自动取当前账号，priority 有默认值，两者不计入缺失。
    const selfDefaulted = new Set(['summary', 'description', 'project', 'issuetype', 'reporter', 'priority']);
    const missing = Object.entries(fieldSchemas)
      .filter(([id, spec]) => spec?.required && !spec.hasDefaultValue && !selfDefaulted.has(id) && fields[id] === undefined)
      .map(([, spec]) => spec.name || '未知字段');
    if (missing.length) {
      throw new Error(`Jira 必填字段缺少可用值：${missing.join('、')}。请在创建弹窗中补填这些字段，或补齐需求指派信息`);
    }
  }
  const endpoint = `${profile.base_url}/rest/api/2/issue`;
  const auth = Buffer.from(`${profile.username}:${profile.api_token}`).toString('base64');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ fields }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Jira 的 errors 值可能是字符串、数组或对象；统一展开，避免前端只看到 [object Object]。
    const fieldErrors = Object.entries(payload.errors || {})
      .map(([field, reason]) => `${field}: ${Array.isArray(reason) ? reason.join('；') : String(reason)}`)
      .join('；');
    const detail = payload.errorMessages?.join('; ') || fieldErrors || `HTTP ${response.status}`;
    logger.warn('jira_issue_create_failed', { user_id: userId, status: response.status, reason: detail.slice(0, 240) });
    throw new Error(`Jira 创建失败：${detail}`);
  }
  const key = payload.key;
  if (!key) throw new Error('Jira 返回结果缺少 issue key');
  logger.info('jira_issue_created', { requirement_id: req.id, user_id: userId, issue_key: key });
  return { key, url: `${profile.base_url}/browse/${encodeURIComponent(key)}`, self: payload.self || null };
}

/**
 * 按关键字检索 Jira 单号，供弹窗里「问题选择器」类必填字段（如客户名称）搜索候选。
 * 只读查询：返回单号 + 摘要，交由产品在弹窗里人工确认，避免按名称模糊匹配自动绑定到错误的客户。
 */
async function searchIssues(userId, query, fieldId) {
  const profile = await getProfile(userId, true);
  if (!profile || !profile.base_url || !profile.username || !profile.api_token) {
    throw new Error('请先在 Jira 设置中填写地址、账号和 API Token');
  }
  const q = String(query || '').trim();
  const clauses = [];
  // 客户名称问题选择器的 Jira 过滤器要求 project = KHNAME；不加项目条件会搜到 DJ-7022 等非法单号。
  if (String(fieldId || '').trim() === 'customfield_11811') {
    clauses.push(`project = ${CUSTOMER_ISSUE_PROJECT_KEY}`);
  }
  // JQL 字面量需转义反斜杠与双引号，否则关键字里的特殊字符会让整条 JQL 语法报错。
  if (q) {
    const literal = q.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    clauses.push(`summary ~ "${literal}"`);
  }
  if (!clauses.length) return [];
  const jql = `${clauses.join(' AND ')} ORDER BY summary ASC`;
  const res = await jiraGet(profile, `/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=30`);
  return (res?.issues || []).map((it) => ({
    key: it.key,
    summary: it.fields?.summary || '',
  }));
}

/**
 * 创建弹窗所需的只读元数据：某项目可创建的问题类型、缺失的必填字段及产品常用默认字段。
 * 不写任何 Jira 数据；默认值必须按当前创建屏幕校验，避免跨项目候选值导致创建失败。
 */
async function getCreateForm(userId, req, projectKey, issueTypeName) {
  const profile = await getProfile(userId, true);
  if (!profile || !profile.base_url || !profile.username || !profile.api_token) {
    throw new Error('请先在 Jira 设置中填写地址、账号和 API Token');
  }
  const key = String(projectKey || profile.project_key || defaultProjectKey()).trim();
  if (!key) throw new Error('缺少项目 Key：请先在 Jira 设置中保存配置完成同步');
  const meta = (await fetchCreateMeta(profile, key))[0];
  const types = (meta?.issuetypes || []).filter((t) => t && !t.subtask);
  if (!types.length) {
    throw new Error(`当前 Jira 账号在项目 ${key} 下没有可创建的问题类型，请确认创建权限与创建屏幕配置`);
  }
  const preferred = String(issueTypeName || profile.issue_type || '').trim();
  const picked = types.find((t) => t.name === preferred)
    || ISSUE_TYPE_PREFERENCE.map((n) => types.find((t) => t.name === n)).find(Boolean)
    || types[0];

  const schemas = picked.fields && typeof picked.fields === 'object' ? picked.fields : {};
  // 系统字段由创建流程自带（概要/描述/经办人由 Jira 取当前账号），不必让用户重复填写。
  const selfHandled = new Set(['summary', 'description', 'project', 'issuetype', 'reporter', 'priority']);
  // 用真实的字段构造逻辑试算，只有确实能自动构造出合法值的字段才隐去，避免前端隐藏了却仍被 Jira 判必填。
  const values = await describeValues(req);
  const cache = new Map();
  const { mapping } = matchSchemaFields(schemas);
  const autoIds = new Set(selfHandled);
  for (const [name, fieldId] of Object.entries(mapping)) {
    const spec = schemas[fieldId];
    if (!spec) continue;
    const v = values[name] || profile.field_defaults?.[fieldId];
    if (v == null || v === '') continue;
    const built = await buildFieldValue(profile, spec,v, cache, values.logins);
    if (built !== undefined) autoIds.add(fieldId);
  }
  // 没有内部别名的自定义字段（如簇群分类、归属 BU）也可由当前产品默认值满足必填要求。
  for (const [fieldId, raw] of Object.entries(profile.field_defaults || {})) {
    if (autoIds.has(fieldId)) continue;
    const spec = schemas[fieldId];
    if (!spec || raw == null || raw === '') continue;
    const built = await buildFieldValue(profile, spec, raw, cache, values.logins);
    if (built !== undefined) autoIds.add(fieldId);
  }
  const fieldMeta = (id, spec) => ({
    id,
    name: spec.name || id,
    type: spec.schema?.type || 'string',
    items: spec.schema?.items || '',
    custom: spec.schema?.custom || '',
    allowed_values: (spec.allowedValues || []).map((o) => ({ id: String(o.id ?? o.value), value: String(o.value ?? o.name ?? '') })),
  });
  const requiredFields = Object.entries(schemas)
    .filter(([id, spec]) => spec?.required && !spec.hasDefaultValue && !autoIds.has(id))
    .map(([id, spec]) => fieldMeta(id, spec));
  const defaultFields = [];
  for (const [id, spec] of Object.entries(schemas)) {
    if (!spec?.schema?.custom || !DEFAULT_VALUE_OPTION_FIELDS.has(spec.name)) continue;
    const raw = profile.field_defaults?.[id];
    const built = raw == null || raw === '' ? undefined : await buildFieldValue(profile, spec, raw, cache, values.logins);
    const allowed = (spec.allowedValues || []).map((o) => ({ id: String(o.id ?? o.value), value: String(o.value ?? o.name ?? '') }));
    // 配置可能存的是候选 id；弹窗控件使用显示值，且不能回显已从当前项目移除的选项。
    const selected = built === undefined ? [] : toOptionValues(raw, allowed)
      .map((v) => allowed.find((o) => o.id === v || o.value === v)?.value || (!allowed.length ? v : ''))
      .filter(Boolean);
    if (raw != null && raw !== '' && !selected.length) {
      logger.warn('jira_create_default_invalid', { user_id: userId, project_key: key, field_id: id });
    }
    defaultFields.push({ ...fieldMeta(id, spec), default_value: spec.schema?.type === 'array' ? selected : (selected[0] || '') });
  }
  return {
    project_key: key,
    project_name: meta?.name || '',
    issue_type: picked.name,
    issue_types: types.map((t) => t.name),
    required_fields: requiredFields,
    default_fields: defaultFields,
  };
}

/** 按目标产品的凭据和所选项目读取常用默认字段，不依赖其他产品最后一次同步的共享快照。 */
async function getDefaultFields(userId, projectKey, issueTypeName) {
  const profile = await getProfile(userId, true);
  if (!profile?.base_url || !profile?.username || !profile?.api_token) {
    throw new Error('请先保存 Jira 账号和密码');
  }
  const key = String(projectKey || profile.project_key || defaultProjectKey()).trim();
  if (!key) throw new Error('请先选择默认项目');
  const meta = (await fetchCreateMeta(profile, key)).find((p) => p.key === key);
  const types = (meta?.issuetypes || []).filter((t) => t && !t.subtask);
  const preferred = String(issueTypeName || profile.issue_type || '').trim();
  const picked = types.find((t) => t.name === preferred)
    || ISSUE_TYPE_PREFERENCE.map((name) => types.find((t) => t.name === name)).find(Boolean)
    || types[0];
  if (!picked) throw new Error(`当前 Jira 账号在项目 ${key} 下没有创建权限`);
  return Object.entries(picked.fields || {})
    .filter(([, spec]) => spec?.schema?.custom && DEFAULT_VALUE_OPTION_FIELDS.has(spec.name))
    .map(([id, spec]) => ({
      id,
      name: spec.name,
      allowed_values: (spec.allowedValues || [])
        .map((o) => ({ id: String(o.id ?? o.value ?? ''), value: String(o.value ?? o.name ?? '') }))
        .filter((o) => o.value),
    }));
}

module.exports = { getProfile, saveProfile, createIssue, getCreateForm, getDefaultFields, searchIssues, parseMapping, syncMeta };
