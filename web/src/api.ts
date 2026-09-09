// 简单 API 客户端
const TOKEN_KEY = 'sop_token';

export function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
export function setToken(t: string) { localStorage.setItem(TOKEN_KEY, t); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); }

async function request(path: string, opts: RequestInit = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      'x-token': getToken(),
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败(${res.status})`);
  return data;
}

export const api = {
  get: (p: string) => request(p),
  post: (p: string, body?: any) => request(p, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: (p: string, body?: any) => request(p, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  del: (p: string) => request(p, { method: 'DELETE' }),
};

/* ==================== 通知中心（契约：GET /notifications 返回数组） ==================== */
export interface AppNotification {
  id: number;
  title: string;
  content: string;
  requirement_id?: number | null;
  /** 0 = 未读，1 = 已读 */
  read_flag: number | boolean;
  created_at: string;
}
export const getNotifications = (): Promise<AppNotification[]> => api.get('/api/notifications');
export const readAllNotifications = (): Promise<{ ok: boolean }> => api.post('/api/notifications/read-all');

/* ==================== 需求编辑（契约：PUT /requirements/:id） ==================== */
export interface UpdateRequirementBody {
  title?: string;
  description?: string;
  customer_name?: string;
  priority?: string;
  /** 目标版本，如 '26M8V1'（26年8月V1版）；契约 v2：替代 expect_date */
  target_version?: string;
  /** Jira 单链接，如 https://jira.xxx/browse/PINGTAI-11880；空串/null 表示清空 */
  jira_url?: string | null;
  po_id?: number | null;
  module_ids?: number[];
}
export const updateRequirement = (id: number, body: UpdateRequirementBody): Promise<{ ok: boolean }> =>
  api.put(`/api/requirements/${id}`, body);

/* ==================== 产品指派（契约：POST /requirements/:id/assign） ==================== */
export interface AssignRequirementBody {
  rd_id?: number | null;
  qa_id?: number | null;
  jira_url?: string | null;
}
export const assignRequirement = (id: number, body: AssignRequirementBody): Promise<any> =>
  api.post(`/api/requirements/${id}/assign`, body).then((r: any) => (r && r.data ? r.data : r));

/* ==================== 需求聊天工作室（契约 v2：GET/POST /requirements/:id/messages + 回复/澄清应答） ==================== */
export interface ReqMessage {
  id: number;
  /** 提问人/发送人名称（AI 发起的澄清为系统/AI 名） */
  asked_by: string;
  /** 消息/问题文本（契约字段名 question 承载文本内容） */
  question: string;
  /** 回答（已回复时存在） */
  answer?: string;
  /** 'OPEN' | 'ANSWERED' | 'FORCED'（CLARIFY）/ 'CHAT'（初始未回复的聊天消息） */
  status: string;
  /** 'CHAT'=聊天消息 / 'CLARIFY'=AI 澄清（后端 clarifies 表复用，kind 大写） */
  kind: string;
  created_at: string;
  answered_at?: string;
}
/** 新端点统一 Envelope：{ code, data, message }，这里解包 data */
export const getReqMessages = (id: number): Promise<ReqMessage[]> =>
  api.get(`/api/requirements/${id}/messages`).then((r: any) => (r && Array.isArray(r.data) ? r.data : []));
export const postReqMessage = (id: number, text: string): Promise<any> =>
  api.post(`/api/requirements/${id}/messages`, { text });
/** 回复一条聊天消息（CHAT kind，任意参与人） */
export const answerChatMessage = (reqId: number, msgId: number, answer: string): Promise<any> =>
  api.post(`/api/requirements/${reqId}/messages/${msgId}/answer`, { answer });
/** 回答 AI 澄清（CLARIFY kind，提单人 CSM + ADMIN） */
export const answerClarify = (cid: number, answer: string): Promise<{ ok: boolean }> =>
  api.post(`/api/clarifies/${cid}/answer`, { answer });

export interface User { id: number; username: string; name: string; role: 'CSM' | 'PO' | 'RD' | 'QA' | 'ADMIN'; feishu_key?: string | null; }
export interface SopNode {
  id: number; template_id: number; seq: number; node_type: 'HUMAN' | 'AI';
  name: string; role?: string; ai_action?: string; ai_prompt?: string;
  state?: 'done' | 'current' | 'pending';
}
export interface Requirement {
  id: number; req_no: string; title: string; description: string; customer_name: string;
  priority: string; expect_date?: string; target_version?: string; level?: string; status: string; current_seq: number;
  /** 当前节点负责人角色（列表接口新契约；DONE/CANCELLED 为 null，前端按 === 判定不会误判） */
  current_node_role?: 'CSM' | 'PO' | 'RD' | 'QA' | null;
  /** 当前节点类型（列表接口新契约；DONE/CANCELLED 为 null） */
  current_node_type?: 'HUMAN' | 'AI' | null;
  csm_id: number; po_id?: number; rd_id?: number; qa_id?: number; template_id: number;
  module_ids?: string;
  /** Jira 单链接（如 https://jira.xxx/browse/PINGTAI-11880）；未关联时为 null/空 */
  jira_url?: string | null;
  csm_name?: string; po_name?: string; rd_name?: string; qa_name?: string;
  created_at: string; updated_at: string;
  nodes?: SopNode[];
  nodes_view?: SopNode[];
  /** 详情接口返回 Clarify[]；列表接口返回 number(待澄清数) */
  open_clarifies?: any;
  modules?: ReqModule[];
}
export interface Clarify { id: number; question: string; answer?: string; status: string; asked_by: string; }
export interface Artifact { id: number; kind: string; version: number; content: string; created_by: string; created_at: string; meta?: string; }
export interface TimelineItem { id: number; action: string; operator: string; detail?: string; created_at: string; }

export interface CodeModule {
  id: number;
  gitlab_project_id: string; gitlab_project_path?: string;
  branch: string; sub_path: string;
  sync_status: 'IDLE' | 'SYNCING' | 'OK' | 'FAILED';
  last_synced_at?: string; commit_sha?: string; file_count?: number; error_msg?: string;
}
/** 业务模块（v0.7 替代 ModuleMapping）：CSM 提单时按业务模块关联，一业务可挂多个代码仓库 */
export interface BusinessModule {
  id: number; name: string; description?: string;
  codes: Array<{
    code_module_id: number; gitlab_project_id: string; gitlab_project_path?: string;
    branch: string; sync_status: string; file_count?: number; path_prefix: string;
  }>;
}
/** 公开端点（CSM 提单时拉取）：只含 name/description，不暴露 codes */
export interface PublicBusinessModule { id: number; name: string; description?: string; }
/** v0.7 业务模块挂载视图（业务模块 × 挂载仓库 的笛卡尔积，每行可独立判断 sync） */
export interface ReqModule {
  business_module_id: number;
  business_name: string;
  business_description?: string;
  code_module_id: number | null;
  path_prefix?: string;
  gitlab_project_id?: string;
  gitlab_project_path?: string;
  branch?: string;
  sync_status?: string;
  file_count?: number;
}

export const ROLE_NAME: Record<string, string> = { CSM: '需求发起人', PO: '产品', RD: '研发', QA: '测试', ADMIN: '管理员' };
export const STATUS_NAME: Record<string, [string, string]> = {
  DRAFT: ['草稿', 'grey'], SUBMITTED: ['已提交', 'blue'], AI_RUNNING: ['AI 处理中', 'blue'],
  CLARIFYING: ['待澄清', 'orange'], PENDING: ['待处理', 'blue'], AI_FAILED: ['AI 执行失败', 'red'],
  DONE: ['已完成', 'green'], CANCELLED: ['已取消', 'grey'],
};
export const AI_ACTIONS: Record<string, string> = {
  PRECHECK: '完整性预检', EVALUATE: '需求评估', PRD_GEN: 'PRD 生成',
  DEV_PROMPT: '研发提示词', TEST_CASE: '测试用例', CUSTOM: '自定义',
};
