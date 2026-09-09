// 内置 Mock 生成器（离线演示 / 真实 LLM 不可用时的降级产物）。
// 形状必须与 llm-schema.js 定义的各 action 出口形状一致，否则降级路径会被 Zod 兜底二次改写。

'use strict';

function mockPrecheck(req) {
  const desc = req.description || '';
  const issues = [];
  if (desc.length < 30) issues.push('需求描述过于简略，建议补充：业务场景、目标用户、期望效果。');
  if (!/期望|希望|需要|目标/.test(desc)) issues.push('缺少明确的期望结果描述（希望系统如何表现）。');
  if (!/边界|异常|限制|范围/.test(desc)) issues.push('未说明边界条件或限制范围（如并发、数据量、异常场景）。');
  const questions = [];
  if (!/客户|用户/.test(desc)) questions.push('该需求的目标使用方是谁？（客户/内部运营/全部用户）');
  if (issues.length) questions.push('请补充期望的验收标准：怎样算这个需求"做完了"？');
  return {
    pass: issues.length === 0,
    issues,
    questions,
    summary: issues.length === 0
      ? '需求描述完整，包含场景、期望与边界，可以进入评估。'
      : `发现 ${issues.length} 处完整性问题，建议补充后再评估。`,
  };
}

function mockEvaluate(req, codeCtx) {
  const desc = `${req.title}\n${req.description}`;
  const words = desc.length;
  const level = words < 80 ? 'L1' : words < 200 ? 'L2' : words < 400 ? 'L3' : 'L4';
  const effortMap = { L1: [0.5, 1], L2: [1, 3], L3: [3, 8], L4: [8, 20] };
  const [mn, mx] = effortMap[level];
  const hasCtx = !!codeCtx?.modules?.length;
  // P0 改造：mock 只产出 FEASIBLE / NEEDS_ATTENTION。标题含 NEEDS_ATTENTION 时走「有风险但继续走」分支，
  // 便于端到端验证 NEEDS_ATTENTION 不阻塞流程（真实模型不受此 hook 影响）。
  const attention = /NEEDS_ATTENTION/i.test(req.title);
  const verdict = attention ? 'NEEDS_ATTENTION' : 'FEASIBLE';
  const attention_points = attention
    ? ['需求边界仍需产品在评审时与 CSM 对齐', '涉及既有数据兼容，需评估历史数据处理', '建议在 PRD 中明确异常场景与验收口径']
    : [];
  const impact_scope = hasCtx
    ? codeCtx.modules.map((m) => ({
      module: `${m.platform} (${m.module_key}@${m.branch || 'main'})`,
      files: ['(基于目录结构推断,详见 code_context)'],
      apis: [`/api/${m.module_key}/*`],
      tables: [], confidence: 0.75,
    }))
    : [
      { module: '服务端-业务接口层', files: ['server/src/routes/*'], apis: ['/api/v1/*'], tables: [], confidence: 0.7 },
      { module: '前端-页面展示', files: ['web/src/pages/*'], apis: [], tables: [], confidence: 0.6 },
    ];
  return {
    rationality: {
      verdict,
      reason: hasCtx
        ? `已结合 ${codeCtx.modules.length} 个平台模块的代码快照做可行性分析:需求目标明确,与现有代码能力不冲突,可在既有模块上扩展实现。`
        : '需求目标明确,与现有系统能力不冲突,可按常规迭代实现。',
      existing_capability: hasCtx
        ? `关联模块 ${codeCtx.modules.map((m) => m.platform).join('、')} 已有相近实现,建议在其上扩展而非新建。`
        : '当前系统已有相近模块可复用,建议在其上扩展而非新建。',
    },
    attention_points,
    perspectives: {
      customer: `客户核心诉求:${req.title}。需关注交付后的可感知效果与验收口径。`,
      product: '建议在 PRD 中明确主流程、异常流程与边界 case,并与现有功能保持一致性。',
      engineering: hasCtx
        ? `实现路径清晰,主要涉及 ${codeCtx.modules.map((m) => m.module_key).join('/')} 模块的接口与业务层,注意兼容历史数据。`
        : '实现路径清晰,主要涉及后端接口与前端展示两层,注意兼容历史数据。',
    },
    impact_scope,
    level,
    effort: {
      min_days: mn, max_days: mx, confidence: hasCtx ? 0.7 : 0.6,
      basis: hasCtx ? '基于关联模块真实代码结构的可行性估算(mock)。' : '基于需求文本规模的粗估(mock),接入代码索引后将基于真实影响面计算。',
    },
    risks: ['需求边界未完全明确,存在范围蔓延风险', '如涉及第三方依赖需提前确认排期'],
    suggested_test_focus: ['主流程功能正确性', '边界与异常输入', '与现有功能的回归'],
  };
}

function mockPRD(req, evaluation) {
  const effort = evaluation?.effort ? `${evaluation.effort.min_days}-${evaluation.effort.max_days} 人日` : '待定';
  return `# ${req.title} — 产品需求文档

## 1. 背景与目标
- 客户：${req.customer_name || '—'}
- 原始诉求：${req.description}

## 2. 用户故事与场景
- 作为 **用户**，我希望 **${req.title}**，从而 **提升业务效率**。

## 3. 功能详述
| # | 功能点 | 说明 | 边界 case |
|---|--------|------|-----------|
| 1 | 主流程 | 按需求描述实现主链路 | 空数据/重复提交 |
| 2 | 异常处理 | 非法输入给出明确提示 | 并发、超时 |

## 4. 交互说明
- 入口：现有菜单下新增入口。
- 反馈：操作成功/失败均有明确提示。

## 5. 非功能要求
- 性能：常规接口 < 1s。
- 兼容：不影响既有数据。

## 6. 验收标准（AC）
- [ ] 主流程按需求描述跑通。
- [ ] 边界与异常场景处理正确。
- [ ] 不引入回归问题。

## 7. Out of Scope
- 本期不包含与第三方系统的深度集成。

---
> 改动等级：${evaluation?.level || '待定'}；预估工作量：${effort}（AI 初稿，供产品修改）
`;
}

function mockDevPrompt(req, prd, codeCtx) {
  const moduleSection = codeCtx?.modules?.length
    ? `\n## 关联代码模块(真实快照)\n${codeCtx.modules.map((m) => `- **${m.platform}** (\`${m.module_key}\` @ ${m.branch || 'main'}, commit ${m.commit || '—'}):\n  - 建议改动集中在该模块的接口层与业务层\n  - 可复用现有 Controller/Service,避免新建`).join('\n')}\n`
    : '';
  return `# 研发实现指引 — ${req.title}

## 目标
${req.description}
${moduleSection}
## 实现步骤拆解
1. **接口层**:新增/修改对应 REST 接口,完成参数校验。
2. **业务层**:实现核心业务逻辑,注意事务边界。
3. **数据层**:如需表结构变更,先出 DDL 评审。
4. **前端**:按 PRD 实现页面与交互。

## 关键逻辑思路
- 主流程:接收请求 → 校验 → 处理 → 返回。
- 异常:统一错误码 + 友好提示。

## 兼容/性能/安全
- 兼容:老数据需可正常读写。
- 性能:避免 N+1 查询。
- 安全:鉴权 + 参数校验防注入。

## 建议测试关注点
- 正常流、边界流、异常流各至少 1 例。

> 可直接喂给 Cursor / Claude Code / Codex 作为实现上下文(mock 初稿${codeCtx?.modules?.length ? ',已含真实模块上下文' : ''})。
`;
}

function mockTestCase() {
  return [
    { id: 1, type: '正常流', title: '主流程按预期工作', steps: '按 PRD 主流程操作', expect: '各步骤结果符合 AC', result: '' },
    { id: 2, type: '边界流', title: '空数据/极值输入', steps: '输入空值/最大值/最小值', expect: '系统正确处理并提示', result: '' },
    { id: 3, type: '异常流', title: '非法输入与并发', steps: '构造非法参数/重复提交', expect: '返回明确错误，不产生脏数据', result: '' },
  ];
}

/** CUSTOM 节点：出口形状为 markdown 文本（与 PRD/DevPrompt 一致），前端按 markdown 渲染 */
function mockCustom(req, sceneLabel) {
  return `# ${sceneLabel}

- 需求：${req.title}
- 说明：当前未接入真实模型，本段为内置 Mock 产物，不可作为排期依据。
`;
}

module.exports = { mockPrecheck, mockEvaluate, mockPRD, mockDevPrompt, mockTestCase, mockCustom };
