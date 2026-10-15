-- 产品级 Jira 创建默认值：键为 Jira fieldId，值为创建接口的原始字段值。
ALTER TABLE users ADD COLUMN jira_field_defaults JSON NULL AFTER jira_field_mapping;
