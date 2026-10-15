-- 兼容已初始化的标准模板：在 AI 评审后补入 AI PRD 节点，并顺延后续节点。
SET @prd_tpl=(SELECT id FROM sop_templates WHERE is_system=1 ORDER BY id LIMIT 1);
SET @has_prd=(SELECT COUNT(*) FROM sop_nodes WHERE template_id=@prd_tpl AND name='AI·PRD 生成');
UPDATE requirements
SET current_seq=current_seq+1
WHERE template_id=@prd_tpl
  AND current_seq>=3
  AND status NOT IN ('DONE','CANCELLED')
  AND @has_prd=0;

UPDATE sop_nodes
SET seq=seq+1000
WHERE template_id=@prd_tpl
  AND seq>=3
  AND @has_prd=0;

UPDATE sop_nodes
SET seq=seq-999
WHERE template_id=@prd_tpl
  AND seq>=1003
  AND @has_prd=0;

INSERT INTO sop_nodes(template_id,seq,node_type,name,role,ai_action,ai_prompt)
SELECT t.id, 3, 'AI', 'AI·PRD 生成', NULL, 'PRD_GEN',
  '你是产品经理。请站在产品视角，根据原始需求与 AI 评估结果生成可直接复制到飞书的 PRD。必须包含：背景与目标、用户/使用场景、功能范围与非目标、详细流程、交互与页面、数据与接口要求、验收标准、异常与边界、发布与风险。使用清晰的 Markdown 标题、列表和表格，不要输出 JSON、代码围栏或解释性前言。'
FROM sop_templates t
WHERE t.id=@prd_tpl AND @has_prd=0;
