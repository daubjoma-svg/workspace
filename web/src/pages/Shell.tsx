import React, { useState } from 'react';
import { useApp } from '../App';
import { ROLE_NAME } from '../api';
import Board from './Board';
import ReqList from './ReqList';
import ReqDetail from './ReqDetail';
import Admin, { ADMIN_TABS, AdminTab } from './Admin';
import CreateModal from './CreateModal';
import { Icon } from '../components/Icon';

type Page = 'board' | 'list' | 'admin';

export default function Shell() {
  const { user, toast, logout } = useApp();
  const [page, setPage] = useState<Page>('board');
  const [detailId, setDetailId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [adminTab, setAdminTab] = useState<AdminTab>('sop');

  const openDetail = (id: number) => setDetailId(id);
  const back = () => setDetailId(null);
  const nav = (p: Page) => { setPage(p); setDetailId(null); };
  const navAdmin = (t: AdminTab) => { setAdminTab(t); nav('admin'); };
  const initial = (user?.name || 'U').slice(0, 1).toUpperCase();

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
        {user?.role === 'CSM' && (
          <button className="nav-item" onClick={() => setShowCreate(true)}>
            <Icon name="plus" size={20} /> 提交需求
          </button>
        )}
        {user?.role === 'ADMIN' && (
          <>
            <div className="nav-group">
              <Icon name="settings" size={20} /> 管理后台
            </div>
            {ADMIN_TABS.map(([k, label]) => (
              <button key={k}
                className={`nav-item nav-sub ${page === 'admin' && adminTab === k && !detailId ? 'on' : ''}`}
                onClick={() => navAdmin(k)}>
                {label}
              </button>
            ))}
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
        {detailId ? (
          <ReqDetail id={detailId} onBack={back} />
        ) : page === 'admin' ? (
          <Admin tab={adminTab} />
        ) : page === 'list' ? (
          <ReqList onOpen={openDetail} onCreate={() => setShowCreate(true)} />
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
