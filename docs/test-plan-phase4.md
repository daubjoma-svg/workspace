# Phase 4 测试计划 — sop-system 一期收尾

> 产出角色：QA（严过关）
> 状态：Phase 3 开发中，本文为**测试前置产出**（待命期调研）
> 依据：SPEC-v1.0 §9 AC-01~AC-15 / tech-spec-phase1 §9 / b1-implementation-spec §7 / PRD v0.5 §8
> 原则：P0 缺陷不归零，不上线。没有例外。

---

## 0. 结论先行

本次调研在**代码尚未改动**时完成，属最佳取证时机。结论三条：

1. **两项流程级阻塞**（无 git 仓库 / 无测试框架）会使 Phase 4 的反作弊门与单测门**无法执行**，需 devops 在 Phase 3 结束前解决。
2. **发现 9 项契约冲突**，其中 4 项为 P0：若 Phase 3 按现有文档各自实现，前后端会在 Phase 4 集成时确定性崩溃或静默出错。**这些必须在编码完成前裁决**，Phase 4 再发现就是返工。
3. **AC-08 存在验收盲区**：现有代码已能通过 AC-08 字面验收，但真实攻击面（`sub_path`/`path_prefix` 路径穿越）无任何 AC 覆盖。按 AC 逐条测会得到"全绿但漏洞仍在"。

---

## 1. 测试基线快照（Phase 3 改动前，用于回归对比）

采集时间：Phase 3 开发中，`server/src`、`web/src` 尚未出现新增文件。

> **时效说明**：本节是**改动前基线**，用于 Phase 4 回归对比，故**保留原值不更新**。
> 调研后期 Phase 3 代码已陆续落地，最新状态见 §1.4。

### 1.1 文件行数基线（300 行硬规则）

| 文件 | 行数 | 状态 |
|---|---|---|
| `web/src/pages/Admin.tsx` | 646 | 超限 115%，必须拆 |
| `web/src/pages/ReqDetail.tsx` | 367 | 超限 22%，必须拆 |
| `web/src/pages/Board.tsx` | 256 | 逼近，Icon 改造后易超 |
| `server/src/ai.js` | 241 | 加三级降级后必然超 |
| `server/src/engine.js` | 218 | — |
| `server/src/admin.js` | 204 | 加新端点后易超 |
| `server/src/gitlab.js` | 202 | 加队列/限流后必然超 |
| `server/src/db.js` | 198 | 加 DDL 后易超 |
| 合计 | 3215 | — |

### 1.2 emoji 基线（P0 规则）

精确统计 **46 处**（与 architect §4 审计一致）：

| 文件 | 个数 |
|---|---|
| `web/src/pages/Board.tsx` | 35 |
| `web/src/pages/ReqList.tsx` | 9 |
| `web/src/pages/CreateModal.tsx` | 1 |
| `server/src/gitlab.js` | 1（`:139` 目录树 `'📁 '`，会注入 LLM prompt） |

> **门禁脚本口径修正**：SPEC §12 与 tech-spec §9 的门禁用 `rg -c`，统计的是**匹配行数**（35），不是 emoji 个数（46）。作为"必须为 0"的门禁二者等价，**但报告计数时必须用 `rg -o ... | wc -l`**，否则会把 46 处误报成 35 处。Phase 4 采用后者。

### 1.3 依赖基线

- `server/package.json`：仅 `better-sqlite3` / `express`。**无 zod、无 bcrypt、无测试框架、无 test script**。
- `web/package.json`：仅 react 系 + vite + ts。**无 lucide-react、无测试框架**。

---

### 1.4 Phase 3 进度快照（调研结束时重扫）

新增文件：`server/src/` 下 `llm-schema.js` `llm-call.js` `logger.js` `crypto/{secret,password}.js` `llm/{capabilities,json-schema,provider}.js` `repo/{index,archive,code-context,gitlab-api,paths,sensitive}.js`；`web/src/` 下 `components/{Icon,EmptyState}.tsx` `pages/board/{FlowSteps,ReqCard,nodeState,roleConfig}` `pages/list/columns.ts`。`gitlab.js` 已拆入 `repo/`。

**emoji：46 → 4**，且剩余 4 处**全部位于代码注释**（`Icon.tsx:7` 的 `✓`/`☰` 与 `columns.ts:7` 的 `✅`×2），均为「说明该规则/描述历史缺陷」的文字，**不是功能图标**。

| 判定维度 | 结论 |
|---|---|
| P0 规则实质（emoji 充当 UI 功能图标） | **不违规** —— 4 处均在注释 |
| 门禁脚本 GATE-01（要求计数为 0） | **不通过** —— 脚本不区分注释与代码 |

**处置建议**：仍请 frontend 清掉这 4 处（注释里改用「U+2705」「已完成前缀字符」等文字描述即可）。理由是"零容忍"比"注释里可以有"更易执行、不留解释空间，也免去后续每次门禁红灯都要人工复核。**不作为缺陷记账，仅作门禁清障。**

**R6（emoji 承重排序）已正确修复**：`pages/list/columns.ts` 拆成 `{key,label,icon,weight}`，排序只依赖 `weight`，`key` 用 `status:DONE`/`node:<name>` 稳定标识，渲染只用 `label`+`icon`。正是 tech-spec R6 要求的结构化重构，非字符替换。E2E-REG-04 仍保留验证。

**仍超 300 行（AC-15 未达标）**：`web/src/pages/Admin.tsx` **647**（基线 646，**+1**）、`web/src/pages/ReqDetail.tsx` **371**（基线 367，**+4**）。两者不降反增，拆包尚未进行。

**BLOCK-QA-1 / BLOCK-QA-2 均未解除**：git 仍未初始化，`server/package.json` 仍无 `test` script。

---

## 2. P0 流程阻塞（需 devops 在 Phase 3 结束前解决）

### BLOCK-QA-1：项目不是 git 仓库

`git rev-parse` 返回 `fatal: not a git repository`。

**影响**：我的**测试完整性反作弊门 5 项检测中有 4 项依赖 `git diff`**——测试文件删除检测、断言数前后对比、skip/xfail 新增检测、测试框架配置篡改检测，全部**无法执行**。同时无法做改动 diff 分析，回归范围只能靠人工比对，精度大幅下降。

**要求**：Phase 3 结束前 `git init` + 提交一次**当前基线**（即"开发前"快照）。没有这个基线提交，Phase 4 的反作弊门形同虚设。

### BLOCK-QA-2：零测试基础设施

无 `tests/` 目录，无任何 `*.test.js` / `*.spec.ts`，`package.json` 无 `test` script，无 jest/vitest 依赖。

**影响**：b1-implementation-spec §7.1 明确要求 5 项单测（含核心回归 #4 裸 string），§9 Done Definition 要求"单测 7.1 全绿"。**当前无处可跑**。

**要求（建议选型，零 ESM 冲突）**：
- `server`（CJS）：**node:test**（Node 20 内置，零依赖，`node --test`）或 vitest。优先 node:test，避免给 CJS 工程引入构建链。
- `web`（ESM）：**vitest**（与 vite 同源，零额外配置）。
- 覆盖率：`node --test --experimental-test-coverage` / `vitest --coverage`。

### 顺序错位说明（流程风险，非缺陷）

我的角色规范要求「Phase 2 QA 同步写测试 → Phase 3 按测试实现」，以规避同义测试反模式（AgentCoder：写实现者写测试会导致测试复述实现假设，绿灯零信息量）。本项目实际是 **Phase 3 开发已启动、测试尚未编写**。

**补偿措施**：本文第 3 节的契约冲突裁决 + 第 5 节的测试用例**全部基于 Spec/PRD 文本推导，不参考 Phase 3 产出的实现**。Phase 4 拿到代码后，断言值只认 Spec 定义，不认实现返回值（反作弊门第 4 项）。

---

## 3. 契约冲突清单（**最高优先级，需在编码完成前裁决**）

以下冲突均为**文档之间/文档与下游代码之间**的矛盾。若不裁决，前后端各自按不同文档实现，Phase 4 必炸。

> **证据等级标注**：`[实证]` = 本机实跑验证；`[读码]` = 由源码逐行推导，未实跑。区分二者是为了避免把推断当事实。

### 3.0 冲突状态复核（Phase 3 部分代码落地后重扫）

调研期间 Phase 3 代码陆续落地（新增 `llm-schema.js` / `llm-call.js` / `crypto/*` / `repo/*` / `components/Icon.tsx` / `pages/list/columns.ts` 等）。**下表已按实际代码复核，不沿用早期推断**：

| 冲突 | 状态 | 依据 |
|---|---|---|
| CONF-1 questions | **代码已避坑，但偏离 PRD** | `llm-schema.js:20` 取 `string[]`，与 `engine.js:138` 匹配（不崩），但与 PRD §6.2.1 的 object[] 相悖 |
| CONF-2 issues | **代码已避坑，但偏离 PRD** | `llm-schema.js:21` 取 `string[]`，与 `ReqDetail.tsx:333` 匹配，与 PRD §6.2.1 相悖 |
| **CONF-3 verdict** | **仍存活（P0）** | `llm-schema.js:41` 允许 `'OK'`；`ReqDetail.tsx:292-293` 仍只认 `'REASONABLE'` |
| CONF-4 TEST_CASE | **已解决，撤销** | `llm-schema.js:71` 数组 schema，注释直接引用 `ReqDetail.tsx:68` |
| CONF-5 PRD/DEV_PROMPT | **已解决，撤销** | `SHAPE_BY_ACTION` 标 `'text'`，出口解包回 string，保住 markdown 渲染路径 |
| CONF-6 mock 兜底 | **已解决，撤销** | `minimalFallback()` 按 action 返回 object/array，不回落原值 |
| **CONF-7 门禁 AND/OR** | **仍存活（P1）** | `engine.js:112` 仍为 `&&` |
| **CONF-8 confidence 上限** | **仍存活（P1）** | `ai.js:121` 无上下文时仍为 `0.6`（PRD 要求 ≤0.5） |
| **CONF-9 files 占位串** | **仍存活（P1）** | `ai.js:93` 仍为 `'(基于目录结构推断,详见 code_context)'` |

> backend 在 CONF-4/5/6 上逐行核对了下游消费点（schema 注释直接引用 `engine.js:112/118/119`、`ReqDetail.tsx:68/71` 行号），质量高于 b1-spec 伪码。三项撤销，不计入待裁决。
>
> 但由此暴露一个**系统性问题**：backend 一致地选择"对齐下游现有代码"而非"对齐 PRD §6.2"（questions/issues 类型、`TestCaseItem` 用 `result` 而非 PRD 的 `priority`、`steps` 用 string 而非 PRD 的 `string[]`）。工程上更优（"下游零改"因此成立），但 **b1-spec §0 白纸黑字写着"以 PRD 为准"**。
>
> **后果**：Phase 4 若按 PRD §6.2 逐条验收，这些全判缺陷；若按实现验收，等于测试复述实现（同义测试反模式，绿灯零信息量）。**QA 无法在此裁决前写断言。请 pm 明确：批准实现形状并更新 PRD §6.2，还是要求 backend 返工。**

### CONF-1（P0→待 pm 追认）[实证]：`PRECHECK.questions` 类型三方冲突 → **会导致 SQLite 抛错崩溃**

| 来源 | 定义 |
|---|---|
| PRD §6.2.1 | `questions[]` 是 **object[]**：`{id, question, options[]}` |
| b1-spec §2 Zod | `questions: z.array(z.string())` — **string[]** |
| 现有 mock `ai.js:71-73` | **string[]** |

**下游致命点**：`engine.js:138` `ins.run(reqId, node.id, 'AI', q)` 把 `q` 直接绑进 SQL。

**已实证**（本机 better-sqlite3 ^13.0.2 实跑）：
```
ins.run({id:'q1', question:'...'})  =>  RangeError: Too few parameter values were provided
ins.run('纯字符串问题')              =>  OK
```
> 注：better-sqlite3 把裸 object 当作**具名参数绑定对象**处理，而该语句用的是匿名 `?`，故报"参数过少"。错误类型与直觉不同，但**结论一致：抛错**。

若按 PRD 实现 object[]，**AI 预检节点直接抛异常**，不是静默失败。而 b1-spec §5 与 §9 明确承诺"engine.js 零改 / 下游零改"——**该承诺在 PRD 口径下不成立**。

**建议裁决**：`questions` 保持 **string[]**（engine.js 零改成立），PRD §6.2.1 的 `{id,options}` 结构降二期。若坚持 object[]，则 engine.js `raiseClarifies` 必须同步改造（取 `q.question` 入库），B1 的"下游零改"卖点作废。

### CONF-2（P0）[读码]：`PRECHECK.issues` 类型冲突 → **会导致 React 渲染崩溃**

| 来源 | 定义 |
|---|---|
| PRD §6.2.1 | `issues[]` 是 **object[]**：`{field, severity, message}` |
| b1-spec §2 Zod | `issues: z.array(z.string())` |
| 现有 mock `ai.js:68-70` | **string[]** |

**下游致命点**：`ReqDetail.tsx:333` `data.issues.map((s: string) => <li>{s}</li>)` 直接把元素当 React child 渲染。传 object 会抛 **"Objects are not valid as a React child"**，NoteView 整块白屏。

**建议裁决**：同 CONF-1，保持 string[]；否则前端 NoteView 必须同步改造。

### CONF-3（P0）[读码]：`rationality.verdict` 枚举冲突 → **前端标签语义反转**

| 来源 | 枚举 |
|---|---|
| PRD §6.2.2 | `OK` / `NEED_CLARIFY` / `REJECT` |
| b1-spec §2 Zod | `OK` / `REASONABLE` / `NEED_CLARIFY`（**无 REJECT**） |
| 现有 mock `ai.js:103` | `REASONABLE` |
| 前端 `ReqDetail.tsx:288-289` | 硬编码：`=== 'REASONABLE'` 才显示"需求合理"（绿），否则"存疑"（橙） |

**后果**：b1-spec §0 声明"以 PRD 为准"。若后端按 PRD 输出 `verdict='OK'`，前端第 288 行判定失败 → 一个**完全合理的需求被渲染成橙色"存疑"**。不报错、不崩溃、纯语义反转，属典型静默逻辑错误，只有专门测才能发现。
另：PRD 的 `REJECT` 态前端**无任何分支**，会落进"存疑"，与"驳回"语义不符。

**建议裁决**：统一为 PRD 的 `OK/NEED_CLARIFY/REJECT`，**同时**要求前端改造 `ReqDetail.tsx:288` 与 mock 的 `REASONABLE`。三处必须同批改，漏一处即语义错乱。

### CONF-4（P0）[读码]：`TEST_CASE` schema 冲突 → **前端 TestCaseView 失效**

| 来源 | 定义 |
|---|---|
| PRD §6.2.3 + §6.2 强约束 1 | TEST_CASE **必须结构化**：`[{id,type,title,steps[],expect,priority}]` |
| b1-spec §2 `SCHEMA_BY_ACTION` | `TEST_CASE: DocResult` → `{text: string}` |
| 现有 mock `ai.js:196-200` | 数组 `[{id,type,title,steps,expect,result}]` |

**下游致命点**：`ReqDetail.tsx:68` `if (a.kind === 'TEST_CASE' && Array.isArray(obj))` → 走 TestCaseView。若 B1 把 TEST_CASE 包成 `{text}`，`Array.isArray` 为 false → 掉到 `:70` 渲染成**一坨 JSON dump**，测试用例表格功能直接消失。

另注字段差异：PRD 要 `priority`，mock 给 `result`；PRD `steps` 是 `string[]`，mock 是 `string`。

**建议裁决**：`SCHEMA_BY_ACTION.TEST_CASE` 改为数组 schema（按 PRD §6.2.3），**不可用 DocResult**。

### CONF-5（P0）[读码]：`PRD_GEN`/`DEV_PROMPT` 包成 `{text}` → **前端 Markdown 渲染退化为 JSON dump**

这是 **B1 改造自身引入的前端回归**，双方都不会单独发现。

**现状**：`mockPRD`/`mockDevPrompt` 返回**裸 markdown 字符串** → 入库后 `ReqDetail.tsx:66` `JSON.parse` **抛错** → `:71` catch 分支 `<div className="md">{a.content}</div>` 渲染 markdown。**catch 是当前的正常渲染路径**。

**B1 改造后**：DocResult 把内容包成 `{text: "..."}` → `JSON.parse` **成功** → 不再进 catch → 依次判断 EVALUATION/TEST_CASE/NOTE 均不匹配 → 落到 `:70` `<pre>{JSON.stringify(obj)}</pre>` → **PRD 与研发提示词全部渲染成 JSON 源码**。

b1-spec §5 称"前端 try/catch 可保留作防御，正常路径不再触发回退"——**该判断有误**，正是这个"不再回退"打断了 markdown 渲染路径。

**建议裁决**：前端 `renderContent` 必须新增 `PRD` / `DEV_PROMPT` 分支，读取 `obj.text` 后按 markdown 渲染。需 backend 与 frontend 同批提交，**并列入 Phase 4 必测回归**。

### CONF-6（P1）[读码]：mock 路径 Zod 兜底伪码有洞 → B1 承诺不成立

b1-spec §4 骨架：
```js
const parsed = SCHEMA_BY_ACTION[action].safeParse(mockObj);
return { content: parsed.success ? parsed.data : mockObj, model: 'mock' };
```
`mockPRD`/`mockDevPrompt` 返回**字符串**，`DocResult.safeParse("...")` 必然失败 → 三元回落 `mockObj` → **content 仍是 string**。这与 §9 Done Definition"content 类型恒为 object"**直接矛盾**，等于在 mock 路径上原样保留 BLOCKER-1。

**建议裁决**：失败分支不得回落原值，必须走 `minimalFallback(action, raw)`。这一条会被单测 UT-B1-05 直接打到。

### CONF-7（P1）[读码]：PRECHECK 门禁逻辑 AND / OR 冲突

| 来源 | 逻辑 |
|---|---|
| PRD §6.2.1 门禁 | `if (!content.pass \|\| content.questions?.length > 0)` → 挂起 |
| 现有 `engine.js:112` | `if (!content.pass && content.questions?.length)` → 挂起 |

`pass=true` 且有 questions 时：PRD 要求挂起澄清，代码放行。**与 B1"engine.js 零改"再次冲突**。需裁决以哪个为准；若以 PRD 为准，engine.js 必改。

### CONF-8（P1）[读码]：无代码上下文时 `effort.confidence` 违反上限

PRD §6.2.2 降级场景 + PRD §8 F4 第 3 条：未加载代码上下文时 `effort.confidence` **不得高于 0.5**。
现有 `ai.js:121` 无模块时给 **0.6** → 违规。改造时必须一并修正，否则 AC-10 关联验收挂。

### CONF-9（P1）[读码]：`impact_scope[].files` 占位串

PRD §6.2.2 明确"**严禁占位串**"。`ai.js:93` 现为 `['(基于目录结构推断,详见 code_context)']`。
AC-12 要求真实路径。mock 路径应改为 `[]`（无上下文时的诚实空态），而非占位串。

---

## 4. 验收标准覆盖矩阵与盲区

### 4.1 AC-08 验收盲区（**重点**）

AC-08 原文：*If `module_key` 含 shell 元字符，When 创建模块，系统必须返回 400 拒绝*。

**现状**：`admin.js:145` **已存在**校验 `/^[a-z0-9][a-z0-9-_]*$/i`。用 SPEC §12 第 9 步的 payload `a"; touch /tmp/pwned; #` 测试，**今天就返回 400**。

即：**AC-08 在 B4 完全未修的情况下也会通过**。按 AC 逐条测 → 全绿 → 漏洞仍在。

**真实攻击面（无任何 AC 覆盖）**：

| 向量 | 位置 | 现状 |
|---|---|---|
| `sub_path` 路径穿越 | `admin.js:156-158` PUT /modules/:id | **零校验**，直接落库 |
| → 利用点 | `gitlab.js:128` `dirTree`、`:148` `keyFilesContent` | `path.join(REPOS_DIR, key, sub_path)`，`sub_path='../../../..'` 可读仓库目录外任意文件 |
| → 泄露出口 1 | `GET /admin/modules/:id/tree` | 目录结构直接回显 |
| → 泄露出口 2 | `buildCodeContext` → prompt | 越界文件内容**直发外部 LLM** |
| `path_prefix` 穿越 | `gitlab.js:192-193` | 来自 `module_mappings`，同样未校验 |
| `module_key` 长度 | `admin.js:145` | 正则**无长度上限**，spec 要求 `{0,63}` |
| PUT 端点 | `admin.js:153` | 不校验任何字段格式 |
| DB 层 | `db.js` | 无 `CHECK` 约束（spec 要求 API+DB 双层） |
| execSync | `gitlab.js:91` | 仍是 shell 字符串形式 |

**Phase 4 处置**：AC-08 拆成 AC-08a（module_key，现状已过）与 **AC-08b（sub_path/path_prefix 穿越，新增）**。已在第 5 节列为 IT-SEC-02~04。建议 architect/pm 确认是否将 AC-08b 补进 SPEC §9。

### 4.2 AC 覆盖矩阵

| AC | 功能 | 测试层 | 用例 ID | 备注 |
|---|---|---|---|---|
| AC-01 | Token 加密不回明文 | 集成 | IT-F1-01/02 | |
| AC-02 | MASTER_KEY 缺失 fail-fast | E2E | E2E-F1-01 | 进程退出码 + stderr 指引 |
| AC-03 | bcrypt.compare 登录 | 单元+集成 | UT-F1-01, IT-F1-03 | 现状 `routes.js:25` 明文 `WHERE password=?` |
| AC-04 | properties 不进 prompt | 单元 | UT-F2-01~04 | 纯函数，正则测试集 |
| AC-05 | 429 重试 1 次后降级 | 单元 | UT-F3-02 | |
| AC-06 | 超时中断 | 单元 | UT-F3-03 | **口径冲突见下** |
| AC-07 | 裸 string 走兜底 | 单元 | **UT-B1-04（核心回归）** | |
| AC-08 | module_key 400 | 集成 | IT-SEC-01 | **盲区，见 4.1** |
| AC-09 | 可信度三件套 | E2E | E2E-F4-01 | |
| AC-10 | Mock 琥珀警示条 | E2E | E2E-F4-02 | |
| AC-11 | 缺 level 重试一次 | 单元 | UT-F5-01 | |
| AC-12 | files 真实路径 | 集成 | IT-F6-02 | 关联 CONF-9 |
| AC-13 | 模块搜索多选 | E2E | E2E-F7-01 | |
| AC-14 | SOP 节点链四态 | E2E | E2E-F8-01 | |
| AC-15 | P0 合规 | 门禁 | GATE-01~03 | |

**AC-06 超时口径冲突**：AC-06/PRD §8 F3/SPEC §10 均写 **60s**；b1-spec §3.2 代码写 `timeoutMs = 15000`（15s），tech-spec BLOCKER-3 写"默认 60s，按 provider 可配"；DDL `ai_providers.timeout_ms DEFAULT 60000`。**三处不一致**。测试断言以 **60s 上限 + provider 可配** 为准，请 architect 确认 b1-spec 的 15000 是否笔误。

---

## 5. 分层测试计划

### 5.1 单元测试（server，node:test）

**B1 契约（最高优先级）**

| ID | 用例 | 断言 |
|---|---|---|
| UT-B1-01 | L1 `capability='json_schema'`，fetch 返回合法 JSON | 返回 `{content: object, model:'llm'}`，`content.level`/`rationality.verdict` 存在 |
| UT-B1-02 | L2 `capability='json_object'` | **system prompt 含 "json" 字面量**（DeepSeek/GLM/通义 400 陷阱）；返回 object |
| UT-B1-03 | L3 `capability='prompt_only'`，返回 ```json 包裹 | `extractJsonBlock` 抽出并过 Zod |
| **UT-B1-04** | **核心回归：fetch 返回裸 string（无 JSON）** | **不抛错**；`typeof content === 'object'`；PRECHECK→`{pass:true,...}`，EVALUATE→`{level:'L3',...}`；`_source==='fallback'` |
| UT-B1-05 | **mock 路径 PRD_GEN**（打 CONF-6） | `typeof content === 'object'` 且含 `text` 字段——当前伪码会返回 string，**预期红** |
| UT-B1-06 | 形状不变量：6 个 action × mock/llm/fallback 三路径 | `typeof result.content === 'object'` 恒成立 |
| UT-B1-07 | `extractJsonBlock` 边界 | 无 `{`、只有 `{`、嵌套 `{}`、空串、null → 不抛错 |
| UT-B1-08 | `withCodeContext` 透传 `maxFiles`（§3.6） | `buildCodeContext` 收到 `maxFiles:6` 而非默认 8 |

**F2 敏感文件过滤（纯函数，正则测试集）**

| ID | 输入 | 预期 |
|---|---|---|
| UT-F2-01 | `application.properties` / `application-dev.yml` / `bootstrap.yaml` / `logback.xml` / `nacos.properties` / `.env` / `id_rsa.pem` / `keystore.jks` | `isSensitiveFile` 全 true |
| UT-F2-02 | **误杀反例**：`pom.xml` / `webpack.config.js` / `application/UserService.java` / `Environment.java` | 全 false |
| UT-F2-03 | `redactSecrets`：`password=x` / `secret: y` / `api_key=z` / `AKIA0123456789ABCDEF` / PEM 私钥块 | 值替换为 `***REDACTED***`，**结构保留** |
| UT-F2-04 | 大小写与变体：`PASSWORD =`、`Api-Key:`、`token = "abc"` | 命中 |

**F1 加密**

| ID | 用例 | 断言 |
|---|---|---|
| UT-F1-01 | `bcrypt.compare` 正确/错误密码 | true / false |
| UT-F1-02 | AES-256-GCM roundtrip | `decrypt(encrypt(x)) === x`；密文 `v1:` 前缀；同一明文两次加密**密文不同**（IV 随机） |
| UT-F1-03 | 密文被篡改（改 tag/cipher 一字节） | 解密抛错或返回 null，**不返回错误明文**（GCM 完整性） |
| UT-F1-04 | 掩码占位符 `••••••••` 提交 | 保持原值，不覆盖（PRD §8 F1 第 3 条） |

**F3 网关**

| ID | 用例 | 断言 |
|---|---|---|
| UT-F3-01 | 双协议：anthropic / openai-compat | 请求 URL、header、body 形状正确 |
| UT-F3-02 | 429 | 重试 **恰好 1** 次，间隔 ≥2s，仍失败→降级 mock，`degraded_reason` 记录 |
| UT-F3-03 | 超时 | AbortController 触发，走降级，**不挂起**；上限 60s（见 AC-06 口径冲突） |
| UT-F3-04 | 401 | 降级 mock，`degraded_reason='401'`，**不静默** |
| UT-F3-05 | 连通性测试错误分类 | 区分鉴权失败/网络不通/模型不存在，3s 内返回 |

**F5 Schema 校验**

| ID | 用例 | 断言 |
|---|---|---|
| UT-F5-01 | 返回 JSON 缺 `level` | 重试一次且提示词追加字段要求；二次失败→降级 mock + 记录原始响应 |
| UT-F5-02 | markdown 包裹 JSON | 正确剥离 |

### 5.2 集成测试（API + DB）

| ID | 用例 | 断言 |
|---|---|---|
| IT-F1-01 | POST provider 后查 DB | `api_key_enc` 为 `v1:` 密文，**`api_key` 列为空** |
| IT-F1-02 | GET providers | 响应体**不含明文**（全字段递归扫描 key/token/password） |
| IT-F1-03 | 登录 | 走 bcrypt；存量明文密码启动迁移后可登录，日志记录条数 |
| **IT-SEC-01** | POST module_key=`a"; touch /tmp/pwned; #` | 400 且 `/tmp/pwned` 不存在（AC-08） |
| **IT-SEC-02** | POST/PUT `sub_path='../../../../etc'` | **400 拒绝**（AC-08b 新增，当前预期红） |
| **IT-SEC-03** | 穿越后 `GET /modules/:id/tree` | 不回显 `REPOS_DIR` 外内容 |
| **IT-SEC-04** | `path_prefix` 穿越 | realpath 校验拦截 |
| IT-SEC-05 | module_key 超 64 字符 | 400 |
| IT-SEC-06 | 未认证访问受保护端点 | 401 |
| IT-SEC-07 | 普通用户调 admin 端点 | 403（PRD §9 节点互斥） |
| IT-B1-01 | 契约：mock provider 跑 PRECHECK，`pass=false` | `raiseClarifies` 触发，clarifies 表落库 |
| IT-B1-02 | EVALUATE | `touchReq` 回填 `level`；`verdict==='NEED_CLARIFY'` 触发澄清 |
| IT-F6-01 | 同步 | `sync_tasks` QUEUED→RUNNING→OK，记录 commit SHA 与文件数 |
| IT-F6-02 | 关联 2 模块评估 | prompt 含目录树；`impact_scope[].files` 为**真实存在路径**（逐个 `fs.existsSync` 校验，非占位串） |
| IT-F6-03 | 仓库 >5000 文件 | 目录树 ≤120 条，注入 ≤16000 字符 |
| IT-F6-04 | GitLab 401 | `sync_status=FAILED` + 可读 `error_msg` |
| IT-F2-01 | 仓库含 `application.properties` + `.env` | 二者**既不在目录树也不在 key_files**；同步结果记录"已过滤 N 个敏感文件" |
| IT-OBS-01 | ai_tasks 落库 | 模型/耗时/成败/降级原因/structured_level/code_files_used 齐全 |
| IT-API-01 | `/api` 与 `/api/v1` 双挂载 | 同一 router，老端点裸 JSON、新端点 `{code,data,message}` 包络 |

### 5.3 E2E（核心用户旅程，对齐 tech-spec §9）

| ID | 步骤 | 断言 |
|---|---|---|
| E2E-F1-01 | 不设 `SOP_MASTER_KEY` 启动 | 进程 **fail-fast 退出**（非 0 退出码）+ stderr 打印指引，**不静默降级明文** |
| E2E-01 | 配置 Provider → 连通性测试 | `ok:true` + 延迟 + 能力级别 |
| E2E-02 | 建模块 → 同步 | `data/repos/<key>/` 出现文件 |
| E2E-03 | 建需求关联模块 → 提交 → EVALUATE | 走到评估节点 |
| E2E-04 | 打开详情 | **EvaluationView 整块渲染**等级/人日/影响面表格（非 markdown 一坨）；列表等级标签有值 |
| E2E-05 | `GET /requirements/:id/code-context` | 返回真实仓库文件路径 |
| E2E-06 | DEV_PROMPT | 产物含真实文件路径与类名 |
| E2E-07 | 改错 api_key 重跑 | 产物**仍结构化**；降级徽标可见；`ai_tasks.degraded_reason=401` |
| E2E-08 | 连触 6 模块同步 | 无 429 失败，串行完成（总耗时 ≥60s 属预期） |
| **E2E-REG-01** | **CONF-5 回归**：查看 PRD / DEV_PROMPT 产物 | **渲染为 markdown，不是 JSON dump** |
| **E2E-REG-02** | **CONF-4 回归**：查看 TEST_CASE 产物 | **TestCaseView 表格正常**，不是 JSON dump |
| **E2E-REG-03** | **CONF-3 回归**：verdict 各枚举值 | `OK` 显示"需求合理"绿标，`REJECT` 有独立展示，不落"存疑" |
| **E2E-REG-04** | **R6 回归**：ReqList 分组排序 | 已完成/已驳回分组仍排在**末尾**（见下） |

### 5.4 回归测试（基于改动影响分析）

**R6 高风险：emoji 是承重结构**

`ReqList.tsx:57`：
```js
order.sort((a, b) => (a.startsWith('✅') || a.startsWith('🚫') ? 1 : 0) - (...));
```
**分组 key 的 emoji 参与排序逻辑**。若前端做字符级 emoji→icon 替换，`startsWith` 全部失效 → 已完成/已驳回分组不再沉底 → **不报错、不崩溃、排序静默错乱**。tech-spec R6 已标"概率高"。

**要求**：必须结构化重构为 `{key, label, icon, weight}` 并按 `weight` 排序，禁止字符替换。**E2E-REG-04 专测此点，且必须在 emoji 清理提交的同一批次验证。**

**其他回归面**

| 改动 | 波及旧行为 | 风险 | 用例 |
|---|---|---|---|
| B1 出口改 object | PRD/DEV_PROMPT/TEST_CASE 渲染路径 | **高** | E2E-REG-01/02 |
| verdict 枚举 | EvaluationView 标签语义 | **高** | E2E-REG-03 |
| emoji 清理 | ReqList 分组排序 | **高** | E2E-REG-04 |
| emoji 清理 `gitlab.js:139` | dirTree 输出格式变化 → prompt 内容变化 | 中 | IT-F6-02 |
| bcrypt 迁移 | 存量用户登录 | **高** | IT-F1-03 |
| Admin.tsx 拆包 | 用户/模板/AI/模块/映射 5 个 Tab 全功能 | 中 | 手工冒烟全 Tab |
| `/api/v1` 双挂载 | 存量前端全部调用 | 中 | IT-API-01 + 全页冒烟 |
| F2 过滤 | 正常代码文件不被误杀 | 中 | UT-F2-02 |

**P0 缺陷回归集沉淀**：每个 P0 修复后落 `server/tests/regression/<缺陷名>.test.js`，进版本库，每次改动都跑，只增不删。

---

## 6. 安全测试（OWASP MVP）

| 风险 | 方法 | 预期 |
|---|---|---|
| 命令注入 | module_key/sub_path/branch 注入 shell 元字符 | 400；`execFileSync` 数组参数不经 shell |
| 路径穿越 | `sub_path='../../..'`、`path_prefix` 同理 | realpath 前缀校验拒绝 |
| 敏感数据泄露 | 递归扫描所有 API 响应 | 无 `password`/`api_key`/`token`/`secret` 明文 |
| **凭据外发 LLM** | 仓库植入 `application.properties` 含 DB 密码，跑评估 | **prompt 中无该文件、无密码串**（BLOCKER-6，F3 硬前置） |
| 未认证访问 | 无 token 调受保护 API | 401 |
| 权限越权 | 普通用户调 admin API / 非负责人操作节点 | 403 |
| XSS | 需求标题/描述注入 `<script>alert(1)</script>` | 转义不执行（详情/列表/看板三处渲染点） |
| SQL 注入 | 搜索框 `' OR 1=1 --` | 参数化查询，无越权数据 |
| 会话 | token 过期机制 | 过期后 401 |
| 上传/体积 | 仓库 >200MB / >20000 文件 | 标记 FAILED + 明确文案，不 OOM |

> `sessions` 表 token 当前无过期字段，PRD §9 要求"会话 Token 有过期机制"，需确认是否纳入一期。

---

## 7. P0 合规门禁（GATE，任一不过即阻断）

```bash
# GATE-01 emoji 必须为 0（用 -o 计个数，非 -c 计行数）
rg -o '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}\x{FE0F}]' web/src server/src | wc -l   # 必须 0

# GATE-02 单文件 <= 300 行
find server/src web/src \( -name '*.js' -o -name '*.tsx' -o -name '*.ts' \) \
  | xargs wc -l | awk '$2!="total" && $1>300 {print "OVER LIMIT:", $0}'   # 必须无输出

# GATE-03 紫粉渐变
rg -n 'purple.*pink|7C3AED.*(A855F7|EC4899)|from-purple.*to-pink' web/src   # 必须无输出

# GATE-04 AI 模板味
rg -n 'Welcome to|Lorem ipsum|Sign up today' web/src   # 必须无输出

# GATE-05 图标库唯一性（Lucide 收口）
rg -n "from '(react-icons|@heroicons|antd/icons)" web/src   # 必须无输出

# GATE-06 硬编码置信度（PRD §6.2 强约束 4）
rg -n 'confidence.*[:=].*0\.[0-9]' web/src   # 前端不得硬编码，人工复核
```

**反作弊门（依赖 BLOCK-QA-1 解决）**：测试文件删除 / 断言数下降 / 新增 skip·xfail·.only / 断言硬编码实现输出 / 测试框架配置篡改 —— 任一命中即 P0 阻断。

---

## 8. 北星指标埋点验证

`ai_output_adopted`（AI 采纳率，目标 ≥60%）是北星指标，**埋点错 = 指标错 = 决策错**，按 P0 测。

| ID | 用例 | 断言 |
|---|---|---|
| UT-TRK-01 | 产品未改 AI 的 level 与 impact_scope 即通过评审 | `adopted=true`，`modified_fields=[]` |
| UT-TRK-02 | 产品改了 `level` | `adopted=false`，`modified_fields` 含 `level` |
| UT-TRK-03 | 只改 `effort` 不改 level/impact_scope | 按 SPEC §1 定义（采纳率只看**改动等级与影响模块**）→ **仍算 adopted=true**。需 pm 确认口径 |
| UT-TRK-04 | 降级 mock 产生的产物 | **不得计入采纳率分母**（否则 mock 稀释北星指标）。需 pm 确认 |
| UT-TRK-05 | 隐私 | 事件**不含需求正文与代码内容**，只有长度与计数（PRD §9.1） |
| UT-TRK-06 | 公共属性 | 每条含 `user_id`/`role`/`timestamp`/`version` |
| UT-TRK-07 | `requirement_returned` | 返工率统计正确（`from_node`/`to_node`/`reason_len`） |

> UT-TRK-03/04 两处口径 PRD 未写死，**请 pm 裁决**，否则北星指标可能算出两个不同数。

---

## 9. 准入与准出

**Phase 4 准入（缺一不测）**
1. BLOCK-QA-1 git 基线提交完成
2. BLOCK-QA-2 测试框架就位，`npm test` 可跑
3. 第 3 节 9 项契约冲突**全部裁决并落文档**
4. 后端/前端自检通过，AC-06 超时口径确认

**准出（上线门槛）**

| 指标 | 目标 |
|---|---|
| 冒烟测试 | 通过 |
| 功能测试通过率 | 100% |
| P0 缺陷 | **0** |
| P1 缺陷 | ≤ 总数 × 20% |
| 覆盖率 | ≥ 80% |
| 回归率（旧行为由绿转红） | **0（非零不算完成）** |
| 反作弊门 | 通过 |
| P0 合规 GATE-01~06 | 全过 |
| 生产就绪档位 | **≥ Silver**（7 维取最低） |

---

## 10. 待裁决事项汇总

| # | 事项 | 需谁裁决 |
|---|---|---|
| 1 | **PRD §6.2 与实现整体对齐**（questions/issues 类型、TestCaseItem 的 result vs priority、steps string vs string[]）——追认实现并更新 PRD，还是返工 | **pm（阻塞 QA 写断言）** |
| 2 | **CONF-3 verdict 枚举**：schema 允许 `OK` 但前端只认 `REASONABLE`，且 PRD 的 `REJECT` 两侧都不支持。三处需同批改 | architect + pm + 前后端 |
| 3 | CONF-7 PRECHECK 门禁 AND/OR（`engine.js:112`） | architect + pm |
| 4 | CONF-8 无上下文时 `effort.confidence` 须 ≤0.5（`ai.js:121` 现 0.6） | backend |
| 5 | CONF-9 `impact_scope[].files` 占位串须改空数组（`ai.js:93`） | backend |
| 6 | AC-06 超时 15s vs 60s | architect |
| 7 | AC-08b 路径穿越是否补进 SPEC §9 | architect + pm |
| 8 | 采纳率口径（UT-TRK-03/04） | pm |
| 9 | 会话 token 过期是否纳一期 | pm |
| 10 | git 初始化 + 测试框架选型 | devops |

---

> 本文只做调研与计划，未修改任何业务代码。Phase 4 开始后按第 5 节执行，断言值只认 Spec，不认实现返回值。
