import React from 'react';
import { Requirement, STATUS_NAME } from '../../api';
import { Icon } from '../../components/Icon';
import { FlowSteps } from './FlowSteps';
import { openCount } from './nodeState';

/** 改动等级徽标 L1–L4 */
export function LevelBadge({ level }: { level?: string }) {
  if (!level) return <span className="lv lv-none">—</span>;
  const cls = ({ L1: 'lv-1', L2: 'lv-2', L3: 'lv-3', L4: 'lv-4' } as Record<string, string>)[level] || 'lv-2';
  return <span className={`lv ${cls}`}>{level}</span>;
}

interface ReqCardProps {
  r: Requirement;
  nodeName?: string;
  nodes?: Requirement['nodes'];
  onOpen: (id: number) => void;
  accent?: boolean;
}

export function ReqCard({ r, nodeName, nodes, onOpen, accent }: ReqCardProps) {
  const [statusText, statusTone] = STATUS_NAME[r.status] || [r.status, 'grey'];
  const pendingClarifies = openCount(r);
  const owners = [
    r.po_name && `产:${r.po_name}`,
    r.rd_name && `后:${r.rd_name}`,
    r.fe_name && `前:${r.fe_name}`,
    r.qa_name && `测:${r.qa_name}`,
  ].filter(Boolean).join(' ');

  return (
    <div className={`req-card card hover ${accent ? 'accent' : ''}`} onClick={() => onOpen(r.id)}>
      <div className="rc-top">
        <LevelBadge level={r.level} />
        <div className="rc-main">
          <div className="rc-title">{r.title}</div>
          <div className="rc-sub">
            <span className="rc-no">{r.req_no}</span>
            {r.customer_name && (
              <span className="rc-inline">
                <Icon name="customer" size={16} />
                {r.customer_name}
              </span>
            )}
          </div>
        </div>
        <span className={`tag tag-${statusTone}`}>{statusText}</span>
      </div>

      <FlowSteps nodes={nodes} />

      <div className="rc-foot">
        {!nodes?.length && nodeName && (
          <span className="rc-node rc-inline">
            <Icon name="next" size={16} />
            {nodeName}
          </span>
        )}
        {pendingClarifies > 0 && <span className="tag tag-orange">待补充 {pendingClarifies}</span>}
        <span className="rc-who">{owners}</span>
        <span className="muted nowrap" style={{ marginLeft: 'auto' }}>{r.updated_at?.slice(5, 16)}</span>
      </div>
    </div>
  );
}
