# AI 驱动的需求交付 SOP 系统 · 需求与技术设计文档（PRD + Tech Spec）

| 项目 | 说明 |
|---|---|
| 文档版本 | v0.3 |
| 撰写日期 | 2026-07-30 |
| 文档状态 | 待评审 |
| 目标读者 | 产品、研发、测试、CSM、管理员 |

## 已确认决策（2026-07-30）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 代码仓库接入 | **系统内手动配置仓库**（地址、凭证、分支、模块映射），不做自动发现 |
| D2 | AI 能力 | 管理后台配置各家 **API Key**，系统统一调用；支持 **Claude、OpenAI(Codex)、Kimi(Moonshot)** 等，模型可扩展；安全合规本期不做约束 |
| D3 | 服务范围 | **多团队/多产品线**：一套系统服务多个团队，数据按团队隔离 |
| D4 | 与现有工具关系 | **替代**现有日常项目管理工具，需自带完整项目管理能力（需求池、迭代、看板、统计） |
| D5 | 文档深度 | 本文档包含到**可直接开发**的技术设计（数据模型、状态机、API、AI 服务） |
| D6 | 注册与账号（v0.3 新增） | 开放**自助注册**；注册时选择申请角色，**首次注册需管理员审批**后生效；管理员可直接创建账号。账号落库（用户名唯一、密码哈希存储），不使用硬编码演示账号 |
| D7 | 节点数据可见性（v0.3 新增） | **最小可见原则**：每个角色只能看到"流转到自己节点时所必需的上游产物"，看不到与己无关的其他节点信息（详见 4.1 数据可见性矩阵） |
| D8 | 流程操作互斥（v0.3 新增） | 各节点**只能由该节点负责角色本人**执行操作（确认/打回/提交），后端强制校验，非负责人不可见操作入口、调用接口返回 403 |
| D9 | 代码接入方式（v0.4 新增） | 管理员在后台配置 **GitLab 地址 + Private Access Token**，平台模块以 **GitLab API archive 快照**方式拉到本地（`server/data/repos/`），不做 git clone、不保留提交历史；AI 只读代码用于分析，不做任何写操作 |
| D10 | 平台模块（v0.4 新增） | "平台模块" 是**业务视角的逻辑模块**（如 usercenter、order、payment），由管理员把一个 GitLab 仓库（或其子路径）映射而来；CSM 提需求时按平台模块多选，AI 评审/研发提示词据此取代码上下文 |

---

# 第一部分：业务需求

## 1. 背景与痛点

当前流程：**CSM/客户提需求 → 产品出文档 → 与研发核对排期 → 出 PRD → 测试 → 上线**。

核心痛点：
1. **周期长**：每个环节人工串联，简单需求也要走完整流程。
2. **需求评估费劲**：依赖研发个人经验，口头沟通成本高，结论难沉淀。
3. **视角割裂**：产品不懂研发实现，研发忽视产品/客户视角，CSM 不懂技术边界，需求合理性没人第一时间把关。
4. **大需求文档不透**：缺乏从客户、产品、研发三视角同时审视的机制，后期返工。
5. **过程不可追溯**：评估结论、PRD 版本、改动范围、测试结论分散在各工具，无法串联。

## 2. 项目目标

| 目标 | 衡量指标 |
|---|---|
| 缩短简单需求评估与排期周期 | 简单需求（L1/L2）提交到排期 < 1 天 |
| 提升评估质量与一致性 | 评估结论结构化留档，可复盘 |
| 提升 PRD 质量 | 一次通过率提升，研发返工率下降 |
| 全流程可追溯 | 任意需求可回溯：原始需求 → AI 评估 → PRD → 研发提示词 → 代码提交 → 测试报告 |
| SOP 可配置 | 管理员自定义流程节点、角色、AI 行为，无需改代码 |
| 替代现有项目管理工具 | 团队日常需求管理完全在本系统内完成 |

## 3. 名词定义

| 名词 | 定义 |
|---|---|
| 需求单 | 系统核心实体，贯穿全流程 |
| AI 评估 | AI 结合代码仓库对需求的初步分析（合理性、影响范围、改动等级） |
| PRD | 产品在"AI 评估 + 原始需求"基础上产出的产品文档 |
| 研发提示词（Dev Prompt） | AI 根据已确认 PRD 生成的、供研发（或其 AI 编码工具）使用的实现指引 |
| SOP 模板 | 管理员配置的流程定义：节点、顺序、负责角色、AI 动作、流转规则 |
| 团队 | 多团队隔离的基本单元，成员、仓库、SOP 模板、需求单均归属团队 |
| 改动等级 | L1-L4，见 6.3 |

## 4. 角色与权限

角色是**角色类型**，在团队维度授权（一个用户可在 A 团队是研发、B 团队是产品）。

| 角色 | 职责 | 关键权限 |
|---|---|---|
| CSM | 提交需求单并指定产品/研发/测试；跟踪进度；上线验收 | 创建/编辑本人需求单、查看团队内进度、验收确认 |
| 产品 PO | 基于 AI 评估产出/修改 PRD；确认后流转研发 | 查看 AI 评估、编辑 PRD、确认/打回 |
| 研发 RD | 接收 Dev Prompt，排期、开发、提交代码 | 查看 PRD/Dev Prompt、填排期、关联代码提交 |
| 测试 QA | 执行测试，输出结论 | 查看 PRD 与提交记录、提交测试报告、打回/通过 |
| 团队管理员 | 本团队人员、仓库、SOP、AI 配置 | 团队内全部配置 |
| 系统管理员 | 跨团队管理、全局 AI 模型配置 | 全部 |

### 4.1 注册与账号（D6）
- **自助注册**：用户名（唯一）/密码/姓名/邮箱 + **申请角色**（CSM/PO/RD/QA）+ 申请加入的团队。
- **审批生效**：注册后账号为 `PENDING` 状态，**需管理员在管理后台审批**（通过/驳回）才激活为 `ACTIVE`；驳回需填原因。管理员创建账号直接 `ACTIVE`。
- 密码 **bcrypt 哈希**存储，禁止明文；登录失败限流（5 次锁 10 分钟）。
- 登录签发会话 Token（JWT 或 opaque token + sessions 表），登出即失效。

### 4.2 流程操作互斥（D8）——后端强制
- 每个 HUMAN 节点绑定负责角色（`sop_node.role`）；需求单上记录各角色**具体负责人**（`requirement.po_id/rd_id/qa_id/csm_id`）。
- **只有"当前节点的负责角色"且"是该需求单上对应角色的指派人"** 才能执行该节点操作（确认/打回/提交产物/回复澄清）。
- 后端在每个流转接口做双重校验：`req.user.role === node.role` **且** `req.user.id === requirement[node.role+'_id']`；不满足返回 403。
- 前端按此隐藏/禁用非本人的操作按钮，但**安全以后端校验为准**。
- 管理员可查看全部，但默认不替人操作（保留"管理员代操作"开关，SOP 可配，操作留痕标注"代操作"）。

### 4.3 节点数据可见性矩阵（D7）——最小可见原则
每个角色打开需求单详情时，**只能看到自己节点所需的上游产物**，其余 Tab/区块不渲染、接口不返回。

| 角色 ↓ 可见内容 → | 原始需求 | AI 评估报告 | 澄清问答 | PRD | Dev Prompt | 代码提交 | 测试用例/报告 | 验收记录 |
|---|---|---|---|---|---|---|---|---|
| **CSM** | ✅(本人) | ✅ 摘要(等级/工作量/结论) | ✅ | ✅ 只读 | ❌ | ❌ | ❌ | ✅ |
| **产品 PO** | ✅ | ✅ 完整 | ✅ | ✅ 可编辑 | ❌ | ❌ | ❌ | ❌ |
| **研发 RD** | ✅ | ✅ 研发视角部分 | ✅(涉己) | ✅ 只读 | ✅ | ✅(本人) | ❌ | ❌ |
| **测试 QA** | ✅ 摘要 | ❌ | ❌ | ✅ 只读(含AC) | ✅ 参考 | ✅ | ✅ 可编辑 | ❌ |
| **管理员** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

实现要点：
- 产物按 `kind` 做**服务端字段级过滤**：`GET /requirements/{id}/artifacts` 根据当前用户角色返回其可见的 kind 子集。
- 时间线 `timeline` 全员可见（操作留痕属公共信息），但 AI 产物的**正文内容**按上表过滤。
- 列表页所有角色可见（标题/状态/负责人/等级属流程元信息），**详情产物内容**按矩阵隔离。

## 5. 整体流程

```
CSM 提交需求单（指定产品/研发/测试 + 目标仓库模块）
   │
   ▼  自动触发
AI 评估（拉取最新代码 → 合理性 + 三视角分析 + 影响范围 + 改动等级 + 工作量 + 风险）
   │  ── 产品可见：原始需求 + AI 评估报告 + 澄清问答
   ▼  流转产品
产品：AI 生成 PRD 初稿 → 在线修改 → 确认
   │
   ▼  产品确认后自动触发
AI 生成研发提示词（面向实现的结构化指引）
   │  ── 研发可见：原始需求 + AI 评估(研发视角) + PRD + Dev Prompt
   ▼  流转研发
研发：排期 → 开发 → 关联代码提交
   │
   ▼  研发提交后自动触发
测试：AI 生成测试用例初稿 → 执行 → 报告
   │  ── 测试可见：需求摘要 + PRD(含AC) + Dev Prompt(参考) + 代码提交
   ▼
测试结论【通过】→ 标记"已完成，待上线验证"
   │
   ▼
测试线上验证【通过】→ 流程结束（DONE），需求单关闭，可发布生产
```

**测试即终点（v0.3 调整）**：流程在**测试节点**收尾，不再单独设 CSM 验收节点。测试分两步：
1. **功能测试**：QA 按用例执行，输出报告 → 通过则状态置 `READY_TO_RELEASE`（已完成，待上线验证）。
2. **线上验证**：发布到生产后 QA 做线上回归验证 → 通过则置 `DONE` 关闭；不通过则打回研发。

**打回机制**：任意下游节点可打回上游（必填原因），全程留痕；打回率作为流程健康度指标。
**快速通道**：L1/L2 需求按 SOP 模板配置可跳过指定节点（如 L1 跳过测试节点直接置 READY_TO_RELEASE）。

## 6. 核心功能需求

### 6.1 登录、注册与多团队
- **注册**（D6）：开放注册入口，填用户名/密码/姓名/邮箱 + 申请角色 + 申请团队；提交后待管理员审批，审批通过方可登录。提供"注册结果查询"（输入用户名查审批状态）。
- **登录**：账号密码登录（预留 SSO 扩展）；未激活/被驳回账号登录时提示对应状态。
- 用户可属多个团队；登录后选择/切换当前团队，工作台数据按当前团队隔离。
- 角色按"团队 + 角色类型"授权。
- **个人中心**：修改密码、查看我的角色与团队、消息偏好设置。

### 6.2 需求单提交（CSM）

| 字段 | 必填 | 说明 |
|---|---|---|
| 需求标题 | 是 | 一句话描述 |
| 需求描述 | 是 | 客户原始诉求，富文本/附件/截图 |
| 客户名称/来源 | 是 | 按客户维度统计 |
| 期望上线时间 | 否 | 客户期望，非承诺 |
| 紧急度 | 是 | P0-P3，CSM 主观评级 |
| 对接产品/研发/测试 | 是 | 从本团队对应角色成员中选择，支持默认值 |
| 目标仓库/模块 | 是 | 从团队已配置仓库中选择（AI 评估前提） |

提交时 AI 先做**需求完整性预检**（描述是否含场景/期望/边界），不完整则提示 CSM 补充（可强制可跳过，SOP 可配）。

### 6.3 AI 需求评估（核心）

**输入**：需求单 + 目标仓库最新代码（代码索引检索）+ 历史需求及实际改动记录（二期校准）。

**输出（结构化评估报告，JSON Schema 约束）**：
1. **合理性判断**：需求是否清晰、与技术现状是否冲突、是否有现成能力可复用、是否有更简单替代方案；需澄清时给出**澄清问题清单**，CSM 在系统内逐条回复。
2. **三视角分析**：客户视角（真正诉求/遗漏场景）、产品视角（交互流程/边界 case/与现有逻辑一致性）、研发视角（实现路径/涉及模块接口表/技术风险）。
3. **影响范围**：受影响模块、接口、数据表、定时任务、第三方依赖（标注代码引用与置信度）。
4. **改动等级**：

   | 等级 | 含义 | 流程建议 |
   |---|---|---|
   | L1 配置/文案级 | 不改代码逻辑 | 快速通道 |
   | L2 小型改动 | 单模块、少量接口 | 标准流程，AI 评估可直接作排期依据 |
   | L3 中型改动 | 跨模块、有表结构变更 | 需研发复核评估 |
   | L4 大型/架构级 | 跨系统、架构调整 | 强制加"技术方案评审"节点 |
5. **预估工作量**：人日区间 + 置信度 + 估算依据。
6. **风险点与依赖**。

> AI 评估是"建议"非"结论"：产品/研发可批注修正，修正数据沉淀用于调优（二期做评估准确率看板）。

### 6.4 产品文档（产品 + AI）
- AI 基于"原始需求 + 评估报告"生成 PRD 初稿，固定章节：背景与目标 / 用户故事与场景 / 功能详述（含边界 case）/ 交互说明 / 非功能要求 / 验收标准 AC / Out of Scope。
- 在线编辑（Markdown），支持：AI 续写/润色/补边界 case；选中段落让 AI "从研发视角查可实现性"或"从客户视角查是否解决诉求"；**版本历史 + diff**。
- 产品「确认」后 PRD 锁定，自动触发 Dev Prompt 生成；后续修改走变更流程（6.10）。

### 6.5 研发提示词（AI）
基于 PRD + 代码库生成：实现步骤拆解（按模块/文件）、接口与表结构建议（DDL 草案）、关键逻辑思路/伪代码、兼容性/性能/安全关注点、建议测试关注点。输出格式兼容主流 AI 编码工具（可直接喂给 Cursor/Claude Code/Codex）。研发可接受/批注/要求重新生成（附原因）。

### 6.6 研发执行
- 填排期（开始/完成时间、人日）。
- 完成后关联代码提交：分支名 / MR 链接 / commit 列表（一期手工填，二期 Git API 自动拉取）。
- 提交后自动流转「待测试」并通知 QA。

### 6.7 测试
- 可见：PRD（含 AC）、Dev Prompt、代码提交记录。
- AI 基于 AC 生成测试用例初稿（正常流/边界流/异常流），QA 增删改后执行，逐条标记结果。
- 结论：通过 / 打回（原因 + 缺陷描述）→ 打回自动通知研发。

### 6.8 工作台、消息中心与看板
- **角色首页**：CSM（我提交的/待澄清/已完成待确认）、产品（待出文档附 AI 评估摘要/进行中/被打回）、研发（我的任务/待排期/被打回）、测试（待测试/待线上验证/已出报告）。
- **消息中心（独立页面）**：
  - 顶部导航常驻**铃铛入口 + 未读角标**，点击进入消息列表页。
  - 消息分类 Tab：流程通知（流转/打回/@我）/ 澄清提问 / 系统公告；支持按已读/未读筛选。
  - 每条消息可**点击跳转到对应需求单详情**；支持单条已读、全部已读。
  - 新消息**轮询/SSE 实时刷新**角标；触发点见 6.11。
- **全局看板**：状态泳道图，按客户/产品/研发/等级/迭代筛选（列表元信息全员可见，详情产物按 4.3 矩阵隔离）。
- **需求池 & 迭代管理**：未排期需求池、迭代（Sprint）规划、迭代内需求拖拽、吞吐统计（燃尽二期）。
- **需求单详情 · 时间线**：状态流转、AI 产物、人工操作、评论全留痕（产物正文按角色过滤）。

### 6.9 管理后台
1. **团队管理**：团队增删改、成员与角色分配。
2. **注册审批（D6）**：待审批账号列表（申请人/角色/团队/时间），通过 / 驳回（填原因）；审批结果通知申请人。也可直接**手动创建账号**（指定角色与团队，直接激活）。
3. **用户管理**：账号启停、重置密码、调整角色、查看登录记录。
4. **仓库配置**（D1）：手动录入——名称、Git 地址、访问凭证（加密存储）、默认分支、模块路径映射、索引开关与状态。
5. **模块管理（D9/D10 · v0.4 新增）**：见 6.12。
6. **SOP 配置**：多套模板；节点启停/排序/负责角色；节点 AI 动作开关；快速通道规则（按改动等级跳过节点）；打回规则；模板与团队/需求等级绑定。
7. **AI 配置**（D2）：
   - **模型管理**：Provider（Claude / OpenAI / Kimi / 自定义 OpenAI 兼容）、API Key（加密存储）、Base URL、模型名、启停、**各能力点可指定不同模型**；
   - **Prompt 模板管理**：各节点 AI 行为的 Prompt 可在线调优，带版本；
   - 调用参数（temperature、max_tokens 等）。
8. **数据看板**：需求吞吐量、各环节平均耗时、打回率、AI 评估采纳率、AI 调用量与费用（按团队/模型）。

### 6.12 模块管理与 GitLab 代码接入（D9/D10 · v0.4 核心新增）

> 目标：让 AI 的评审与研发提示词"长在真实代码上"。管理员把 GitLab 上的代码仓库映射为业务可理解的**平台模块**，CSM 提需求时按模块选择，AI 在评审/生成 Dev Prompt 时实时读取对应模块代码作为上下文。

#### 6.12.1 GitLab 连接配置
| 配置项 | 说明 |
|---|---|
| GitLab Base URL | 如 `https://gitlab.company.com`（支持私有化部署） |
| Private Access Token | 只读权限（`read_api` + `read_repository` scope 即可），加密存储，仅管理员可配/可见（脱敏展示） |
| 连接测试 | 保存前可一键测试连通性与 Token 有效性，返回当前可见的项目数量 |

Token 为全局一份（管理员统一维护），模块不需要单独凭证。

#### 6.12.2 代码模块（GitLab 仓库的本地快照）
- 管理员从"可访问的 GitLab 项目列表"中选择项目，登记为**代码模块**：模块 Key（唯一，如 `usercenter`）、显示名、GitLab 项目、分支、**子路径**（可选，monorepo 时指向具体子目录）、描述。
- **拉取/刷新**：通过 GitLab API 下载该分支的 **archive 快照**，解压到本地 `data/repos/<module_key>/`；记录 `last_synced_at`、`commit_sha`、文件数、同步状态（IDLE/SYNCING/OK/FAILED）。
- 拉取为**手动触发 + 定时可选**；不做 Webhook、不做增量（archive 全量覆盖，成本可控）。
- 快照只用于**读**：AI 分析与代码浏览，系统不对仓库做任何写操作。

#### 6.12.3 平台模块映射
- **平台模块** = 业务视角的逻辑单元（提需求、做评估时的选择粒度）。一个平台模块映射 **1 个代码模块**（未来可扩展多对多）。
- 管理员维护映射：平台模块名（如「用户中心」）→ 代码模块（`usercenter`）+ 生效的子路径前缀。
- CSM 在提交需求时从**平台模块**下拉多选（而非直接面对 GitLab 仓库），屏蔽技术细节。

#### 6.12.4 代码感知的 AI 能力
| 场景 | 代码上下文的注入方式 |
|---|---|
| **AI 需求评估（EVALUATE）** | 取需求关联平台模块 → 对应代码模块 → 本地快照的目录结构 + 关键文件（控制器/入口/实体）→ 注入 prompt，输出**代码可行性分析**与**影响范围（精确到文件/接口）** |
| **研发提示词（DEV_PROMPT）** | 在 PRD 基础上，注入关联模块的**真实代码片段**（关键类/接口签名/现有实现），生成**代码级实现指引**（建议改动文件、新增接口位置、复用点），供研发或 AI 编码工具直接使用 |
| **产品 PRD 阶段** | 评估报告中的影响范围（文件/接口）作为 PRD 的技术参考，产品可据此调整方案 |

代码上下文提取策略（MVP）：按模块快照递归取目录树 + 按扩展名筛选代码文件（`.java/.js/.ts/.go/.py/.sql` 等），优先取文件名含 Controller/Service/Entity/Api/Handler 的文件及入口文件，按 token 预算截断；不做向量化（二期再进化到 RAG）。

### 6.13 需求单与模块的关联
- 需求单新增 `module_ids`（多选平台模块），提交时由 CSM 选择，进入评估/PRD/DevPrompt 全程携带。
- 详情页展示关联的平台模块及其对应代码模块、最近同步状态；AI 产物（评估报告/DevPrompt）中标注引用了哪些模块代码。

### 6.10 需求变更
PRD 确认后变更：产品发起变更申请 → AI **增量评估**（对原影响范围做 diff）→ 重大变更重新走确认。全程版本留痕。

### 6.11 通知
系统内通知（消息中心）+ 邮件；二期对接企微/飞书/钉钉机器人。触发点：流转到本人节点、打回、@、澄清提问、澄清被回复、排期临期、注册审批结果（通知申请人）、测试待线上验证提醒。

## 7. 非功能性需求

| 类别 | 要求 |
|---|---|
| 性能 | 常规页面 < 1s；AI 任务异步（分钟级），有进度反馈与失败重试 |
| 多团队隔离 | 需求单/仓库/SOP/统计数据严格按团队隔离 |
| 安全 | 仓库凭证与 API Key 加密存储（AES）；本期暂不做代码脱敏（D2） |
| 可审计 | 人工操作与 AI 产物全留痕，逻辑删除 |
| 可降级 | AI 服务不可用时节点可手动跳过，流程降级为纯人工流转 |

---

# 第二部分：技术设计

## 8. 技术选型（推荐）

| 层 | 选型 | 说明 |
|---|---|---|
| 后端 | **Java 17 + Spring Boot 3** + MyBatis-Plus | 团队熟悉度优先；可平替 Go/Node，设计不变 |
| 前端 | **React 18 + TypeScript + Ant Design 5** | 管理后台标配，看板用 dnd-kit |
| 数据库 | **PostgreSQL 16 + pgvector** | 业务数据 + 向量检索一个库搞定，省去独立向量库 |
| 缓存/队列 | **Redis**（缓存 + 分布式锁）+ AI 任务用 DB 任务表 + 异步线程池（MVP），量上来再换 MQ | |
| 工作流 | **自研轻量状态机**（SOP 节点表驱动），不引 Flowable——我们的流转规则简单但 AI 钩子多，自研更灵活 | |
| Git 操作 | **JGit**（克隆/拉取/日志） | |
| LLM 接入 | **自研 LLM 网关模块**（见 12） | |
| 部署 | Docker Compose（MVP）→ K8s | |

## 9. 系统架构

```
┌────────────────────────────────────────────────┐
│  Web 前端（React SPA）                           │
└──────────────┬─────────────────────────────────┘
               │ HTTPS / REST
┌──────────────▼─────────────────────────────────┐
│  后端服务（Spring Boot）                         │
│  ├─ 网关层：鉴权(JWT) / 团队上下文 / 参数校验      │
│  ├─ 业务模块                                    │
│  │   ├─ 用户/团队/权限                           │
│  │   ├─ 需求单 + 状态机引擎（SOP 驱动）           │
│  │   ├─ 产物中心（评估/PRD/DevPrompt/用例/版本）   │
│  │   ├─ 迭代/看板/统计                           │
│  │   └─ 通知                                    │
│  ├─ AI 服务层                                   │
│  │   ├─ LLM 网关（多 Provider 适配 + Key 管理）   │
│  │   ├─ Prompt 模板引擎（模板 + 变量渲染 + 版本） │
│  │   ├─ 代码索引服务（拉取 → 解析 → Embedding）   │
│  │   └─ AI 任务执行器（异步队列 + 重试 + 留痕）    │
│  └─ 数据层：PostgreSQL(+pgvector) / Redis / 对象存储(附件,MinIO) │
└────────────────────────────────────────────────┘
```

## 10. 核心数据模型

> 主要表与关键字段（DDL 细节开发时补全；统一含 id/team_id/created_by/created_at/updated_at/deleted 审计字段，* 为索引）。

### 10.1 组织与权限
```sql
sys_user            -- id, username*, password_hash, name, email, avatar,
                    -- status*(PENDING/ACTIVE/REJECTED/DISABLED), reject_reason,
                    -- register_role(申请角色), created_at, last_login_at
sys_registration    -- id, user_id*, team_id, apply_role, status*(PENDING/APPROVED/REJECTED),
                    -- reviewed_by, reviewed_at, review_comment  -- 注册审批流水
sys_team            -- id, name*, code*, owner_id, status
sys_team_member     -- id, team_id*, user_id*, role* (CSM/PO/RD/QA/TEAM_ADMIN), status
                    -- 唯一约束 (team_id, user_id, role)；一人一团多角色 → 多行
```

### 10.2 配置中心
```sql
repo_config         -- id, team_id*, name, git_url, auth_type(SSH/TOKEN), credential_enc,
                    -- default_branch, module_paths(JSON: [{name,path}]), index_status, last_indexed_at
ai_model_config     -- id, team_id(空=全局), provider*(CLAUDE/OPENAI/KIMI/CUSTOM), model_name,
                    -- api_key_enc, base_url, params(JSON), capability*(可绑定能力点), status, priority
ai_prompt_template  -- id, team_id, scene*(EVALUATE/PRD_GEN/DEV_PROMPT/TEST_CASE/PRECHECK/INCR_EVAL...),
                    -- version, content(text, 含 {{变量}}), status, remark
sop_template        -- id, team_id*, name, is_default, status
sop_node            -- id, template_id*, node_key*, name, seq, role_type, ai_action(枚举,可空),
                    -- skippable_levels(JSON,如 ["L1"]), allow_return_to(JSON), status
```

### 10.3 需求主链路
```sql
requirement         -- id, team_id*, req_no*(RQ-20260730-001), title, description(富文本),
                    -- customer_name, priority(P0-P3), expect_date,
                    -- po_id*, rd_id*, qa_id*, repo_id*, module_path,
                    -- level(L1-L4, AI评估后回填), status*(状态机), current_node_key,
                    -- source, closed_at
req_evaluation      -- id, requirement_id*, version, report_json(结构化评估报告), 
                    -- model_id, tokens_in/out, status, feedback_json(人工批注修正)
req_clarify         -- id, requirement_id*, question, answer, asked_by(AI/PO/RD), answered_by, status
req_prd             -- id, requirement_id*, version*, content(md), confirmed, confirmed_by/at, 
                    -- base_evaluation_version
req_dev_prompt      -- id, requirement_id*, version, content(md), model_id, rd_feedback, status
req_test_case       -- id, requirement_id*, version, cases_json([{title,steps,expect,type,result}])
req_test_report     -- id, requirement_id*, conclusion(PASS/REJECT), summary, defect_json, qa_id
req_code_submit     -- id, requirement_id*, branch, mr_url, commits_json([{hash,msg,author}]), rd_id
req_change          -- id, requirement_id*, change_desc, incr_eval_json, status -- 需求变更
req_timeline        -- id, requirement_id*, action(枚举), from_status, to_status, operator(用户/AI),
                    -- detail_json, created_at  -- 全留痕
iteration           -- id, team_id*, name, start_date, end_date, status
iteration_req       -- id, iteration_id*, requirement_id*, sort
attachment          -- id, biz_type, biz_id, file_name, oss_path, size
notification        -- id, user_id*, type, title, content, biz_id, read_flag
```

### 10.4 AI 基础设施
```sql
ai_task             -- id, team_id, biz_type*, biz_id*, scene, model_id, input_json, output_json,
                    -- status*(PENDING/RUNNING/SUCCESS/FAILED/SKIPPED), retry_count, error_msg,
                    -- tokens_in, tokens_out, cost, duration_ms  -- 即审计也是重试载体
code_chunk          -- id, repo_id*, file_path, chunk_index, content, 
                    -- embedding vector(1024), updated_at  -- pgvector, ivfflat 索引
code_outline        -- id, repo_id*, file_path, symbols_json(类/方法/接口签名)  -- 结构摘要,检索提速
```

## 11. 状态机设计

`requirement.status` 枚举与流转（SOP 模板决定实际路径，下表为默认模板的完整路径）：

| 状态 | 含义 | 可流转到 | 触发者 |
|---|---|---|---|
| DRAFT | 草稿（CSM 暂存） | PRE_CHECKING | CSM 提交 |
| PRE_CHECKING | AI 完整性预检中 | CLARIFYING / EVALUATING | AI |
| CLARIFYING | 待澄清 | EVALUATING | CSM 回复澄清 |
| EVALUATING | AI 评估中 | PO_REVIEW / CSM（评估为不合理且 CSM 撤回） | AI |
| PO_REVIEW | 产品出文档中 | DEV_PENDING(确认) / CLARIFYING(打回) | PO |
| DEV_PENDING | 待研发排期 | DEVELOPING | RD 排期 |
| DEVELOPING | 开发中 | TESTING(提交代码) / PO_REVIEW(需求问题打回) | RD |
| TESTING | 功能测试中 | READY_TO_RELEASE(测试通过) / DEVELOPING(打回) | QA |
| READY_TO_RELEASE | 已完成，待上线验证 | VERIFYING(发布生产) / DEVELOPING(发现问题打回) | QA/RD 标记已发布 |
| VERIFYING | 线上验证中 | DONE(验证通过) / DEVELOPING(验证不通过打回) | QA |
| DONE | 已完成（流程结束，可正式发布） | —（终态） | — |
| CANCELLED | 已取消 | —（终态，任意非终态可取消，需原因） | CSM/Admin |

实现要点：
- 状态机由 `sop_node` 表驱动：引擎读取模板节点序列 + 跳过规则（如 L1 跳过 TESTING）+ 打回白名单（`allow_return_to`），不硬编码流转表。
- 每次流转写 `req_timeline`；触发 `ai_action` 的节点自动投递 `ai_task`。
- AI 失败：`ai_task` 重试 N 次后标记 FAILED，节点显示"AI 暂不可用，可手动继续"（降级）。

## 12. AI 服务层设计（重点）

### 12.1 LLM 网关（多 Provider 统一抽象）

```java
interface LlmClient {
    ChatResult chat(ChatRequest req);   // messages, model, params, responseSchema(可选)
    EmbeddingResult embed(List<String> texts);
}
// 实现：ClaudeClient(Anthropic Messages API) / OpenAiCompatClient(适配 OpenAI、Kimi、Codex 等
// 所有 OpenAI 兼容协议) —— 新增厂商 ≈ 加一个配置，不改代码
```
- **路由策略**：按"能力点"（scene）选模型——`ai_model_config.capability` 绑定；同能力点多模型时按 priority + 失败自动降级切换（如 Claude 超时 → 切 Kimi）。
- **结构化输出**：所有评估类调用强制 JSON Schema；解析失败自动重试（带校验错误回灌重问）。
- **用量统计**：每次调用落 `ai_task`（tokens、耗时、折算费用），供看板。

### 12.2 代码索引服务（RAG）

```
手动配置仓库(D1) → 定时/Webhook 触发增量拉取(JGit)
  → 解析：按语言切分(类/方法粒度) + 提取符号大纲(code_outline)
  → Embedding → pgvector(code_chunk)
检索时：需求文本 → 向量召回 topK + 符号大纲过滤 + 关键文件全文
  → 组装上下文(控制在 token 预算内) → 注入 Prompt
```
- 一期语言解析：Java 优先（团队主栈），其余按文件块粗切；后续用 tree-sitter 统一。
- 大仓库按 `module_paths` 分模块索引，评估时只检索目标模块。
- Embedding 模型走 LLM 网关（OpenAI 兼容 embedding 或本地 bge-m3，可配）。

### 12.3 AI 任务执行器
- `ai_task` 表即队列：投递 → 异步 worker 池消费 → 成功回写产物表 / 失败指数退避重试。
- 每个 scene 对应一个 Prompt 模板（`ai_prompt_template`）+ 输出 Schema + 产物落表逻辑，**新增 AI 能力 = 加模板 + 加 scene 处理器**。

### 12.4 评估报告 JSON Schema（示例核心字段）
```json
{
  "rationality": {"verdict": "REASONABLE|NEED_CLARIFY|UNREASONABLE", "reason": "...", "existing_capability": "..."},
  "clarify_questions": ["..."],
  "perspectives": {"customer": "...", "product": "...", "engineering": "..."},
  "impact_scope": [{"module": "...", "files": ["..."], "apis": ["..."], "tables": ["..."], "confidence": 0.8}],
  "level": "L1|L2|L3|L4",
  "effort": {"min_days": 1, "max_days": 3, "confidence": 0.7, "basis": "..."},
  "risks": ["..."],
  "suggested_test_focus": ["..."]
}
```

## 13. API 设计（RESTful，节选）

统一前缀 `/api/v1`，Header 带 `X-Team-Id` 标识当前团队。

```
# 认证/注册/团队
POST /auth/register               # {username,password,name,email,role,team_id} → PENDING
GET  /auth/register-status?u=     # 查询注册审批状态
POST /auth/login                 POST /auth/logout        GET /users/me
GET  /teams                      POST /teams/{id}/switch
# 注册审批（管理员）
GET  /admin/registrations?status=PENDING
POST /admin/registrations/{id}/approve    POST /admin/registrations/{id}/reject
# 需求单
POST /requirements               GET  /requirements?status=&level=&assignee=&iteration=
GET  /requirements/{id}          PUT  /requirements/{id}        GET /requirements/{id}/timeline
POST /requirements/{id}/transition        # 通用流转 {action, reason?}  状态机+节点角色双重校验
POST /requirements/{id}/clarifies/{cid}/answer
# AI 产物（服务端按 4.3 矩阵过滤可见 kind）
GET  /requirements/{id}/evaluation        POST /requirements/{id}/evaluation/feedback
GET  /requirements/{id}/prd               PUT  /requirements/{id}/prd      POST /requirements/{id}/prd/confirm
GET  /requirements/{id}/prd/versions      GET  /requirements/{id}/prd/diff?v1=&v2=
GET  /requirements/{id}/dev-prompt        POST /requirements/{id}/dev-prompt/regenerate
GET  /requirements/{id}/test-cases        PUT  /requirements/{id}/test-cases
POST /requirements/{id}/test-report       POST /requirements/{id}/code-submits
POST /requirements/{id}/release           # 标记已发布生产 → VERIFYING
POST /requirements/{id}/verify            # 线上验证 {pass, reason?} → DONE / 打回
# AI 辅助（编辑器内）
POST /ai/assist {scene, context, instruction}    # 续写/润色/视角检查，流式 SSE 返回
# 消息中心
GET  /notifications?read=&type=           POST /notifications/{id}/read
POST /notifications/read-all              GET  /notifications/unread-count
# 看板/迭代
GET  /board?iteration=           POST /iterations      PUT /iterations/{id}/requirements
# 管理后台
CRUD /admin/users  /admin/teams  /admin/repos  /admin/models  /admin/prompts  /admin/sop-templates
# 模块管理（D9/D10）
GET  /admin/gitlab/test                       # 测试 GitLab 连接
GET  /admin/gitlab/projects                   # 列出可访问 GitLab 项目
GET  /admin/gitlab/projects/{id}/branches     # 项目分支列表
GET  /admin/modules        POST /admin/modules        PUT /admin/modules/{id}   DELETE /admin/modules/{id}
POST /admin/modules/{id}/sync                 # 拉取/刷新 archive 快照
GET  /admin/mappings       POST /admin/mappings       DELETE /admin/mappings/{id}
POST /admin/repos/{id}/reindex               GET /admin/stats/overview
```

## 14. 前端页面清单

| 模块 | 页面 |
|---|---|
| 公共 | 登录、**注册（含角色/团队选择 + 审批状态查询）**、团队切换、个人中心、**消息中心（列表+分类Tab+未读角标+跳转）** |
| 工作台 | 角色首页（按角色渲染待办）、全局看板、需求池、迭代管理 |
| 需求单 | 创建/编辑、详情（信息 + 状态条 + 时间线 + **按角色过滤的产物 Tab**）、澄清问答、PRD 编辑器（AI 侧栏 + 版本 diff）、测试执行页、**上线验证页** |
| 管理后台 | 团队/成员、**注册审批**、用户管理、仓库配置、**模块管理（GitLab 配置/代码模块/平台模块映射）**、AI 模型配置、Prompt 模板、SOP 模板（可视化节点编排）、数据看板 |

## 15. 分期规划

| 阶段 | 范围 | 目标 |
|---|---|---|
| **一期 MVP** | 登录/多团队/角色、**GitLab 配置 + 模块管理（archive 快照）+ 平台模块映射**、LLM 网关（Claude+OpenAI 兼容）、需求单（关联平台模块）+ 默认状态机、AI 预检+评估报告（**注入代码上下文做可行性分析**）、PRD 编辑+AI 初稿+版本、Dev Prompt 生成（**注入代码片段**）、测试用例生成+报告、代码提交手工关联、角色工作台+基础看板、系统内通知、管理后台（成员/模块/SOP/模型/Prompt/单 SOP 模板） | 跑通主链路，验证 AI 评估质量与代码感知价值 |
| **二期** | 多 SOP 模板+可视化编排、快速通道、需求变更+增量评估、Git API 自动关联 MR、IM 通知、迭代管理完善、版本 diff 增强、评估采纳率统计 | 流程闭环 + 完全替代现有工具 |
| **三期** | 评估准确率校准（实际改动数据回灌调优）、跨仓库影响分析、tree-sitter 多语言、数据看板增强、SSO | 数据驱动优化 |

## 16. 风险与应对

| 风险 | 应对 |
|---|---|
| AI 评估不准 → 信任崩塌 | 一期定位"辅助建议"，保留人工确认；收集修正数据持续调优 Prompt；评估报告强制标注置信度 |
| 代码索引质量差 → 评估失真 | 一期限定主语言+模块级索引；提供 reindex 手动入口；评估报告中展示引用的代码片段供人核验 |
| 多模型行为不一致 | 网关层统一 Schema 校验 + Prompt 按 Provider 微调；能力点可锁定模型 |
| 流程僵化 | SOP 可配置 + 快速通道 + AI 节点可降级跳过 |
| 范围膨胀 | 严格按分期执行；一期任何"锦上添花"需求进二期池 |

## 17. 待确认项（Checklist）

- [ ] 后端技术栈确认：Spring Boot 3 是否采纳？（还是 Go/Node）
- [ ] 团队主语言确认（影响一期代码索引解析器）：Java？还有别的？
- [ ] 部署环境：私有化服务器 or 云？是否有现成 PostgreSQL/Redis？
- [ ] 附件存储：MinIO 私有化 or 云 OSS？
- [ ] 通知：一期邮件即可，还是必须对接 IM（企微/飞书/钉钉）？
- [ ] 一期团队规模（团队数/人数/仓库数），评估索引与 AI 调用量
- [ ] 注册审批流（D6）：是否所有角色都需审批，还是 CSM 可免审批直接激活？
- [ ] 节点可见性（D7）：测试 QA 是否需要看到完整 AI 评估报告（当前矩阵给的是"需求摘要"）？

---

## 附录：版本变更记录

### v0.3（2026-07-30）
- **D6 注册与账号**：开放自助注册 + 管理员审批流；密码哈希；`sys_user` 增加状态与申请角色字段，新增 `sys_registration` 审批流水表；新增注册/审批 API。
- **D7 节点数据可见性**：新增 4.3 数据可见性矩阵，按"最小可见原则"定义各角色可见的产物范围；产物接口服务端按角色过滤。
- **D8 流程操作互斥**：节点操作需"角色匹配 + 该需求单指派人匹配"双重校验，后端强制 403。
- **消息中心升级**：独立消息页面（分类 Tab / 未读角标 / 跳转 / 全部已读），替代原简单通知。
- **测试收尾流程**：流程终点改为测试节点，拆为"功能测试（READY_TO_RELEASE）→ 线上验证（DONE）"两步，取消独立 CSM 验收节点；新增 `/release`、`/verify` 接口。
- 管理后台新增"注册审批"与"用户管理"模块。
