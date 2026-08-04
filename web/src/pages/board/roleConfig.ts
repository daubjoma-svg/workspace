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

const ACTIVE_STATUSES = ['SUBMITTED', 'AI_RUNNING', 'PENDING', 'CLARIFYING'];

const isActive = (r: Requirement) => ACTIVE_STATUSES.includes(r.status);
const isDone = (r: Requirement) => r.status === 'DONE';
const isClarifying = (r: Requirement) => r.status === 'CLARIFYING';
const isPending = (r: Requirement) => r.status === 'PENDING';
const isAiRunning = (r: Requirement) => r.status === 'AI_RUNNING';

const flowing = (list: Requirement[]): StatItem =>
  ({ key: 'flowing', label: '流转中', icon: 'in-progress', value: list.filter(isActive).length });

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
        todo: ({ mine }) => mine.filter((r) => isClarifying(r) || (isPending(r) && r.current_seq >= 8)),
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
        todo: ({ mine }) => mine.filter(isPending),
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
        todo: ({ mine }) => mine.filter(isPending),
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
        todo: ({ mine }) => mine.filter(isPending),
        active: ({ mine }) => mine.filter(isActive),
      };

    default: // ADMIN 看全量
      return {
        greet: '全局看板',
        desc: '平台全部需求的流转总览，可下钻任意需求查看 SOP 进度与产物。',
        todoSection: { label: '待澄清', icon: 'clarify' },
        activeSection: { label: '进行中', icon: 'active' },
        stats: ({ all }) => [
          { key: 'total', label: '需求总量', icon: 'total', value: all.length, hint: '平台全部' },
          { ...flowing(all), hint: '进行中' },
          { key: 'clarifying', label: '待澄清', icon: 'clarify', value: all.filter(isClarifying).length, tone: 'warn', hint: '需补充' },
          { key: 'done', label: '已完成', icon: 'shipped', value: all.filter(isDone).length, tone: 'good', hint: '累计交付' },
        ],
        todo: ({ all }) => all.filter(isClarifying),
        active: ({ all }) => all.filter(isActive),
      };
  }
}
