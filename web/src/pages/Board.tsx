import React, { useEffect, useMemo, useState } from 'react';
import { api, Requirement } from '../api';
import { useApp } from '../App';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { ReqCard } from './board/ReqCard';
import { useNodeNames } from './board/nodeState';
import { BoardCtx, SectionMeta, StatItem, roleCfg } from './board/roleConfig';

function StatCard({ s }: { s: StatItem }) {
  return (
    <div className={`card stat-card tone-${s.tone || 'neutral'}`}>
      <div className="icon"><Icon name={s.icon} size={20} /></div>
      <div className="k">{s.label}</div>
      <div className="v">{s.value}</div>
      {s.hint && <div className="muted" style={{ marginTop: 2 }}>{s.hint}</div>}
    </div>
  );
}

function SectionHead({ meta, count }: { meta: SectionMeta; count: number }) {
  return (
    <div className="section-title section-head">
      <span className="sh-label">
        <Icon name={meta.icon} size={16} />
        {meta.label}
      </span>
      <span className="pill">{count}</span>
    </div>
  );
}

export default function Board({ onOpen, onCreate }: { onOpen: (id: number) => void; onCreate: () => void }) {
  const { user } = useApp();
  const [mine, setMine] = useState<Requirement[]>([]);
  const [all, setAll] = useState<Requirement[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const m: Requirement[] = await api.get(`/api/requirements?mine=1&role=${user?.role || ''}`);
        if (!alive) return;
        setMine(m);
        const everything = user?.role === 'ADMIN' ? m : await api.get('/api/requirements');
        if (alive) setAll(everything);
      } catch {
        if (alive) { setMine([]); setAll([]); }
      }
    })();
    return () => { alive = false; };
  }, [user?.role]);

  const cfg = useMemo(() => roleCfg(user?.role || '', onCreate), [user?.role, onCreate]);
  const ctx: BoardCtx = { user, mine, all };
  const todo = cfg.todo(ctx);
  const active = cfg.active(ctx);
  const nodeMap = useNodeNames(active);

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="crumb">{user?.name} · 看板</div>
          <h1>{cfg.greet}</h1>
          <div className="muted" style={{ marginTop: 6, maxWidth: 560 }}>{cfg.desc}</div>
        </div>
        {cfg.cta && (
          <button className="btn btn-primary btn-lg" onClick={cfg.cta.onClick}>
            <Icon name={cfg.cta.icon} size={20} />
            {cfg.cta.label}
          </button>
        )}
      </div>

      <div className="stat-grid">
        {cfg.stats(ctx).map((s) => <StatCard key={s.key} s={s} />)}
      </div>

      <div className="board-grid">
        <section>
          <SectionHead meta={cfg.todoSection} count={todo.length} />
          {todo.length === 0 ? (
            <div className="card">
              <EmptyState
                icon="check"
                title="没有待你处理的需求"
                reason="流转到你这一步的需求会自动出现在这里。"
              />
            </div>
          ) : todo.map((r) => (
            <ReqCard key={r.id} r={r} nodeName={nodeMap[r.id]?.node} onOpen={onOpen} accent />
          ))}
        </section>

        <section>
          <SectionHead meta={cfg.activeSection} count={active.length} />
          {active.length === 0 ? (
            <div className="card">
              <EmptyState
                icon="empty-box"
                title="暂无进行中的需求"
                reason="需求提交后会进入 SOP 流程，这里展示尚未完结的全部单据。"
              />
            </div>
          ) : active.map((r) => (
            <ReqCard key={r.id} r={r} nodes={nodeMap[r.id]?.nodes} onOpen={onOpen} />
          ))}
        </section>
      </div>
    </div>
  );
}
