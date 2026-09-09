import React, { useCallback, useEffect, useState } from 'react';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { useApp } from '../App';
import { ROLE_NAME, AppNotification, getNotifications, readAllNotifications } from '../api';
import Board from './Board';
import ReqList from './ReqList';
import ReqDetail from './ReqDetail';
import Admin, { ADMIN_TABS, AdminTab } from './Admin';
import DataBoard from './DataBoard';
import CreateModal from './CreateModal';
import { Icon } from '../components/Icon';
import { NotificationPanel } from '../components/NotificationPanel';

type Page = 'board' | 'list' | 'admin' | 'databoard';

export default function Shell() {
  const { user, toast, logout } = useApp();
  const [page, setPage] = useState<Page>('board');
  const [detailId, setDetailId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [adminTab, setAdminTab] = useState<AdminTab>('sop');
  const [adminOpen, setAdminOpen] = useState(true);
  const [notifs, setNotifs] = useState<AppNotification[]>([]);
  const [showNotifs, setShowNotifs] = useState(false);

  const openDetail = (id: number) => setDetailId(id);
  const back = () => setDetailId(null);
  const nav = (p: Page) => { setPage(p); setDetailId(null); };
  const navAdmin = (t: AdminTab) => { setAdminTab(t); nav('admin'); };
  const initial = (user?.name || 'U').slice(0, 1).toUpperCase();

  // 进入管理页时自动展开管理分组（用户手动收起后，下次导航到管理页仍可展开）
  useEffect(() => { if (page === 'admin') setAdminOpen(true); }, [page]);

  // 拉通知：进入页面 / 切换路由时刷新（MVP 不做定时轮询）
  const loadNotifs = useCallback(async () => {
    try { setNotifs(await getNotifications()); } catch { /* 通知拉取失败不阻断页面 */ }
  }, []);
  useEffect(() => { loadNotifs(); }, [loadNotifs, page, detailId]);

  const unread = notifs.filter((n) => !n.read_flag).length;

  const toggleNotifs = async () => {
    const next = !showNotifs;
    setShowNotifs(next);
    if (next) {
      try { await readAllNotifications(); } catch { /* 静默 */ }
      setNotifs((ns) => ns.map((n) => ({ ...n, read_flag: 1 })));
    }
  };
  const openNotif = (n: AppNotification) => {
    setShowNotifs(false);
    if (n.requirement_id) openDetail(n.requirement_id);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">S</div>
          <div>
            <b>AI · SOP</b>
            <span className="sub">需求交付平台</span>
          </div>
        </div>

        <button className={`nav-item ${page === 'board' && !detailId ? 'on' : ''}`} onClick={() => nav('board')}>
          <Icon name="board" size={20} /> 需求看板
        </button>
        <button className={`nav-item ${page === 'list' && !detailId ? 'on' : ''}`} onClick={() => nav('list')}>
          <Icon name="list" size={20} /> 需求列表
        </button>
        <button className={`nav-item ${page === 'databoard' && !detailId ? 'on' : ''}`} onClick={() => nav('databoard')}>
          <Icon name="active" size={20} /> 数据看板
        </button>
        {user?.role === 'CSM' && (
          <button className="nav-item" onClick={() => setShowCreate(true)}>
            <Icon name="plus" size={20} /> 提交需求
          </button>
        )}
        {user?.role === 'ADMIN' && (
          <>
            <button
              className={`nav-group nav-group-toggle ${page === 'admin' ? 'on' : ''}`}
              onClick={() => setAdminOpen((o) => !o)}
              aria-expanded={adminOpen}
              aria-controls="admin-sub-nav"
            >
              <Icon name="settings" size={20} /> 管理后台
              <Icon name={adminOpen ? 'chevron-up' : 'chevron-down'} size={16} className="nav-chev" />
            </button>
            {adminOpen && (
              <div id="admin-sub-nav">
                {ADMIN_TABS.map(([k, label]) => (
                  <button key={k}
                    className={`nav-item nav-sub ${page === 'admin' && adminTab === k && !detailId ? 'on' : ''}`}
                    onClick={() => navAdmin(k)}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        <div className="spacer" />

        <div className="user-card">
          <div className="u-head">
            <div className="avatar">{initial}</div>
            <div className="u-meta">
              <div className="u-name">{user?.name}</div>
              <span className="role-badge">{ROLE_NAME[user?.role || '']}</span>
            </div>
          </div>
          <button className="btn btn-sm btn-block" onClick={logout}>
            <Icon name="logout" size={16} /> 退出登录
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="shell-topbar">
          <div className="notif-wrap">
            <button className="btn btn-icon btn-ghost" onClick={toggleNotifs}
              aria-label={unread > 0 ? `通知中心（${unread} 条未读）` : '通知中心'}>
              <Icon name={unread > 0 ? 'bell-ring' : 'bell'} size={20} />
              {unread > 0 && <span className="notif-badge">{unread > 99 ? '99+' : unread}</span>}
            </button>
            {showNotifs && (
              <NotificationPanel notifs={notifs} onOpen={openNotif} onClose={() => setShowNotifs(false)} />
            )}
          </div>
        </div>

        {detailId ? (
          <ErrorBoundary>
            <ReqDetail id={detailId} onBack={back} />
          </ErrorBoundary>
        ) : page === 'admin' ? (
          <Admin tab={adminTab} />
        ) : page === 'list' ? (
          <ReqList onOpen={openDetail} onCreate={() => setShowCreate(true)} />
        ) : page === 'databoard' ? (
          <DataBoard onOpen={openDetail} />
        ) : (
          <Board onOpen={openDetail} onCreate={() => setShowCreate(true)} />
        )}
      </main>

      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onDone={(id) => { setShowCreate(false); toast('需求已提交，AI 开始处理'); openDetail(id); }}
        />
      )}
    </div>
  );
}
