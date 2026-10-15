-- AI 澄清轮次：同一节点最多澄清 3 轮，每轮最多 3 个问题（限制在 engine.raiseClarifies 中强制执行）。
-- 历史数据没有轮次概念，统一回填为第 1 轮。
ALTER TABLE clarifies ADD COLUMN round_no INT NOT NULL DEFAULT 1;
