import React, { useEffect, useMemo, useState } from 'react';
import { api, Requirement } from '../api';
import { useApp } from '../App';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { ReqCard } from './board/ReqCard';
import { ReqCardCompact } from './board/ReqCardCompact';
import { useNodeNames } from './board/nodeState';
import { BoardCtx, SectionMeta, StatItem, roleCfg, groupByTime, groupByUrgency, groupByModule, roleLabel } from './board/roleConfig';

function StatCard({ s }: { s: StatItem }) {
  return (
    <div className={'card stat-card tone-' + (s.tone || 'neutral')}>
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

type BoardDim = 'time' | 'urgency' | 'module';

function groupMine(mine: Requirement[], dim: BoardDim): { key: string; icon: string; label: string; items: Requirement[] }[] | null {
  const out: { key: string; icon: string; label: string; items: Requirement[] }[] = [];
  if (dim === 'time') {
    const g = groupByTime(mine);
    for (const k of ['今日', '近7天', '近30天', '更早']) {
      if (g[k] && g[k].length) out.push({ key: 't-' + k, icon: k === '今日' ? 'active' : 'inbox', label: k, items: g[k] });
    }
  } else if (dim === 'urgency') {
    const g = groupByUrgency(mine);
    for (const k of ['P0', 'P1', 'P2', 'P3', '未标']) {
      if (g[k] && g[k].length) out.push({ key: 'u-' + k, icon: 'clarify', label: k, items: g[k] });
    }
  } else {
    const g = groupByModule(mine);
    for (const k of Object.keys(g)) {
      if (g[k] && g[k].length) out.push({ key: 'm-' + k, icon: 'total', label: k, items: g[k] });
    }
  }
  return out.length === 0 ? null : out;
}

export default function Board({ onOpen, onCreate }: { onOpen: (id: number) => void; onCreate: () => void }) {
  const { user } = useApp();
  const [viewRole, setViewRole] = useState<string>(user?.role || 'RD');
  useEffect(() => { setViewRole(user?.role || 'RD'); }, [user?.role]);

  const [dim, setDim] = useState<BoardDim>('time');

  const [advice, setAdvice] = useState<{ text: string; model: string | null; loading: boolean; cached_at?: string }>({ text: '', model: null, loading: false });
  const [showAdvice, setShowAdvice] = useState(false);  // 默认收起
  // 进页面 / 切换视角：拉缓存（不调 AI，直接显示上次结果）
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c = await api.get('/api/board/ai-cache?role=' + viewRole);
        if (!alive) return;
        setAdvice({ text: c.advice?.text || '', model: c.advice?.model || null, loading: false, cached_at: c.advice?.created_at });
      } catch { /* 拉缓存失败不打断 */ }
    })();
    return () => { alive = false; };
  }, [viewRole]);
  const [mine, setMine] = useState<Requirement[]>([]);
  const [all, setAll] = useState<Requirement[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const m: Requirement[] = await api.get('/api/requirements?mine=1&role=' + (user?.role || ''));
        if (!alive) return;
        setMine(m);
        const everything = user?.role === 'ADMIN' ? m : await api.get('/api/requirements');
        if (alive) setAll(everything);
      } catch { if (alive) { setMine([]); setAll([]); } }
    })();
    return () => { alive = false; };
  }, [user?.role]);

  /** 自动按需加载（进页面 / 切视角时，如果 summary 或 advice 没缓存就调 AI） */
  const ensureLoaded = async () => {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    if (!advice.text && !advice.loading) {
      setAdvice({ text: '', model: null, loading: true });
      try {
        const r = await api.get('/api/board/ai-advice?role=' + viewRole);
        setAdvice({ text: r.text || 'AI 建议暂不可用', model: r.model || null, loading: false, cached_at: now });
      } catch (e: any) {
        setAdvice((s) => ({ ...s, text: e.message || 'AI 建议暂不可用', loading: false }));
      }
    }
  };

  /** 强制刷新：忽略缓存，重新调 AI（点 AI 建议按钮的"刷新"操作） */
  const refreshAi = async () => {
    setAdvice((a) => ({ ...a, loading: true, text: '', cached_at: undefined }));
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    try {
      const a = await api.get('/api/board/ai-advice?role=' + viewRole);
      setAdvice({ text: a.text || '', model: a.model || null, loading: false, cached_at: now });
    } catch (e: any) {
      setAdvice((s) => ({ ...s, text: e.message || 'AI 建议暂不可用', loading: false }));
    }
  };

  const cfg = useMemo(() => roleCfg(user?.role || '', onCreate), [user?.role, onCreate]);
  const ctx: BoardCtx = { user, mine, all, viewRole };
  const todo = useMemo(() => cfg.todo(ctx), [ctx, cfg]);
  const active = useMemo(() => cfg.active(ctx), [ctx, cfg]);
  const nodeMap = useNodeNames([...todo, ...active]);

  const todoGroups = groupMine(todo, dim);
  const activeGroups = groupMine(active, dim);

  const FOCUS: Record<string, string> = {
    CSM: '重点关注：客户开发进度、超时需求、上线反馈',
    PO: '重点关注：版本排期、需求工时饱和度、可合并的需求',
    RD: '重点关注：相似需求合并、技术风险点、阻塞依赖',
    QA: '重点关注：影响模块、回归范围、测试点',
  };

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="crumb">{user?.name} · 看板</div>
          <h1 className="board-greet">{cfg.greet}</h1>
          <div className="muted" style={{ marginTop: 6, maxWidth: 560 }}>{cfg.desc}</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {user?.role === 'ADMIN' && (
            <div className="row" style={{ gap: 4, marginRight: 8 }}>
              {['CSM', 'PO', 'RD', 'QA'].map((r) => (
                <button key={r} className={'btn btn-sm ' + (viewRole === r ? 'btn-primary' : '')} onClick={() => setViewRole(r)}>
                  {roleLabel(r)}
                </button>
              ))}
            </div>
          )}
          {cfg.cta && (
            <button className="btn btn-primary btn-lg" onClick={cfg.cta.onClick}>
              <Icon name={cfg.cta.icon} size={20} />
              {cfg.cta.label}
            </button>
          )}
        </div>
      </div>

      <div className="stat-grid">
        {cfg.stats(ctx).map((s) => <StatCard key={s.key} s={s} />)}
      </div>


      {(advice.text || advice.loading) && (
        <div className="card" style={{ marginTop: 8, borderColor: 'var(--primary)', overflow: 'hidden' }}>
          <div className="row card-pad" style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--primary) 6%, var(--panel)) 0%, var(--panel) 100%)', borderBottom: advice.text ? '1px solid var(--border)' : 'none' }}>
            <Icon name="clarify" size={20} />
            <b style={{ fontSize: 15 }}>{roleLabel(viewRole)}视角 · AI 可执行建议</b>
            <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>{FOCUS[viewRole]}</span>
            <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
              {advice.cached_at && <span className="muted" style={{ fontSize: 11 }}>分析时间：{advice.cached_at}</span>}
              {advice.model && <span className="muted" style={{ fontSize: 11 }}>{advice.model}</span>}
              <button className="btn btn-sm" onClick={refreshAi} title="忽略缓存，重新分析（会消耗 token）">
                <Icon name="refresh" size={16} /> 刷新
              </button>
              <button className="btn btn-sm" onClick={() => setShowAdvice((v) => !v)} title={showAdvice ? '收起' : '展开'}>
                {showAdvice ? '▾ 收起' : '▸ 展开'}
              </button>
            </div>
          </div>
          {advice.loading ? (
            <div className="card-pad row" style={{ color: 'var(--text-2)', fontSize: 13 }}>
              <Icon name="loader" size={16} className="spin" /> AI 正在生成建议…
            </div>
          ) : showAdvice ? (
            <AdviceTable text={advice.text} />
          ) : (
            <div className="card-pad" style={{ color: 'var(--text-2)', fontSize: 13, cursor: 'pointer' }} onClick={() => setShowAdvice(true)}>
              已生成 {advice.text.split(/\n/).filter(l => /^\d+\.\s+/.test(l)).length} 条建议（点击展开 / 点击刷新重新分析） · <a style={{ color: 'var(--primary)' }}>展开 ▾</a>
            </div>
          )}
        </div>
      )}

      <div className="card card-pad row" style={{ marginTop: 12, gap: 16, alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 13 }}>维度：</span>
        {[
          { key: 'time', label: '时间', icon: 'inbox' },
          { key: 'urgency', label: '紧急性', icon: 'clarify' },
          { key: 'module', label: '模块', icon: 'total' },
        ].map((d) => (
          <label key={d.key} className="row" style={{ gap: 4, cursor: 'pointer', userSelect: 'none' }}>
            <input type="radio" name="board-dim" checked={dim === d.key} onChange={() => setDim(d.key as BoardDim)} />
            <Icon name={d.icon as any} size={16} />
            <span style={{ fontSize: 13 }}>{d.label}</span>
          </label>
        ))}
      </div>

      <div className="board-grid">
        <section>
          <SectionHead meta={cfg.todoSection} count={todo.length} />
          {todo.length === 0 ? (
            <div className="card"><EmptyState icon="check" title={user?.role === 'ADMIN' ? '暂无待办' : '没有待你处理的需求'}
              reason={user?.role === 'ADMIN' ? '管理员无需处理节点任务，可下钻任意需求查看流转详情。' : '流转到你这一步的需求会自动出现在这里。'} /></div>
          ) : todoGroups ? (
            todoGroups.map((g) => (
              <div key={g.key} style={{ marginBottom: 12 }}>
                <div className="row" style={{ fontSize: 12, color: 'var(--text-2)', margin: '6px 0' }}>
                  <Icon name={g.icon as any} size={16} /> {g.label} <span className="pill" style={{ marginLeft: 4 }}>{g.items.length}</span>
                </div>
                {g.items.map((r) => (
                  <ReqCardCompact key={r.id} r={r} nodeName={nodeMap[r.id]?.node} totalNodes={nodeMap[r.id]?.nodes?.length} onOpen={onOpen} />
                ))}
              </div>
            ))
          ) : (
            todo.map((r) => (
              <ReqCardCompact key={r.id} r={r} nodeName={nodeMap[r.id]?.node} totalNodes={nodeMap[r.id]?.nodes?.length} onOpen={onOpen} />
            ))
          )}
        </section>

        <section>
          <SectionHead meta={cfg.activeSection} count={active.length} />
          {active.length === 0 ? (
            <div className="card"><EmptyState icon="empty-box" title="暂无进行中的需求" reason="需求提交后会进入 SOP 流程，这里展示尚未完结的全部单据。" /></div>
          ) : activeGroups ? (
            activeGroups.map((g) => (
              <div key={g.key} style={{ marginBottom: 12 }}>
                <div className="row" style={{ fontSize: 12, color: 'var(--text-2)', margin: '6px 0' }}>
                  <Icon name={g.icon as any} size={16} /> {g.label} <span className="pill" style={{ marginLeft: 4 }}>{g.items.length}</span>
                </div>
                {g.items.map((r) => (
                  <ReqCard key={r.id} r={r} nodes={nodeMap[r.id]?.nodes} onOpen={onOpen} />
                ))}
              </div>
            ))
          ) : (
            active.map((r) => (
              <ReqCard key={r.id} r={r} nodes={nodeMap[r.id]?.nodes} onOpen={onOpen} />
            ))
          )}
        </section>
      </div>


    </div>
  );
}


/** 把 AI 返回的 Markdown 简单渲染为 HTML：标题/列表/加粗/换行
 *  - ## 标题 → 加粗大字
 *  - ### 副标题 → 加粗中字
 *  - **加粗** → <b>
 *  - 1./2./- 列表项 → 缩进一行
 *  - 空行分段
 *  - 其他行 → 普通段落
 */
function mdInline(s: string): { __html: string } {
  // 简单 HTML 转义 + 加粗标记替换
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const bolded = esc.replace(/\*\*([^\*]+)\*\*/g, '<b>$1</b>');
  return { __html: bolded };
}

function AiSummaryRenderer({ text, size = 14 }: { text: string; size?: number }) {
  const lines = text.split(/\n/);
  const blocks: { tag: 'h2' | 'h3' | 'li' | 'p'; text: string }[] = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^##\s+/.test(line)) { blocks.push({ tag: 'h2', text: line.replace(/^##\s+/, '') }); inList = false; }
    else if (/^###\s+/.test(line)) { blocks.push({ tag: 'h3', text: line.replace(/^###\s+/, '') }); inList = false; }
    else if (/^\d+\.\s+/.test(line)) { blocks.push({ tag: 'li', text: line.replace(/^\d+\.\s+/, '') }); inList = true; }
    else if (/^[-*]\s+/.test(line)) { blocks.push({ tag: 'li', text: line.replace(/^[-*]\s+/, '') }); inList = true; }
    else if (line.trim() === '') { inList = false; }
    else { blocks.push({ tag: 'p', text: line }); inList = false; }
  }
  return (
    <div style={{ fontSize: size, lineHeight: 1.65, color: 'var(--text-1)' }}>
      {blocks.map((b, i) => {
        if (b.tag === 'h2') return <div key={i} style={{ fontWeight: 700, fontSize: size + 2, marginTop: i ? 10 : 0, marginBottom: 4 }} dangerouslySetInnerHTML={mdInline(b.text)} />;
        if (b.tag === 'h3') return <div key={i} style={{ fontWeight: 600, fontSize: size + 1, marginTop: 8, marginBottom: 2 }} dangerouslySetInnerHTML={mdInline(b.text)} />;
        if (b.tag === 'li') return <div key={i} style={{ paddingLeft: 16, marginTop: 2, position: 'relative' }}><span style={{ position: 'absolute', left: 4 }}>·</span><span dangerouslySetInnerHTML={mdInline(b.text)} /></div>;
        return <div key={i} style={{ marginTop: 2 }} dangerouslySetInnerHTML={mdInline(b.text)} />;
      })}
    </div>
  );
}


/** 把 AI 建议文本解析为表格：分类 / 内容 / 涉及需求
 *  接受格式：
 *    ## 标题（可选）
 *    1. 分类: 内容（含 RQ-xxx 编号）
 *    2. 分类2: 内容2 ...
 *    3. 内容（无冒号则全作为内容）
 */
const CATEGORY_COLORS: Record<string, string> = {
  合并: 'var(--primary)',
  督办: '#ef4444',
  提前评审: '#f59e0b',
  清理: '#6b7280',
  测试: '#8b5cf6',
  关注: '#0ea5e9',
  建议: 'var(--text-1)',
};

function AdviceTable({ text }: { text: string }) {
  // 解析：按换行分块；## 开头是段落标题；N. 开头是建议行
  const lines = text.split(/\n/);
  let sectionTitle = '';
  const rows: { idx: number; category: string; content: string; refs: string[] }[] = [];
  let n = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^##\s+/.test(line)) { sectionTitle = line.replace(/^##\s+/, '').trim(); continue; }
    const m = line.match(/^\d+\.\s+(.*)$/);
    if (!m) continue;
    n += 1;
    const body = m[1];
    // 分类：第一个冒号前；含中文/英文冒号
    const catMatch = body.match(/^([^：:]+)[：:]\s*(.*)$/);
    const category = (catMatch ? catMatch[1].trim() : '建议').replace(/^\*+|\*+$/g, '').replace(/\*/g, '').trim() || '建议';
    const content = catMatch ? catMatch[2].trim() : body;
    // 抽取 RQ- 编号
    const refs = Array.from(new Set((content.match(/RQ-\d{8}-\d{5}/g) || [])));
    rows.push({ idx: n, category, content, refs });
  }
  if (rows.length === 0) {
    return <div className="card-pad"><AiSummaryRenderer text={text} size={13} /></div>;
  }
  return (
    <div className="card-pad" style={{ padding: 0 }}>
      {sectionTitle && <div style={{ padding: '10px 18px 6px', fontSize: 12, color: 'var(--text-2)' }}>{sectionTitle}</div>}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'var(--panel-2)' }}>
            <th style={{ width: 40, padding: '8px 12px', textAlign: 'center', color: 'var(--text-2)', fontWeight: 600, fontSize: 12, borderBottom: '1px solid var(--border)' }}>#</th>
            <th style={{ width: 90, padding: '8px 12px', textAlign: 'left', color: 'var(--text-2)', fontWeight: 600, fontSize: 12, borderBottom: '1px solid var(--border)' }}>分类</th>
            <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-2)', fontWeight: 600, fontSize: 12, borderBottom: '1px solid var(--border)' }}>建议</th>
            <th style={{ width: 200, padding: '8px 12px', textAlign: 'left', color: 'var(--text-2)', fontWeight: 600, fontSize: 12, borderBottom: '1px solid var(--border)' }}>涉及需求</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const color = CATEGORY_COLORS[r.category] || CATEGORY_COLORS.建议;
            return (
              <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'var(--panel-2)' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'color-mix(in srgb, var(--primary) 6%, transparent)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'var(--panel-2)')}>
                <td style={{ padding: '10px 12px', textAlign: 'center', color: 'var(--text-2)', borderBottom: '1px solid var(--border)' }}>{r.idx}</td>
                <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, color: color, background: 'color-mix(in srgb, ' + color + ' 12%, transparent)', border: '1px solid color-mix(in srgb, ' + color + ' 30%, transparent)' }}>
                    {r.category}
                  </span>
                </td>
                <td style={{ padding: '10px 12px', lineHeight: 1.5, color: 'var(--text-1)', borderBottom: '1px solid var(--border)' }} dangerouslySetInnerHTML={{ __html: r.content.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }} />
                <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                  {r.refs.length > 0 ? r.refs.map((rq, j) => (
                    <span key={j} style={{ display: 'inline-block', margin: '0 4px 4px 0', padding: '1px 6px', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4, fontFamily: 'monospace', fontSize: 11, color: 'var(--primary)' }}>{rq}</span>
                  )) : <span className="muted" style={{ fontSize: 11 }}>—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
