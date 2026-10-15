-- 自定义/历史副本模板若已有 AI 评审但缺少 PRD 生成节点，补齐产品可编辑的 AI PRD 草稿。
-- 使用临时序号整体平移，避免与现有 seq=3 节点冲突；迁移可重复执行且只处理缺失模板。
UPDATE requirements r
JOIN sop_nodes e ON e.template_id = r.template_id AND e.ai_action = 'EVALUATE'
LEFT JOIN sop_nodes p ON p.template_id = r.template_id AND p.ai_action = 'PRD_GEN'
SET r.current_seq = r.current_seq + 1
WHERE p.id IS NULL
  AND r.current_seq >= 3
  AND r.status NOT IN ('DONE', 'CANCELLED');

UPDATE sop_nodes n
LEFT JOIN sop_nodes p ON p.template_id = n.template_id AND p.ai_action = 'PRD_GEN'
JOIN sop_nodes e ON e.template_id = n.template_id AND e.ai_action = 'EVALUATE'
SET n.seq = n.seq + 1000
WHERE p.id IS NULL AND n.seq >= 3;

UPDATE sop_nodes n
LEFT JOIN sop_nodes p ON p.template_id = n.template_id AND p.ai_action = 'PRD_GEN'
JOIN sop_nodes e ON e.template_id = n.template_id AND e.ai_action = 'EVALUATE'
SET n.seq = n.seq - 999
WHERE p.id IS NULL AND n.seq >= 1003;

INSERT INTO sop_nodes(template_id, seq, node_type, name, role, ai_action, ai_prompt)
SELECT e.template_id, 3, 'AI', 'AI·PRD 生成', NULL, 'PRD_GEN',
  '你是产品经理。请站在产品视角，根据原始需求与 AI 评估结果生成可直接复制到飞书的 PRD。必须包含：背景与目标、用户/使用场景、功能范围与非目标、详细流程、交互与页面、数据与接口要求、验收标准、异常与边界、发布与风险。使用清晰的 Markdown 标题、列表和表格，不要输出 JSON、代码围栏或解释性前言。'
FROM sop_nodes e
LEFT JOIN sop_nodes p ON p.template_id = e.template_id AND p.ai_action = 'PRD_GEN'
WHERE e.ai_action = 'EVALUATE' AND p.id IS NULL
GROUP BY e.template_id;
