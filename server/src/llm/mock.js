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
  // 标题含 NEEDS_INFO 时返回阻断性问题，便于端到端验证「评估节点挂起等需求发起人补充」。
  const needsInfo = /NEEDS_INFO|补充信息/i.test(req.title);
  const questions = needsInfo
    ? ['该需求的目标使用对象是谁（哪些角色/部门）？', '验收标准是什么（达到什么效果算完成）？']
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
    summary: `该需求聚焦「${req.title || '当前问题'}」，${attention ? '需要先确认关键范围后再安排。' : '目标明确，可按常规迭代安排。'}`,
    scheduling: {
      status: attention ? 'NEEDS_CONFIRMATION' : 'READY',
      advice: attention ? '建议先确认关注事项，再进入排期。' : '可按当前优先级进入常规排期。',
    },
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
    questions,
    // 自评置信度：有阻断性问题时必然偏低（否则会被 engine 的 ≥0.8 门控直接放行）。
    confidence: needsInfo ? 0.35 : (hasCtx ? 0.8 : 0.65),
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

## 1. 背景
- 客户：${req.customer_name || '—'}
- 当前问题：${req.description}

## 2. 目标
- 解决上述问题，形成可验证的业务结果。

## 3. 业务流程
1. 用户进入相关业务入口。
2. 按需求配置或提交信息。
3. 系统完成处理并反馈结果。

## 4. 影响范围与风险
- 影响范围：需求涉及的业务模块及相关使用角色。
- 风险：需求边界或存量数据影响需产品确认。

## 5. 验收标准
- [ ] 主流程按需求描述完成。
- [ ] 异常输入有明确提示且不产生错误数据。
- [ ] 既有相关功能回归通过。

## 6. 排期版本
- 目标版本：${req.target_version || '待定'}
- 预估工作量：${effort}
- 前置条件：产品确认范围与验收口径。
`;
}

function mockDevPrompt(req, prd, codeCtx) {
  const moduleSection = codeCtx?.modules?.length
    ? codeCtx.modules.map((m) => `- ${m.platform}（${m.module_key}@${m.branch || 'main'}）`).join('\n')
    : '';
  return `# 研发 AI 执行提示词 — ${req.title}

## 一、任务目标
请解决「${req.title}」的问题，并在不改变既有业务语义的前提下完成可验证的优化。

## 二、问题判断与查证结论
- 当前为兜底提示词，尚未完成代码查证；请先确认是否存在全量加载、全量展示或保存后全量刷新。
- 请确认现有列表接口是否已经支持分页、搜索和成员选中回显，再决定是否新增能力。

## 三、推荐方案
- 若服务端无分页：新增分页查询，前端按页加载并在搜索条件变化时重置页码。
- 若服务端已有分页：优先复用，不新增重复接口。
- 保存成功后仅更新本次变更的成员状态，避免重新加载全部成员。

## 四、前端改动点与影响
- 根据查证结果修改实际成员选择页面、列表状态与请求调用；处理搜索、翻页/滚动、跨页勾选和已有成员回显。

## 五、后端改动点与影响
- 仅在现有能力无法覆盖时调整成员列表查询与返回；保持旧调用方、权限和保存语义兼容。

## 六、跨业务影响与兼容性
- 检查同一成员选择或组织树能力的复用入口；${moduleSection || '未获得代码快照，需补充确认。'}

## 七、实施步骤与验收
1. 查证并记录根因。
2. 按推荐方案实现最小改动。
3. 验收大数据量、搜索、翻页/滚动、跨页勾选、保存、已有成员回显及复用场景回归。

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
