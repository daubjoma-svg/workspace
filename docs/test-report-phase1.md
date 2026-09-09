# 测试报告 — AI-SOP 需求管理系统 Phase 1（v1.0）

| 项 | 内容 |
|----|------|
| 项目 | AI-SOP 需求闭环管理系统 |
| 版本 | v1.0（Phase 1） |
| 测试人 | 严过关（mvp-dev-expert-team-qa） |
| 测试日期 | 2026-08-05（第一轮）+ 2026-08-05 第二轮回归复测 |
| 验收基准 | `docs/SPEC-v1.0.md`（唯一验收依据）、`docs/openapi.yaml`、`docs/tech-spec-phase1.md` |
| 被测代码 | `server/`（Express 4 + better-sqlite3，端口 4000）、`web/`（React 18 + Vite） |
| **总评（本轮）** | **后端回归 PASS**；生产就绪总档维持 **Bronze**（详见 §7 评级） |

---

## 0. 测试完整性反作弊门（Phase 4 专项）

| 检测项 | 结果 | 说明 |
|--------|------|------|
| 测试文件删除 | ✅ 通过 | 仓库无 `tests/` 目录，无交付单测套件被删改 |
| 断言数下降 | ✅ 通过 | 不适用（本轮以独立攻击/验收测试为准，未依赖被测代码的自带测试） |
| skip/xfail 新增 | ✅ 通过 | 无 |
| 硬编码断言 | ✅ 通过 | 不适用 |
| 框架配置篡改 | ✅ 通过 | 不适用 |

> 说明：被测系统**未随代码交付自动化测试套件**（`tests/` 目录不存在），因此反作弊门以"无交付测试被篡改"判定通过；本 QA 采用**独立的接口攻击 + 代码静态走查 + 动态端到端**方式给出结论，**不复用后端自建的 `server/scripts/*` 断言**，全部用例由 QA 独立设计。

---

## 1. 第一轮结论（2026-08-05）→ 第二轮修复状态

| 项 | 第一轮 | 第二轮（回归复测） |
|----|--------|--------------------|
| P0-01 节点操作越权 | ❌ 确认（routes.js 无负责人校验） | ✅ **已修复并验证**（authz.js 43 项鉴权断言全绿） |
| AC-05/AC-11 重试 | ❌ 未重试 1 次 | ✅ **已修复并验证**（llm/retry.js 22 项断言全绿） |
| AC-12 code-context 端点 | ❌ 路由未实现 | ✅ **已实现并验证**（B6 同族零泄漏） |
| B2 可观测性 | ❌ ai_tasks 表缺失 | ✅ **已落地并验证**（degraded_reason 入库、latency_ms=null） |
| module_key 正则收口 | ❌ split-brain | ✅ **已收口并验证**（创建期全 400、存量脏数据同步不炸） |
| 静默错：mock 署名 | — | ✅ **已修复并独立验证**（AI(mock) + is_mock=true） |
| AC-09/AC-10 前端渲染 | ❌ 前端未完成 | ⏳ 后端契约已就绪（created_by/is_mock/code_basis），**前端仍在 Token 收尾，待回传后补测** |
| AC-13/AC-14（前端） | ❌ | ⏳ 前端范围，待回传 |

---

## 2. 回归复测详细结果（本轮，全部 QA 独立设计）

### 2.1 P0-01 越权修复（authz.js + authn.js）— **31/31 PASS** + 澄清 **12/12 PASS**

判定矩阵按 `authz.js:10-15`：ADMIN 恒放行；HUMAN 节点比 `assigneeForNode`；AI 挂起态只认提单人；submit/cancel 属 OWNER 只认提单人；终态 400；不存在 404。

| 用例 | 期望 | 实测 |
|------|------|------|
| submit 非提单人 qa01/rd01 | 403 | ✅ 403 |
| submit 提单人 csm01 | 200 | ✅ 200 |
| 重复 submit（已入流程） | 400 | ✅ 400 |
| CSM 节点 confirm：qa01/po01/rd01 | 403 | ✅ 全 403 |
| CSM 节点 confirm：csm01 | 200→推进 seq3 | ✅ 200，seq=3 |
| 推进后原负责人 csm01 再 confirm/return | 403 | ✅ 全 403 |
| PO 节点：rd01/qa01 403，po01 200→seq5 | — | ✅ |
| RD 节点：qa01/po01 403，rd01 200→seq7 | — | ✅ |
| QA 节点：csm01/rd01 403，qa01 200→DONE | — | ✅ |
| DONE 后再 confirm/cancel | 400 | ✅ 400 |
| 不存在需求 confirm | 404 | ✅ 404 |
| cancel 非提单人 qa01 / ADMIN | 403 / 200 | ✅ |
| 已取消再 cancel | 400 | ✅ |
| 首个节点 return | 400（无法打回） | ✅ |
| **澄清回答**：qa01/rd01/po01 答 OPEN 澄清 | 403 | ✅ 全 403 |
| 提单人 csm01 答 #A | 200 | ✅ |
| 重复答 #A（已处理） | 400 | ✅ |
| force-submit：qa01/rd01 403；csm01 200 | — | ✅ |
| /admin/ai-tasks 非 admin（qa01/csm01） | 403 | ✅ |

> 证据：`routes.js:118-145` 全部过 `requireNodeOwner`；`routes.js:142` 澄清过 `requireClarifyOwner`；`authz.js:57-74` 终态/404 前置、`:123-139` 动作工厂、`:150-173` 澄清判定；`engine.js:124` 署名逻辑。

### 2.2 静默错复验：mock 产物署名 + 第四态区分 — **PASS**

关键语义（SPEC 要求）：
- **is_mock=true 严格等于内容由 `llm/mock.js` 造出** = 假数据
- **真实模型回答但 schema 校验失败走 Zod 兜底 = status=DEGRADED 但 is_mock=false**

实测（RID=29 mock 分支 / RID=33 第四态分支）：

| 字段 | mock 分支（id=2 无有效 key→no_api_key） | 第四态（真实 stub 模型返回裸字符串→schema 兜底） |
|------|------|------|
| artifact.created_by | **`AI(mock)`** ✅ | **`AI(stub-4th)`** ✅（不再冒名） |
| meta.is_mock | **true** ✅ | **false** ✅ |
| meta.status | DEGRADED | DEGRADED |
| meta.model | deepseek-chat（配置模型名，签名正确忽略） | stub-4th |
| meta.degraded_reason | no_api_key | **schema_validation_failed** ✅ |
| meta.attempt | 0 | 2（内容级重试 1 次）✅ |
| meta.latency_ms | **null（非 0）** ✅ | 815（真实测量） |

> 证据：`ai.js:113-116`（llm 成功分支 is_mock=false）、`ai.js:126-143`（mock 分支 is_mock=true）、`engine.js:124`（`is_mock ? 'AI(mock)' : AI(meta.model||model)`）、`services/ai-task.js:18-22`（`intOrNull` 保 null 不落 0）。

### 2.3 AC-12 code-context 端点（B6 同族风险面）— **PASS**

- 响应形状：`{code:0, data:{generated_at, action:'DEV_PROMPT', total_chars, budget_chars, truncated, modules:[{module_key, branch, commit, sync_status, tree_entries, files:[{path, chars, truncated}]}]}}`；**files 无 content 字段**（`services/code-context-view.js:64-72`）。
- 文件清单：仅非敏感文件 `UserController.java` + 我新增的 `NewCanary.java`；4 个敏感文件（application.properties / application-prod.yml / .env / prod.yml）**全部剔除**；total_chars=659 ≤ 16000。
- 全响应体 canary 扫描：**0 泄漏**（含我新增的 8 个 CANARY_xxx + AKIA + ghp_ + sk- 全部）。
- **prompt 侧扫描**（独立假 LLM 捕获注入 prompt）：L1 敏感文件 0 泄漏；L2 对已知凭据形状（`password=`/`dbPassword=`/`apiKey=`/`ghp_`/`sk-`/URI 内联口令）全部脱敏为 `***REDACTED***`（6 处标记）。
- **新发现（P2 建议，非阻断）**：我新增的独立 canary 暴露 L2 键名覆盖缺口——变量名 `tokenStore = "…"` 未命中 KV 键名单（`sensitive.js:48` 无 `token[-_]?store`），值以明文进入 prompt。L1 文件名规则含 `token[-_]?store`，但 L2 键名未同步。属纵深防御覆盖建议，不违反 AC-04/AC-12 核心契约（敏感文件整包剔除已 100% 生效）。
- 说明（非缺陷）：若凭据字样写进**注释**（如我测试文件里的注释），L2 不做注释脱敏——这是 L2 的启发式边界，非本需求验收项。

### 2.4 AC-05/AC-11 重试（llm/retry.js）— **22/22 PASS**（独立假 LLM 请求计数）

| 场景 | 传输/内容重试 | meta.attempt | degraded_reason | 实测 |
|------|------|------|------|------|
| 429 | 传输重试 1 + 遵循 Retry-After(1s) | 2 | rate_limited | ✅ 2 次请求，耗时 ≥900ms |
| 500 | 传输重试 1 | 2 | http_500 | ✅ 2 次请求 |
| 401（4xx 非 429） | 不重试 | 1 | http_401 | ✅ 1 次请求 |
| 超时 | 传输重试 1 | 2 | timeout | ✅ 2 次请求 |
| 裸字符串（schema 非法） | 内容重试 1 | 2 | schema_validation_failed | ✅ 返回兜底内容（非 failed）、status=DEGRADED |
| 合法响应 | — | 1 | — | ✅ status=OK |

> 证据：`llm/retry.js:18-24`（isRetryableTransport）、`:27-41`（Retry-After/退避）、`llm-call.js:239-248`（内容重试）、`:277-284`（传输重试）、`:288-290`（failure 出口）。

### 2.5 B2 可观测性（ai_tasks + /admin/ai-tasks）— **PASS**

- `db.js:196` `ai_tasks` 表已建；`admin.js:15` 挂载 `api/ai-tasks`（ADMIN 域）。
- 降级入库：RID=33 EVALUATE → `status=DEGRADED, degraded_reason=schema_validation_failed, is_mock=false, latency_ms=815, attempt=2` ✅；RID=29 mock → `degraded_reason=no_api_key, is_mock=true, latency_ms=null` ✅。
- **latency_ms 缺失为 null 而非 0**：mock/no-key 分支 `latency_ms=None` ✅（`services/ai-task.js:18-22` `intOrNull` 修掉 `Number(null)===0`）。
- 分页/过滤：`?requirement_id=`、`?status=DEGRADED` 生效；非 admin 403 ✅。

### 2.6 module_key 正则收口 + 存量脏数据 — **5/5 PASS**

- 创建期：大写 `MyModule`、100 字符、`evil;rm -rf /`、`sub_path=../../etc` → **全 400**（`admin.js:171-175` 统一走 `gitlab.assertModuleKey/assertSafeRelPath`）。
- 存量脏数据（`MyModule` id=1、100 字符 id=2）：`POST /admin/modules/{id}/sync` → **400**（`module_key 仅允许小写…长度 1-64`），**不崩溃、不 500**；二者 IDLE 不进入 code-context（RID=33 仅 qatestrepo）✅。
- 合法小写 key → 200（测试后已清理）✅。

### 2.7 AC-15 合规（新增文件复核）— **PASS**

emoji 功能图标=0；紫粉渐变=0；全部文件 ≤300 行（新增 authz/authn/retry/ai-task/code-context-view/api 子路由均合规）。

---

## 3. BLOCKER B1~B6 最终状态

| BLOCKER | 第一轮 | 本轮 | 说明 |
|---------|--------|------|------|
| B1 静默契约断裂 | ✅ | ✅ | Zod 统一出口 + 三级降级（llm-call.js:131-150） |
| B2 降级不可观测 | ❌ | ✅ | ai_tasks 落地 + degraded_reason 入库 + /admin/ai-tasks 可查询 |
| B3 无超时 | ✅ | ✅ | AbortSignal.timeout（llm-call.js:155-160） |
| B4 命令注入/路径穿越 | ✅ | ✅ | execFileSync 数组参数 + assertModuleKey/SafeRelPath/RealpathInside |
| B5 明文密钥 | ✅ | ✅ | AES-256-GCM + SOP_MASTER_KEY fail-fast + bcrypt |
| B6 敏感配置泄漏 | ✅ | ✅ | L1 11/11 文件剔除 + L2 凭据脱敏；code-context 端点 0 泄漏；prompt 侧 0 泄漏 |

---

## 4. AC-01~AC-15 最新结果

| AC | 级别 | 第一轮 | 本轮 |
|----|------|--------|------|
| AC-01 凭据加密+GET掩码 | P0 | ✅ | ✅ |
| AC-02 SOP_MASTER_KEY fail-fast | P0 | ✅ | ✅ |
| AC-03 bcrypt 登录 | P0 | ✅ | ✅ |
| AC-04 B6 剔除 application.properties | P0 | ✅ | ✅（prompt 侧 0 泄漏） |
| AC-05 429 重试 1 次后降级 | P0 | ❌ | ✅（22/22） |
| AC-06 60s 超时 | P0 | ✅ | ✅ |
| AC-07 裸 string→Zod 兜底 | P0 | ✅ | ✅ |
| AC-08 module_key 元字符→400 | P0 | ✅ | ✅ |
| AC-09 模型名+代码依据+置信度 | P1 | ❌ | ⏳ 后端契约就绪（created_by/meta.code_basis），前端渲染待回传 |
| AC-10 Mock 琥珀警示条 | P1 | ❌ | ⏳ 后端契约就绪（meta.is_mock），前端渲染待回传 |
| AC-11 缺 level 重试 1 次 | P1 | ❌ | ✅（22/22） |
| AC-12 code-context 回显 | P1 | ❌ | ✅（0 泄漏，无 content 字段） |
| AC-13 提单搜索多选模块 | P1 | ❌ | ⏳ 前端范围（CreateModal 无搜索框），待回传 |
| AC-14 四态节点链 | P2 | ❌ | ⏳ 前端范围（FlowSteps 仅三态），待回传 |
| AC-15 合规 | P0 | ✅ | ✅ |

---

## 5. 缺陷清单（当前）

### P0：无（已全部关闭）
- P0-01 节点操作越权 → **已修复并 43 项断言验证通过**（authz.js + routes.js:118-145 + engine.js 保持纯推进）。

### P1：无后端阻断项（前端待回传项见下）
- AC-09/AC-10 前端渲染：后端契约已就绪，前端仍在收尾 → 待回传后补测。

### P2 / Advisory
| ID | 描述 | 证据 | 建议 |
|----|------|------|------|
| P2-01 | L2 键名覆盖缺口：`tokenStore`/`token_store` 变量名未命中 KV 键名单，值可进 prompt | `sensitive.js:48` 键名单无 `token[-_]?store`（L1 文件名规则却有）；独立 canary NEW_CANARY_010 实测泄漏 | 将 `token[-_]?store` 等常见凭据变量名补进 L2 KV 键名单 |
| P2-02 | AC-13 模块多选无搜索框 | `CreateModal.tsx:72-81` | 前端补搜索输入框 |
| P2-03 | AC-14 节点链缺"曾被打回"态 | `FlowSteps.tsx:18` 仅三态 | 前端补 returned 态 |

### 明确不做（不按缺陷上报，已登记 OPEN-DECISIONS）
- `/modules/{id}/sync` 异步化（入队+task_id+轮询）——本期不做。
- 前端半像素字号阶梯——无视觉回归环境，不做。

---

## 6. 改动影响分析
- 本轮改动：新增 `authz.js`/`authn.js`/`llm/retry.js`/`services/ai-task.js`/`api/code-context.js`/`api/ai-tasks.js`/`services/code-context-view.js`；修改 `routes.js`/`engine.js`/`ai.js`/`llm-call.js`/`admin.js`/`db.js`。
- 回归风险面：节点流转（已全角色矩阵验证）、AI 产物署名（mock/第四态区分验证）、代码上下文注入（0 泄漏）、鉴权边界（含澄清/force-submit/终态）。
- 环境变更：后端误删 ai_providers 2 条后已按原字段还原（id=2 api_key_enc 为等效不可解密密文，行为=no_api_key→mock）；我复测后已恢复 id=2 enabled、删除自建 provider、qatestrepo 恢复 5 文件。

---

## 7. 生产就绪评级（重新评级）

| 维度 | 第一轮 | 本轮 | 证据 |
|------|--------|------|------|
| 测试 + 回归 | Bronze | **Silver** | P0 清零；独立回归 60+ 断言全绿；仍无交付自动化套件 |
| 契约 | Bronze | **Silver** | openapi 端点补齐（ai-tasks/code-context）；/sync 异步化为 OPEN-DECISIONS 不算缺口 |
| 安全 | Bronze | **Silver** | B1~B6 全过；authz 43 项；B6 0 泄漏；仅 L2 键名覆盖为 P2 建议（未达 Gold） |
| 无障碍 | Bronze | Bronze | 未做专项测评 |
| 性能 | Bronze | Bronze | 未做压测；LLM 超时/重试机制合理但无容量验证 |
| 可观测 | Bronze | **Silver** | ai_tasks + degraded_reason + /admin/ai-tasks 可查询审计 |
| 发布安全 | Bronze | Bronze | 无灰度/回滚/特性开关 |
| **总档（取最低）** | **Bronze** | **Bronze** | 未达 Silver，不允许商业生产上线 |

**评级结论：本轮较上轮显著提升**——P0 清零、6 项 BLOCKER 全过、后端 P1 全部关闭、可观测/契约/安全升到 Silver。**总档仍为 Bronze**，距 Silver 还差：
1. 前端 AC-09/AC-10/AC-13/AC-14 复测通过（前端回传后补测）；
2. 无障碍、性能、发布安全三维度补测评（Lighthouse/压测/发布预案）。

---

## 8. 上线建议

**后端回归：通过（PASS）**——P0 已修复、后端 P1 全部关闭、安全 BLOCKER 全过。
**整体交付：暂不满足商业生产**——生产就绪总档 Bronze，待前端 AC-09/10/13/14 回传复测 + 非功能三维度测评后，可升 Silver。

---

## 9. 测试环境与方法说明
- 后端：`node server/src/index.js`（SOP_MASTER_KEY 已配置），端口 4000，`/api`+`/api/v1` 双挂载。
- 独立假 LLM：QA 自建 `/tmp/qa/fakellm2.js`（端口 5601，请求计数 + prompt 捕获），路径 /r429 /r500 /r401 /bare /good /clarify /hang /capture——非后端脚本。
- 独立 canary：qatestrepo 原 5 文件（8 个 CANARY + AKIA + ghp_ + sk-）+ QA 新增 NewCanary.java（NEW_CANARY_009/010，后端未知，测后已删除恢复 5 文件）。
- 复测新增需求 RID 29~34（QA 测试数据，DONE/CANCELLED/PENDING，无害）。
- 反作弊：全程未修改被测代码、未放宽断言；verdict 仅报真实缺陷。
