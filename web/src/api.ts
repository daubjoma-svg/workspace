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

export interface User { id: number; username: string; name: string; role: 'CSM' | 'PO' | 'RD' | 'QA' | 'ADMIN'; }
export interface SopNode {
  id: number; template_id: number; seq: number; node_type: 'HUMAN' | 'AI';
  name: string; role?: string; ai_action?: string; ai_prompt?: string;
  state?: 'done' | 'current' | 'pending';
}
export interface Requirement {
  id: number; req_no: string; title: string; description: string; customer_name: string;
  priority: string; expect_date?: string; level?: string; status: string; current_seq: number;
  csm_id: number; po_id?: number; rd_id?: number; qa_id?: number; template_id: number;
  module_ids?: string;
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
  id: number; module_key: string; name: string; description?: string;
  gitlab_project_id?: string; gitlab_project_path?: string; branch: string; sub_path?: string;
  sync_status: 'IDLE' | 'SYNCING' | 'OK' | 'FAILED';
  last_synced_at?: string; commit_sha?: string; file_count?: number; error_msg?: string;
}
export interface ModuleMapping {
  id: number; platform_name: string; platform_key: string; code_module_id: number; path_prefix?: string;
  code_module_name?: string; module_key?: string; sync_status?: string; last_synced_at?: string;
}
export interface PlatformModule {
  id: number; platform_name: string; platform_key: string; path_prefix?: string;
  code_module_name?: string; module_key?: string; sync_status?: string;
}
export interface ReqModule {
  id: number; platform_name: string; platform_key: string;
  code_module_name?: string; module_key?: string; sync_status?: string; last_synced_at?: string;
}

export const ROLE_NAME: Record<string, string> = { CSM: 'CSM', PO: '产品', RD: '研发', QA: '测试', ADMIN: '管理员' };
export const STATUS_NAME: Record<string, [string, string]> = {
  DRAFT: ['草稿', 'grey'], SUBMITTED: ['已提交', 'blue'], AI_RUNNING: ['AI 处理中', 'blue'],
  CLARIFYING: ['待澄清', 'orange'], PENDING: ['待处理', 'blue'],
  DONE: ['已完成', 'green'], CANCELLED: ['已取消', 'grey'],
};
export const AI_ACTIONS: Record<string, string> = {
  PRECHECK: '完整性预检', EVALUATE: '需求评估', PRD_GEN: 'PRD 生成',
  DEV_PROMPT: '研发提示词', TEST_CASE: '测试用例', CUSTOM: '自定义',
};
