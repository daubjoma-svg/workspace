-- 产品账号的 Jira 连接与字段映射配置；token 仅保存密文，接口不会返回明文。
ALTER TABLE users ADD COLUMN jira_base_url VARCHAR(1024) NULL AFTER feishu_key;
ALTER TABLE users ADD COLUMN jira_username VARCHAR(256) NULL AFTER jira_base_url;
ALTER TABLE users ADD COLUMN jira_api_token_enc TEXT NULL AFTER jira_username;
ALTER TABLE users ADD COLUMN jira_project_key VARCHAR(128) NULL AFTER jira_api_token_enc;
ALTER TABLE users ADD COLUMN jira_issue_type VARCHAR(128) NULL AFTER jira_project_key;
ALTER TABLE users ADD COLUMN jira_field_mapping JSON NULL AFTER jira_issue_type;
