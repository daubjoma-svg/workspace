# B1 实现 Spec：AI 节点契约统一（三级结构化输出降级 + Zod 校验出口）

> 状态：可执行实现 Spec（待开发照做）
> 关联：BLOCKER-1（tech-spec-phase1.md）、ADR-002（结构化输出三级降级）、team-lead 决策①（B1~B6 全纳）
> 范围：仅 B1。F1（凭证加密）/F2（敏感过滤）见各自实现 Spec，本 Spec 不覆盖。

---

## 0. 对齐声明（必读）

本 Spec 的 Zod 字段集合依据**三源合并**：

1. **engine.js 下游实际消费字段**（最权威——"下游需要什么"）：PRECHECK 消费 `pass`/`questions`；EVALUATE 消费 `level`/`rationality.verdict`(需 `=== 'NEED_CLARIFY'` 才触发澄清)/`clarify_questions`。
2. **pm PRD v0.5.2 §6.2 锁定字段清单**：`rationality` / `level` / `effort` / `impact_scope` / `clarify_questions` / `risks` / `suggested_test_focus` / `perspectives`。
3. **现有 mock 产物**（保持 mock 与真实 LLM 输出形状一致，避免改造后 mock 反而崩）：`mockPrecheck` 含 `issues`/`summary`；`mockEvaluate` 含 `existing_capability`/`effort.basis`/`perspectives.customer|product|engineering`/`impact_scope.module|files|apis|tables|confidence`。

若 PRD §6.2 有本 Spec 未覆盖的差异字段，**以 PRD 为准**，仅需在本 Schema 补字段（加 optional 字段即可，不影响下游消费）。team-lead 提到"§6.2 细节之前发过"，若现实与下方假设不同，aler 后我方 30 分钟内补字段。

枚举值对齐风险（重点）：
- `rationality.verdict`：engine.js 仅在 `=== 'NEED_CLARIFY'` 时触发澄清闭环。Schema 枚举必须同时包含通过态与 `NEED_CLARIFY`，否则真实 LLM 无法走澄清闭环。采用 `enum(['OK','REASONABLE','NEED_CLARIFY'])`。
- `level`：现有 mock 用 `L1~L4`。若 PRD §6.2 定义不同（如 `S/M/L` 或 `1~5`），**以 PRD 为准**替换枚举，下方用 `L1~L4` 作占位。

---

## 1. 根因（BLOCKER-1 证据链）

`ai.js` `runAI`（213-239）返回形状的 `{ content, model }` 外壳统一，但 `content` **类型不统一**：

- 真实 LLM 路径（ai.js:225-226）：`const real = await callLLM(...); if (real) return { content: real, model: 'llm' };`
  —— `callLLM` 返回**裸 string**（anthropic: `(data.content||[]).map(c=>c.text).join('\n')`；openai: `data.choices?.[0]?.message?.content`）。
- mock 路径（ai.js:231-238）：`content = mockEvaluate(...)` 等 —— **object**。

下游 `engine.js` `runAiNode`（108-122）一律按对象消费：
- PRECHECK：`if (!content.pass && content.questions?.length)` → `content.pass` 为 string 时 `!string` 恒 false，门禁静默失效。
- EVALUATE：`if (content.level) touchReq(...)` → string 无 `.level`，改动等级永不回填；`content.rationality?.verdict === 'NEED_CLARIFY'` → undefined，AI 澄清闭环永不触发。

**特征**：不报错、不崩、流程照走，但 AI 评估的全部价值（等级/澄清/可行性）被静默丢弃。这就是"接了等于没接"。

**B1 目标**：无论 mock 还是真实 LLM、无论哪级降级，`runAI` 恒返回 `content` 为**经过 Zod 校验的合法对象**，下游按对象消费恒成立。

---

## 2. 字段契约（Zod Schema）

新增文件 `server/src/llm-schema.js`（CommonJS，依赖 `zod`）：

```js
// server/src/llm-schema.js
const { z } = require('zod');

// 所有产物共有的元信息（便于观测与兜底）
const Meta = z.object({
  _source: z.enum(['llm', 'mock', 'fallback']).optional(),
  _raw: z.string().optional(), // 原始 LLM 文本，调试用
});

// PRECHECK（需求完整性预检）—— engine.js 消费 pass/questions
const PrecheckResult = Meta.extend({
  pass: z.boolean(),
  questions: z.array(z.string()).default([]),
  issues: z.array(z.string()).default([]),     // mock 兼容字段
  summary: z.string().optional(),              // mock 兼容字段
});

// EVALUATE（需求评估）—— 字段最多，对齐 PRD §6.2 + mock
const EvaluateResult = Meta.extend({
  level: z.enum(['L1', 'L2', 'L3', 'L4']),     // 若 PRD §6.2 用其他枚举，以此替换
  rationality: z.object({
    verdict: z.enum(['OK', 'REASONABLE', 'NEED_CLARIFY']), // 必须含 NEED_CLARIFY 才能走澄清闭环
    reason: z.string().optional(),
    existing_capability: z.string().optional(), // mock 兼容字段
  }),
  clarify_questions: z.array(z.string()).default([]),
  effort: z.object({
    min_days: z.number(),
    max_days: z.number(),
    confidence: z.number().optional(),
    basis: z.string().optional(),              // mock 兼容字段
  }).optional(),
  impact_scope: z.array(z.object({
    module: z.string(),
    files: z.array(z.string()).default([]),
    apis: z.array(z.string()).default([]),
    tables: z.array(z.string()).default([]),
    confidence: z.number().optional(),
  })).optional(),
  risks: z.array(z.string()).default([]),
  suggested_test_focus: z.array(z.string()).default([]),
  perspectives: z.object({
    customer: z.string().optional(),
    product: z.string().optional(),
    engineering: z.string().optional(),
  }).optional(),
});

// 长文类：PRD_GEN / DEV_PROMPT / TEST_CASE / CUSTOM / NOTE
// 关键：真实 LLM 返回裸 string 必须包成 { text }，绝不直接返回 string
const DocResult = Meta.extend({
  text: z.string(),
});

const SCHEMA_BY_ACTION = {
  PRECHECK: PrecheckResult,
  EVALUATE: EvaluateResult,
  PRD_GEN: DocResult,
  DEV_PROMPT: DocResult,
  TEST_CASE: DocResult,
  CUSTOM: DocResult,
};

module.exports = { PrecheckResult, EvaluateResult, DocResult, SCHEMA_BY_ACTION, Meta };
```

---

## 3. 三级结构化输出降级

真实 LLM 调用按 Provider 能力分级（对应 ADR-002 / openapi.yaml `ProviderCapability`）。

### 3.1 Provider 能力来源
`ai_providers` 表新增 `capability` 字段（TEXT，JSON），值之一：`json_schema` | `json_object` | `prompt_only`。
- anthropic → `json_schema`（走 `output_config.format`，已 GA）
- 支持 json_schema 的 OpenAI 兼容（如 Kimi）→ `json_schema`
- 仅支持 json_object 的（DeepSeek / GLM / 通义）→ `json_object`
- 无 response_format 字段的（混元 / MiniMax）→ `prompt_only`

### 3.2 降级逻辑（新增 `server/src/llm-call.js` 或扩展 `ai.js`）

```js
async function callLLMStructured(system, user, action, provider) {
  const schema = SCHEMA_BY_ACTION[action] || DocResult;
  const cap = (provider.capability) || 'prompt_only';
  const timeoutMs = 15000; // BLOCKER-3 修复：AbortController 超时
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let bodyMessages = [
    { role: 'system', content: system + schemaHint(action, cap, schema) },
    { role: 'user', content: user },
  ];
  let body = { model: provider.model, messages: bodyMessages, temperature: 0.3 };

  // L1：原生强约束
  if (cap === 'json_schema') {
    body.response_format = { type: 'json_schema', json_schema: { name: action, schema: zodToJsonSchema(schema) } };
  }
  // L2：弱约束 + 自动注入 "json" 字面量（DeepSeek/GLM/通义 要求 prompt 含 "json" 否则 400）
  else if (cap === 'json_object') {
    bodyMessages[0].content += '\n\n你必须且只能输出一个合法的 JSON 对象，不要包含任何解释性文字或 markdown 代码块标记，且你的回答中必须包含 "json" 这个词。';
    body.response_format = { type: 'json_object' };
  }
  // L3：prompt_only，schema 已内嵌到 system（schemaHint 处理），下面抽取 JSON 块兜底

  try {
    const res = await fetch(url(provider), {
      method: 'POST', headers: headers(provider), body: JSON.stringify(body), signal: ac.signal,
    });
    const data = await res.json();
    const raw = extractContent(data); // anthropic: join text; openai: choices[0].message.content
    const obj = tryParseStructured(raw, cap); // L3 用 extractJsonBlock 抽 ```json 块
    return safeParseOrFallback(action, obj, raw); // 统一 Zod 出口
  } catch (e) {
    // BLOCKER-2 修复：结构化可观测，区分错误类型
    logger.warn('[AI] LLM 调用失败', { provider: provider.type, cap, error: e.name, timedOut: e.name === 'AbortError' });
    return null; // 回到 runAI 的 mock 降级分支（与现状一致，但已可观测）
  } finally {
    clearTimeout(timer);
  }
}

// L3 抽取：先从 ```json ... ``` 抽，失败再从首个 { 到末个 } 抽
function extractJsonBlock(text) {
  if (typeof text !== 'string') return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try { return JSON.parse(candidate); } catch { return null; }
}

// 统一出口：Zod 失败不抛错，返回最小合法兜底对象（B1 根治核心）
function safeParseOrFallback(action, obj, raw) {
  const schema = SCHEMA_BY_ACTION[action] || DocResult;
  const parsed = schema.safeParse(obj || {});
  if (parsed.success) return { content: parsed.data, model: 'llm' };
  logger.warn('[AI] schema 校验失败,启用兜底对象', { action, issues: parsed.error.issues });
  return { content: minimalFallback(action, raw), model: 'fallback' };
}
```

**最小兜底对象**（保证下游不崩、流程可继续）：
- PRECHECK：`{ pass: true, questions: [], _source: 'fallback', _raw: raw }`（保守放行，不误杀需求）
- EVALUATE：`{ level: 'L3', rationality: { verdict: 'REASONABLE' }, clarify_questions: [], _source: 'fallback', _raw: raw }`
- 其余：`{ text: raw || '', _source: 'fallback' }`

---

## 4. runAI 改造点清单（ai.js）

| # | 位置 | 改造 | 作用 |
|---|---|---|---|
| R1 | `runAI` 真实路径 (225-226) | `const real = await callLLM(...)` → 改调 `callLLMStructured(sys, usr, action, activeProvider())`，接收 `{ content, model }` 对象 | 真实 LLM 返回恒为 object，根治 BLOCKER-1 |
| R2 | `runAI` mock 路径 (231-238) | mock 产物过 `SCHEMA_BY_ACTION[action].safeParse(...)`，失败走 fallback | 保证 mock 形状与真实一致（防御性） |
| R3 | `runAI` 出口 | 移除"真实返回裸 string"的可能；所有可能分支返回 `{ content: <zod-validated object>, model }` | 统一出口契约 |
| R4 | `withCodeContext` (206) | 签名加 `maxFiles` 解构并透传给 `buildCodeContext` | 修 §3.6 maxFiles 丢弃 bug（顺带，属 B1 相关契约完整性） |
| R5 | `callLLM` 超时 (新增) | 见 3.2 AbortController 15s | 修 BLOCKER-3 |
| R6 | `callLLM` 可观测 (57-60) | 结构化日志替代裸 `console.error` | 修 BLOCKER-2 |
| R7 | `ai_providers` 表 | 增 `capability` 字段（见 §6 DDL） | 支撑三级降级 L1/L2 选择 |

**改造后 runAI 骨架（伪码）：**
```js
async function runAI(action, req, extra = {}) {
  const sys = buildSystem(action, extra);
  const merged = attachCodeContext(req, extra, action);
  const usr = JSON.stringify({ requirement: req, ...merged }, null, 2);
  const provider = activeProvider();
  if (provider && provider.type !== 'mock') {
    const structured = await callLLMStructured(sys, usr, action, provider);
    if (structured) return structured; // { content: object, model: 'llm' | 'fallback' }
  }
  // mock 降级（与现状一致，但产物过 Zod）
  const mockObj = mockByAction(action, req, merged);
  const parsed = SCHEMA_BY_ACTION[action].safeParse(mockObj);
  return { content: parsed.success ? parsed.data : mockObj, model: 'mock' };
}
```

---

## 5. engine.js / 前端影响（关键：下游零改）

- **engine.js `runAiNode` (108-133)**：**无需修改**。改造后 `runAI` 返回的 `content` 恒为合法对象，`content.pass`/`content.level`/`content.rationality.verdict`/`content.questions`/`content.clarify_questions` 全部存在且类型正确，BLOCKER-1 的静默失败消失。这正是 B1 优雅之处——**改一处（ai.js 出口），下游零改**。
- **前端 `ReqDetail.tsx`（原 66-71 `JSON.parse(a.content)`）**：原代码在真实 LLM 返回 markdown 时 `JSON.parse` 抛错回退纯文本，导致 `EvaluationView` 整块不渲染。改造后 `saveArtifact` 存入的是 object（runAI 已返回 object → JSON.stringify 入 DB），前端 `JSON.parse` 恒成功，`EvaluationView` 整块渲染。原 try/catch 可保留作防御，但正常路径不再触发回退。

---

## 6. 依赖与 DDL

### 6.1 新增依赖
`server/package.json` dependencies 加：
```
"zod": "^3.23.8"
```

### 6.2 DDL（增量，幂等）
```sql
ALTER TABLE ai_providers ADD COLUMN capability TEXT DEFAULT 'prompt_only';
-- 已存在的 provider 按 type 回填：
--   UPDATE ai_providers SET capability='json_schema' WHERE type='anthropic';
--   UPDATE ai_providers SET capability='json_object' WHERE type='openai-compat' AND base_url LIKE '%deepseek%' ...（按实际 endpoint 判定，不确定的默认 prompt_only）
```

---

## 7. 验证方式

### 7.1 单元测试（必做）
1. `callLLMStructured` L1：构造 `capability='json_schema'` + mock fetch 返回合法 JSON → 断言返回 `{ content: EvaluateResult 实例, model: 'llm' }`，且 `content.level`/`content.rationality.verdict` 存在。
2. `callLLMStructured` L2：构造 `capability='json_object'` + fetch 返回 `{"level":"L2",...}` → 断言 system prompt 含 `"json"` 字面量（验证自动注入），返回 object。
3. `callLLMStructured` L3：构造 `capability='prompt_only'` + fetch 返回 markdown 包裹的 ` ```json {...} ``` ` → 断言 `extractJsonBlock` 抽出 JSON 并过 Zod。
4. **BLOCKER-1 回归（核心）**：构造 fetch 返回**裸 string**（无 JSON，模拟 LLM 失控输出）→ 断言走 fallback，`content` 仍是 object（PRECHECK fallback `{pass:true,...}` / EVALUATE fallback `{level:'L3',rationality:{verdict:'REASONABLE'},...}`），**不抛错、不返回 string**。
5. `runAI` 形状不变量：对全部 6 个 action，断言 `typeof result.content === 'object'`（mock 与真实路径一致）。

### 7.2 契约测试
6. `engine.js` 集成：用真实 `runAI`（mock provider）跑 PRECHECK → 断言 `raiseClarifies` 在 `pass=false` 时触发；EVALUATE → 断言 `touchReq` 回填 `level`、且 `verdict==='NEED_CLARIFY'` 时触发澄清闭环。

### 7.3 端到端（接真实 key，可选）
7. 配置真实 anthropic/kimi provider（`capability` 正确）→ 跑完整需求流程 → 断言 EVALUATION artifact 的 `content` 是合法对象、前端 `EvaluationView` 渲染、level 回填、澄清闭环可触发。

---

## 8. 工作量与风险

- **工作量**：~2 人日（与 tech-spec-phase1.md 估算一致）。拆分：llm-schema.js + llm-call.js ~0.75；runAI 改造 ~0.5；callLLM 超时/可观测 ~0.25；DDL+回填 ~0.25；单测+契约测试 ~0.25。
- **风险 R-B1a**：Zod `level` 枚举与 PRD §6.2 不一致 → 缓解：默认 `L1~L4`，若 PRD 用其他枚举按 §0 声明替换；fallback 用 `'L3'` 中性值。
- **风险 R-B1b**：`rationality.verdict` 真实 LLM 不输出 `NEED_CLARIFY` → 澄清闭环不触发，但这是"LLM 判断需求清晰"，非缺陷；若 PM 要求强制可澄清场景，需在 prompt 强化。
- **风险 R-B1c**：`zodToJsonSchema` 需轻量实现或引入 `zod-to-json-schema` 依赖（仅 L1 需要）；L2/L3 不需要，可延后。

---

## 9. 验收门禁（Done Definition）

- [ ] `runAI` 全部 6 个 action 在 mock/真实/降级三种路径下返回 `{ content: object, model }`，`content` 类型恒为 object
- [ ] 单测 7.1 全绿，尤其 #4 裸 string 回归
- [ ] engine.js 零改且 BLOCKER-1 静默失败场景消除（level 回填、澄清闭环可触发）
- [ ] 前端 EvaluationView 在真实 LLM 下整块渲染（不再因 JSON.parse 失败回退）
- [ ] 新增依赖 zod 进 package.json 且 lockfile 更新
- [ ] DDL 幂等执行通过，`ai_providers.capability` 回填正确
