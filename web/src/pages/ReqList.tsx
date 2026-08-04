import React, { useEffect, useMemo, useState } from 'react';
import { api, Requirement, STATUS_NAME } from '../api';
import { useApp } from '../App';
import { Icon, IconName } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { LevelBadge } from './board/ReqCard';
import { useNodeNames, openCount } from './board/nodeState';
import { buildColumns } from './list/columns';

type View = 'table' | 'kanban';

const VIEW_OPTS: { value: View; label: string; icon: IconName }[] = [
  { value: 'table', label: '表格', icon: 'list' },
  { value: 'kanban', label: '看板', icon: 'board' },
];
const SCOPE_OPTS = [
  { value: 'mine' as const, label: '我的' },
  { value: 'all' as const, label: '全部' },
];
const STATUS_OPTS = [
  ['', '全部状态'], ['SUBMITTED', '已提交'], ['AI_RUNNING', 'AI 处理中'],
  ['CLARIFYING', '待澄清'], ['PENDING', '待处理'], ['DONE', '已完成'], ['CANCELLED', '已取消'],
];
const LEVEL_OPTS = [['', '全部等级'], ['L1', 'L1'], ['L2', 'L2'], ['L3', 'L3'], ['L4', 'L4']];
const PRIO_OPTS = [['', '全部紧急度'], ['P0', 'P0'], ['P1', 'P1'], ['P2', 'P2'], ['P3', 'P3']];

const ownersOf = (r: Requirement) => [
  r.po_name && `产:${r.po_name}`,
  r.rd_name && `研:${r.rd_name}`,
  r.qa_name && `测:${r.qa_name}`,
].filter(Boolean).join(' ');

export default function ReqList({ onOpen, onCreate }: { onOpen: (id: number) => void; onCreate: () => void }) {
  const { user } = useApp();
  const [list, setList] = useState<Requirement[]>([]);
  const [view, setView] = useState<View>('table');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [level, setLevel] = useState('');
  const [prio, setPrio] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      const qs = scope === 'mine' ? `?mine=1&role=${user?.role || ''}` : '';
      try {
        const data = await api.get('/api/requirements' + qs);
        if (alive) setList(data);
      } catch {
        if (alive) setList([]);
      }
    })();
    return () => { alive = false; };
  }, [scope, user?.role]);

  const filtered = useMemo(() => list.filter((r) => {
    if (status && r.status !== status) return false;
    if (level && r.level !== level) return false;
    if (prio && r.priority !== prio) return false;
    if (q) {
      const haystack = `${r.req_no} ${r.title} ${r.customer_name || ''}`.toLowerCase();
      if (!haystack.includes(q.trim().toLowerCase())) return false;
    }
    return true;
  }), [list, q, status, level, prio]);

  const nodeMap = useNodeNames(filtered);
  const columns = useMemo(
    () => buildColumns(filtered, (r) => nodeMap[r.id]?.node),
    [filtered, nodeMap],
  );

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="crumb">{scope === 'mine' ? '与我相关' : '全部需求'}</div>
          <h1>需求列表</h1>
        </div>
        <div className="row">
          <div className="seg">
            {SCOPE_OPTS.map((o) => (
              <button key={o.value} className={`btn btn-sm ${scope === o.value ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setScope(o.value)}>{o.label}</button>
            ))}
          </div>
          <div className="seg">
            {VIEW_OPTS.map((o) => (
              <button key={o.value} className={`btn btn-sm ${view === o.value ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setView(o.value)}>
                <Icon name={o.icon} size={16} />
                {o.label}
              </button>
            ))}
          </div>
          {user?.role === 'CSM' && (
            <button className="btn btn-primary" onClick={onCreate}>
              <Icon name="plus" size={20} />
              提交需求
            </button>
          )}
        </div>
      </div>

      <div className="card card-pad row filter-bar">
        <div className="field-icon" style={{ maxWidth: 280, flex: '1 1 220px' }}>
          <Icon name="search" size={16} className="fi-icon" />
          <input className="input" placeholder="搜索单号 / 标题 / 客户" value={q}
            aria-label="搜索需求" onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="input" style={{ width: 130 }} aria-label="按状态筛选" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUS_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className="input" style={{ width: 110 }} aria-label="按等级筛选" value={level} onChange={(e) => setLevel(e.target.value)}>
          {LEVEL_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className="input" style={{ width: 120 }} aria-label="按紧急度筛选" value={prio} onChange={(e) => setPrio(e.target.value)}>
          {PRIO_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <span className="muted nowrap" style={{ marginLeft: 'auto' }}>{filtered.length} 条</span>
      </div>

      {view === 'table' ? (
        <div className="card tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>单号</th><th>标题</th><th>客户</th><th>等级</th><th>状态</th><th>当前节点</th><th>负责人</th><th>更新</th></tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={8}>
                  <EmptyState icon="search" title="没有匹配的需求"
                    reason="当前筛选条件下没有结果，放宽状态或等级筛选再试。" />
                </td></tr>
              )}
              {filtered.map((r) => {
                const [statusText, statusTone] = STATUS_NAME[r.status] || [r.status, 'grey'];
                return (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(r.id)}>
                    <td className="muted mono">{r.req_no}</td>
                    <td style={{ fontWeight: 600 }}>
                      {r.title}
                      {openCount(r) > 0 && <span className="tag tag-orange" style={{ marginLeft: 6 }}>待补充</span>}
                    </td>
                    <td className="text-2">{r.customer_name || '—'}</td>
                    <td><LevelBadge level={r.level} /></td>
                    <td><span className={`tag tag-${statusTone}`}>{statusText}</span></td>
                    <td className="muted">{r.status === 'DONE' ? '—' : nodeMap[r.id]?.node || '解析中'}</td>
                    <td className="muted">{ownersOf(r) || '—'}</td>
                    <td className="muted nowrap mono">{r.updated_at?.slice(5, 16)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="kanban">
          {columns.length === 0 && (
            <div className="card" style={{ width: '100%' }}>
              <EmptyState icon="empty-box" title="暂无需求"
                reason="切换到「全部」范围，或调整筛选条件查看其他需求。" />
            </div>
          )}
          {columns.map((col) => (
            <div className="kb-col" key={col.key}>
              <div className="kb-head">
                <span className="kb-name">
                  <Icon name={col.icon} size={16} />
                  {col.label}
                </span>
                <span className="pill">{col.items.length}</span>
              </div>
              <div className="kb-body">
                {col.items.map((r) => {
                  const [statusText, statusTone] = STATUS_NAME[r.status] || [r.status, 'grey'];
                  return (
                    <div className="kb-card card hover" key={r.id} onClick={() => onOpen(r.id)}>
                      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                        <LevelBadge level={r.level} />
                        <span className={`tag tag-${statusTone}`}>{statusText}</span>
                      </div>
                      <div className="kb-title">{r.title}</div>
                      <div className="kb-meta">
                        <span className="rc-no">{r.req_no}</span>
                        {r.customer_name && (
                          <span className="rc-inline">
                            <Icon name="customer" size={16} />
                            {r.customer_name}
                          </span>
                        )}
                      </div>
                      <div className="kb-meta" style={{ marginTop: 6 }}>
                        <span className={`prio prio-${r.priority}`}>{r.priority}</span>
                        <span className="muted nowrap" style={{ marginLeft: 'auto' }}>{r.updated_at?.slice(5, 10)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
