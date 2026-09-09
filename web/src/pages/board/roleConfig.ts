import { Requirement, User } from '../../api';
import { IconName } from '../../components/Icon';

export type StatTone = 'neutral' | 'warn' | 'good';

export interface StatItem {
  key: string;
  label: string;
  icon: IconName;
  value: number;
  hint?: string;
  tone?: StatTone;
}

export interface SectionMeta {
  label: string;
  icon: IconName;
}

export interface BoardCtx {
  user: User | null;
  mine: Requirement[];
  all: Requirement[];
  viewRole?: string;
}

/** 角色中文标签 */
export const roleLabel = (r: string) => ({ CSM: '需求发起人', PO: '产品', RD: '研发', QA: '测试' } as Record<string, string>)[r] || r;

/** 按时间维度分桶（取需求创建时间）：今日 / 近7天 / 近30天 / 更早 */
export function groupByTime(list: Requirement[]): Record<string, Requirement[]> {
  const out: Record<string, Requirement[]> = { 今日: [], 近7天: [], 近30天: [], 更早: [] };
  const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  for (const r of list) {
    if (!r.created_at) { out.更早.push(r); continue; }
    const created = new Date(r.created_at.replace(' ', 'T'));
    if (Number.isNaN(created.getTime())) { out.更早.push(r); continue; }
    const createdDay = new Date(created.getFullYear(), created.getMonth(), created.getDate()).getTime();
    const diff = Math.round((today - createdDay) / 86400000);
    if (diff <= 0) out.今日.push(r);
    else if (diff < 7) out.近7天.push(r);
    else if (diff < 30) out.近30天.push(r);
    else out.更早.push(r);
  }
  return out;
}

/** 按紧急性分桶 */
export function groupByUrgency(list: Requirement[]): Record<string, Requirement[]> {
  const out: Record<string, Requirement[]> = { P0: [], P1: [], P2: [], P3: [], 未标: [] };
  for (const r of list) {
    const p = r.priority || '未标';
    if (!out[p]) out[p] = [];
    out[p].push(r);
  }
  return out;
}

/** 按业务模块分桶（关联多个模块时，需求同时出现在各模块分组下） */
export function groupByModule(list: Requirement[]): Record<string, Requirement[]> {
  const out: Record<string, Requirement[]> = { '未关联模块': [] };
  for (const r of list) {
    const names = (r.modules || []).map((m) => m.business_name || (m as any).name).filter(Boolean) as string[];
    if (names.length === 0) { out['未关联模块'].push(r); continue; }
    for (const name of names) {
      if (!out[name]) out[name] = [];
      out[name].push(r);
    }
  }
  return out;
}

export interface BoardCfg {
  greet: string;
  desc: string;
  stats: (ctx: BoardCtx) => StatItem[];
  todo: (ctx: BoardCtx) => Requirement[];
  active: (ctx: BoardCtx) => Requirement[];
  todoSection: SectionMeta;
  activeSection: SectionMeta;
  cta?: { label: string; icon: IconName; onClick: () => void };
}

const ACTIVE_STATUSES = ['SUBMITTED', 'AI_RUNNING', 'PENDING', 'CLARIFYING', 'AI_FAILED'];

const isActive = (r: Requirement) => ACTIVE_STATUSES.includes(r.status);
const isDone = (r: Requirement) => r.status === 'DONE';
const isClarifying = (r: Requirement) => r.status === 'CLARIFYING';
const isPending = (r: Requirement) => r.status === 'PENDING';
const isAiRunning = (r: Requirement) => r.status === 'AI_RUNNING';

const flowing = (list: Requirement[]): StatItem =>
  ({ key: 'flowing', label: '流转中', icon: 'in-progress', value: list.filter(isActive).length });

/**
 * 待我处理：当前节点是我的角色且为人工节点（列表接口新契约字段）。
 * 字段缺失（后端未就绪）时回退为 PENDING 兜底，保证不破；字段就绪后自动切到新规则。
 * DONE/CANCELLED 两字段为 null，`=== role / === 'HUMAN'` 不会误判。
 */
const todoAt = (role: string) => ({ mine }: BoardCtx) =>
  mine.filter((r) => {
    const hasNode = r.current_node_role !== undefined && r.current_node_type !== undefined;
    if (hasNode) return r.status === 'PENDING' && r.current_node_role === role && r.current_node_type === 'HUMAN';
    return r.status === 'PENDING';
  });

export function roleCfg(role: string, openCreate: () => void): BoardCfg {
  switch (role) {
    case 'CSM':
      return {
        greet: '需求看板',
        desc: '你提交的客户需求都在这里。AI 会自动评估定级并按 SOP 流转，进度实时可查。',
        cta: { label: '提交新需求', icon: 'plus', onClick: openCreate },
        todoSection: { label: '待你处理', icon: 'todo' },
        activeSection: { label: '进行中的需求', icon: 'active' },
        stats: ({ mine }) => [
          { key: 'submitted', label: '累计提交', icon: 'inbox', value: mine.length, hint: '全部需求' },
          { ...flowing(mine), hint: 'AI / 产品 / 研发 / 测试' },
          { key: 'clarifying', label: '待澄清', icon: 'clarify', value: mine.filter(isClarifying).length, tone: 'warn', hint: '需要你补充' },
          { key: 'shipped', label: '已上线', icon: 'shipped', value: mine.filter(isDone).length, tone: 'good', hint: '完成交付' },
        ],
        todo: todoAt('CSM'),
        active: ({ mine }) => mine.filter(isActive),
      };

    case 'PO':
      return {
        greet: '产品看板',
        desc: 'AI 已基于原始需求生成评估与 PRD 初稿，聚焦业务打磨与方案确认后流转研发。',
        todoSection: { label: '待你出 PRD', icon: 'prd' },
        activeSection: { label: '负责中的需求', icon: 'edit' },
        stats: ({ mine }) => [
          { key: 'pending', label: '待处理', icon: 'inbox', value: mine.filter(isPending).length, tone: 'warn', hint: '等待产品确认' },
          { ...flowing(mine), hint: '全流程进行' },
          { key: 'ai', label: 'AI 处理中', icon: 'ai', value: mine.filter(isAiRunning).length, hint: '自动生成产物' },
          { key: 'delivered', label: '已交付', icon: 'shipped', value: mine.filter(isDone).length, tone: 'good', hint: '完成上线' },
        ],
        todo: todoAt('PO'),
        active: ({ mine }) => mine.filter(isActive),
      };

    case 'RD':
      return {
        greet: '研发看板',
        desc: 'AI 已将 PRD 转为技术任务与实现提示词，含影响面分析，拿来即开发，完成即提测。',
        todoSection: { label: '待你开发', icon: 'todo' },
        activeSection: { label: '负责中的任务', icon: 'develop' },
        stats: ({ mine }) => [
          { key: 'pending', label: '待处理', icon: 'todo', value: mine.filter(isPending).length, tone: 'warn', hint: '等待研发排期' },
          { ...flowing(mine), hint: '全流程进行' },
          { key: 'ai', label: 'AI 处理中', icon: 'ai', value: mine.filter(isAiRunning).length, hint: '生成提示词 / 用例' },
          { key: 'shipped', label: '已上线', icon: 'shipped', value: mine.filter(isDone).length, tone: 'good', hint: '本月交付' },
        ],
        todo: todoAt('RD'),
        active: ({ mine }) => mine.filter(isActive),
      };

    case 'QA':
      return {
        greet: '测试看板',
        desc: '研发提测后任务自动到达，AI 已生成测试用例，聚焦执行、回归与质量把关。',
        todoSection: { label: '待你测试', icon: 'test' },
        activeSection: { label: '负责中的任务', icon: 'retest' },
        stats: ({ mine }) => [
          { key: 'pending', label: '待测试', icon: 'test', value: mine.filter(isPending).length, tone: 'warn', hint: '等待测试执行' },
          { ...flowing(mine), hint: '全流程进行' },
          { key: 'clarifying', label: '待澄清', icon: 'clarify', value: mine.filter(isClarifying).length, hint: '需求待补充' },
          { key: 'passed', label: '已通过', icon: 'shipped', value: mine.filter(isDone).length, tone: 'good', hint: '本月完成' },
        ],
        todo: todoAt('QA'),
        active: ({ mine }) => mine.filter(isActive),
      };

    default: // ADMIN 看全量
      return {
        greet: '全局看板',
        desc: '平台全部需求的流转总览，可下钻任意需求查看 SOP 进度与产物。',
        todoSection: { label: '待办', icon: 'todo' },
        activeSection: { label: '进行中', icon: 'active' },
        stats: ({ all }) => [
          { key: 'total', label: '需求总量', icon: 'total', value: all.length, hint: '平台全部' },
          { ...flowing(all), hint: '进行中' },
          { key: 'clarifying', label: '待澄清', icon: 'clarify', value: all.filter(isClarifying).length, hint: '等待补充信息' },
          { key: 'done', label: '已完成', icon: 'shipped', value: all.filter(isDone).length, tone: 'good', hint: '累计交付' },
        ],
        // 管理员无节点处理职责，无个人待办；看板左侧展示空态「暂无待办」
        todo: () => [],
        active: ({ all }) => all.filter(isActive),
      };
  }
}
