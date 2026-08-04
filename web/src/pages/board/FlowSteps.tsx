import React from 'react';
import { SopNode } from '../../api';
import { Icon, IconName } from '../../components/Icon';

/** 角色 → 语义图标。AI 节点走材质与 Cpu 图标，不用颜色区分（DIRECTION §5） */
const ROLE_ICON: Record<string, IconName> = {
  CSM: 'role-csm',
  PO: 'role-po',
  RD: 'role-rd',
  QA: 'role-qa',
};

export function nodeIconName(n: Pick<SopNode, 'node_type' | 'role'>): IconName {
  if (n.node_type === 'AI') return 'ai';
  return (n.role && ROLE_ICON[n.role]) || 'role-other';
}

type StepState = 'done' | 'current' | 'pending';

/**
 * 状态文案。状态本身由 .flow-st 的 CSS 状态点 + .flow-ic 的边框材质表达，
 * 不在 10px 级的说明文字旁塞 16px 图标（图标尺寸锁定 16/20/24，与该字号不匹配）。
 */
const STEP_TEXT: Record<StepState, string> = {
  done: '已完成',
  current: '进行中',
  pending: '待开始',
};

/** 需求流转条：完成 / 进行中 / 未到达三态，AI 与人工靠图标 + 材质区分 */
export function FlowSteps({ nodes }: { nodes?: SopNode[] }) {
  if (!nodes || nodes.length === 0) return null;
  return (
    <div className="flow">
      {nodes.map((n, i) => {
        const state = (n.state || 'pending') as StepState;
        const isAI = n.node_type === 'AI';
        return (
          <div className={`flow-step ${state} ${isAI ? 'is-ai' : 'is-human'}`} key={n.id || i}>
            <div className="flow-ic">
              <Icon name={nodeIconName(n)} size={16} />
            </div>
            <div className="flow-name">{n.name}</div>
            <div className="flow-sub">{isAI ? '智能引擎' : (n.role || '')}</div>
            <div className={`flow-st ${state}`}>{STEP_TEXT[state] || STEP_TEXT.pending}</div>
          </div>
        );
      })}
    </div>
  );
}
