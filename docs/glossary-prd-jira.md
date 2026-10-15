# PRD/Jira 术语

| 术语 | 含义 |
| --- | --- |
| PRD Artifact | 需求产物中 `kind=PRD` 的版本化文档，AI 生成、产品编辑后仍按版本保存。 |
| Jira Profile | 产品账号自己的 Jira 连接配置，包括地址、认证、项目默认值和字段映射。 |
| 字段映射 | JSON 对象，将 `customer_name`、`product_manager`、`rd`、`participants`、`reporter`、`qa` 映射到 Jira 的 `customfield_xxxxx`。 |
| 参与人员 | 当前需求的研发、前端和测试负责人集合，去重后组成 Jira 参与人元数据。 |
| Jira 回写 | Jira 创建成功后把可访问链接写回 `requirements.jira_url`。 |
