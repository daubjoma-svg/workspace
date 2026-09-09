import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, Requirement, STATUS_NAME } from '../api';
import { useApp } from '../App';
import { Icon, IconName } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { SearchSelect } from '../components/SearchSelect';
import { ConfirmModal } from '../components/ConfirmModal';
import { LevelBadge } from './board/ReqCard';
import { useNodeNames, openCount } from './board/nodeState';
import { buildColumns } from './list/columns';
import { ReqEditModal } from '../components/ReqEditModal';

type View = 'table' | 'kanban';
const PAGE_SIZE = 20;

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
  ['CLARIFYING', '待澄清'], ['PENDING', '待处理'], ['AI_FAILED', 'AI 执行失败'],
  ['DONE', '已完成'], ['CANCELLED', '已取消'],
];
const LEVEL_OPTS = [['', '全部等级'], ['L1', 'L1'], ['L2', 'L2'], ['L3', 'L3'], ['L4', 'L4']];
const PRIO_OPTS = [['', '全部紧急度'], ['P0', 'P0'], ['P1', 'P1'], ['P2', 'P2'], ['P3', 'P3']];

const ownersOf = (r: Requirement) => [
  r.po_name && `产:${r.po_name}`,
  r.rd_name && `研:${r.rd_name}`,
  r.qa_name && `测:${r.qa_name}`,
].filter(Boolean).join(' ');

/**
 * 从 Jira URL 中提取单号标签：取最后一个非空 path 段。
 *   https://jira.xxx/browse/PINGTAI-11880        → PINGTAI-11880
 *   https://jira.xxx/projects/PINGTAI/issues/PINGTAI-11880 → PINGTAI-11880
 *   https://jira.xxx/browse/PINGTAI-11880/       → PINGTAI-11880
 * 非 URL/空串返回空串（列表里显示「—」）。
 */
function jiraLabel(url: string | null | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    return segs.length ? segs[segs.length - 1] : '';
  } catch {
    // 非合法 URL，兜底取最后一段
    const segs = String(url).split('/').filter(Boolean);
    return segs.length ? segs[segs.length - 1] : '';
  }
}

export default function ReqList({ onOpen, onCreate }: { onOpen: (id: number) => void; onCreate: () => void }) {
  const { user, toast } = useApp();
  const [list, setList] = useState<Requirement[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [view, setView] = useState<View>('table');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [level, setLevel] = useState('');
  const [prio, setPrio] = useState('');
  const [editingReq, setEditingReq] = useState<Requirement | null>(null);
  /** 批量删除：选中的需求 id 集合（仅 ADMIN 可用） */
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [delOpen, setDelOpen] = useState(false);
  const isAdmin = user?.role === 'ADMIN';

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  /** 数据层：服务端分页（契约 GET /requirements?page&pageSize → {items,total,page,pageSize}）。
   *  服务端仅按 status/scope 过滤分页；level/prio/q 作为当前页内筛选（后端未支持，MVP 收窄）。 */
  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (scope === 'mine') { params.set('mine', '1'); params.set('role', user?.role || ''); }
    if (status) params.set('status', status);
    try {
      const r: any = await api.get('/api/requirements?' + params.toString());
      const items: Requirement[] = Array.isArray(r) ? r : (r.items || []);
      // 末页被删空时回退一页，避免停在空页
      if (items.length === 0 && page > 1) { setPage((p) => p - 1); return; }
      setList(items);
      setTotal(Array.isArray(r) ? items.length : (r.total ?? 0));
    } catch { setList([]); setTotal(0); }
  }, [scope, status, user?.role, page]);
  useEffect(() => { load(); }, [load]);

  // 编辑权限：ADMIN 全量；CSM 仅自己提交的；终态（DONE/CANCELLED）后端 400，直接隐藏
  const canEdit = (r: Requirement) =>
    (user?.role === 'ADMIN' || (user?.role === 'CSM' && r.csm_id === user?.id))
    && r.status !== 'DONE' && r.status !== 'CANCELLED';

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
                onClick={() => { setScope(o.value); setPage(1); }}>{o.label}</button>
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
          {isAdmin && sel.size > 0 && (
            <button className="btn btn-danger" onClick={() => setDelOpen(true)}>
              <Icon name="x" size={16} />
              批量删除（{sel.size}）
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
        <SearchSelect
          options={STATUS_OPTS.map(([v, l]) => ({ value: v, label: l }))}
          value={status}
          onChange={(v) => { setStatus(String(v)); setPage(1); }}
          width={130}
          placeholder="全部状态"
        />
        <SearchSelect
          options={LEVEL_OPTS.map(([v, l]) => ({ value: v, label: l }))}
          value={level}
          onChange={(v) => setLevel(String(v))}
          width={110}
          placeholder="全部等级"
        />
        <SearchSelect
          options={PRIO_OPTS.map(([v, l]) => ({ value: v, label: l }))}
          value={prio}
          onChange={(v) => setPrio(String(v))}
          width={120}
          placeholder="全部紧急度"
        />
        <span className="muted nowrap" style={{ marginLeft: 'auto' }}>共 {total} 条</span>
      </div>

      {view === 'table' ? (
        <div className="card tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                {isAdmin && (
                  <th style={{ width: 34 }}>
                    <input type="checkbox" aria-label="全选"
                      checked={filtered.length > 0 && sel.size === filtered.length}
                      onChange={(e) => setSel(e.target.checked ? new Set(filtered.map((r) => r.id)) : new Set())} />
                  </th>
                )}
                <th>单号</th><th>Jira</th><th>标题</th><th>客户</th><th>等级</th><th>状态</th><th>当前节点</th><th>负责人</th><th>更新</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={isAdmin ? 11 : 10}>
                  <EmptyState icon="search" title="没有匹配的需求"
                    reason="当前筛选条件下没有结果，放宽状态或等级筛选再试。" />
                </td></tr>
              )}
              {filtered.map((r) => {
                const [statusText, statusTone] = STATUS_NAME[r.status] || [r.status, 'grey'];
                return (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(r.id)}>
                    {isAdmin && (
                      <td onClick={(e) => e.stopPropagation()} style={{ textAlign: 'center' }}>
                        <input type="checkbox" aria-label={`选择 ${r.req_no}`}
                          checked={sel.has(r.id)}
                          onChange={(e) => {
                            const next = new Set(sel);
                            if (e.target.checked) next.add(r.id); else next.delete(r.id);
                            setSel(next);
                          }} />
                      </td>
                    )}
                    <td className="muted mono">{r.req_no}</td>
                    <td className="mono">
                      {r.jira_url ? (
                        <a
                          href={r.jira_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="jira-link"
                          title={r.jira_url}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Icon name="link" size={16} /> {jiraLabel(r.jira_url)}
                        </a>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
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
                    <td>
                      {canEdit(r) && (
                        <button className="btn btn-sm btn-icon" aria-label="编辑需求"
                          onClick={(e) => { e.stopPropagation(); setEditingReq(r); }}>
                          <Icon name="edit" size={16} />
                        </button>
                      )}
                    </td>
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
                        {canEdit(r) && (
                          <button className="btn btn-sm btn-icon" aria-label="编辑需求"
                            onClick={(e) => { e.stopPropagation(); setEditingReq(r); }}>
                            <Icon name="edit" size={16} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card row pager">
        <button className="btn btn-sm" disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}>
          <Icon name="back" size={16} /> 上一页
        </button>
        <button className="btn btn-sm" disabled={page >= totalPages}
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
          下一页 <Icon name="forward" size={16} />
        </button>
        <span className="pager-info">共 {total} 条 · 第 {page} / {totalPages} 页</span>
      </div>

      {editingReq && (
        <ReqEditModal
          req={editingReq}
          onClose={() => setEditingReq(null)}
          onSaved={() => { setEditingReq(null); load(); }}
        />
      )}

      {/* 批量删除确认弹窗 */}
      {delOpen && (
        <ConfirmModal
          title="批量删除需求"
          message={`确认删除选中的 ${sel.size} 条需求？关联的澄清、产物、时间线记录将一并删除，该操作不可恢复。`}
          confirmText="批量删除"
          danger
          onCancel={() => setDelOpen(false)}
          onConfirm={async () => {
            try {
              const ids = [...sel];
              const r = await api.post('/api/admin/requirements/batch-delete', { ids });
              toast(`已删除 ${r.deleted} 条需求`);
              setSel(new Set());
              setDelOpen(false);
              await load();
            } catch (e: any) { toast(e.message, 'error'); }
          }}
        />
      )}
    </div>
  );
}
