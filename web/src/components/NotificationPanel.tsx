import React from 'react';
import { AppNotification } from '../api';

interface NotificationPanelProps {
  notifs: AppNotification[];
  onOpen: (n: AppNotification) => void;
  onClose: () => void;
  /** 最多展示条数（默认 20） */
  limit?: number;
}

/** 通知下拉抽屉（纯展示，Shell 铃铛按钮持有状态；抽出以便独立 SSR 验证未读>0 / =0 两态） */
export function NotificationPanel({ notifs, onOpen, onClose, limit = 20 }: NotificationPanelProps) {
  return (
    <>
      <div className="notif-scrim" onClick={onClose} />
      <div className="notif-pop" role="dialog" aria-label="通知中心">
        <div className="notif-head">
          <span className="section-title" style={{ marginBottom: 0 }}>通知中心</span>
          <span className="pill">{notifs.length}</span>
        </div>
        {notifs.length === 0 ? (
          <div className="empty" style={{ padding: '32px 12px' }}>暂无通知</div>
        ) : (
          <>
            {notifs.slice(0, limit).map((n) => (
              <button key={n.id} type="button" className={`notif-item ${!n.read_flag ? 'unread' : ''}`}
                onClick={() => onOpen(n)}>
                <div className="ni-title">{n.title}</div>
                {n.content && <div className="ni-content">{n.content}</div>}
                <div className="ni-time">{n.created_at}</div>
              </button>
            ))}
            {notifs.length > limit && <div className="notif-more">仅显示最近 {limit} 条</div>}
          </>
        )}
      </div>
    </>
  );
}
