import React from 'react';
import { Requirement, STATUS_NAME } from '../../api';
import { Icon } from '../../components/Icon';
import { openCount } from './nodeState';

interface ReqCardCompactProps {
  r: Requirement;
  /** 当前节点名（来自详情快照） */
  nodeName?: string;
  /** 总节点数（来自详情快照），用于进度比例 */
  totalNodes?: number;
  onOpen: (id: number) => void;
}

/** todo 精简卡片：标题/客户/状态/当前节点名 + 进度比例条，不渲染 FlowSteps（看板紧凑化） */
export function ReqCardCompact({ r, nodeName, totalNodes, onOpen }: ReqCardCompactProps) {
  const [statusText, statusTone] = STATUS_NAME[r.status] || [r.status, 'grey'];
  const pendingClarifies = openCount(r);
  const total = totalNodes || 0;
  const ratio = total > 0 ? Math.max(0, Math.min(100, Math.round((r.current_seq / total) * 100))) : 0;

  return (
    <div className="req-card req-card-compact card hover accent" onClick={() => onOpen(r.id)}>
      <div className="rc-top">
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

      <div className="rc-compact-meta">
        <span className="rc-node rc-inline">
          <Icon name="next" size={16} />
          {nodeName || '—'}
        </span>
        {pendingClarifies > 0 && <span className="tag tag-orange">待补充 {pendingClarifies}</span>}
      </div>

      <div className="rc-progress">
        <div className="rc-progress-track">
          <div className="rc-progress-bar" style={{ width: `${ratio}%` }} />
        </div>
        <span className="rc-progress-text">{total > 0 ? `${r.current_seq}/${total} 节点` : '—'}</span>
      </div>
    </div>
  );
}
