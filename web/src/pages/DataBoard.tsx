import React, { useEffect, useState, useMemo } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { Icon } from '../components/Icon';
import { roleLabel } from './board/roleConfig';

interface Trends {
  days: number;
  role: string;
  daily: { d: string; c: number }[];
  daily_done: { d: string; c: number }[];
  byStatus: { status: string; c: number }[];
  byPriority: { p: string; c: number }[];
  byModule: { name: string; c: number }[];
  todoCount: number;
  activeCount: number;
  customerCount: number;
  byCustomer: { name: string; c: number }[];
}

/** 简单折线图（SVG 自绘，零依赖）
 *  points: [{x: string, y: number}]（x 为日期字符串，仅用于显示）
 *  width/height: 视图尺寸
 *  color: 线色
 *  fill: 是否填充下方区域
 */
function LineChart({ points, width = 560, height = 200, color = 'var(--primary)', fill = true, yMax, label }: {
  points: { x: string; y: number }[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
  yMax?: number;
  label?: string;
}) {
  if (points.length === 0) return <div className="muted" style={{ padding: 20, textAlign: 'center' }}>暂无数据</div>;
  const padding = { top: 18, right: 14, bottom: 28, left: 32 };
  const w = width - padding.left - padding.right;
  const h = height - padding.top - padding.bottom;
  const maxY = yMax ?? Math.max(...points.map((p) => p.y), 1);
  const stepX = points.length > 1 ? w / (points.length - 1) : w;
  const toX = (i: number) => padding.left + i * stepX;
  const toY = (v: number) => padding.top + h - (v / maxY) * h;
  // 折线 path
  const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + toX(i).toFixed(1) + ',' + toY(p.y).toFixed(1)).join(' ');
  // 填充区 path
  const fillPath = linePath + ` L ${toX(points.length - 1).toFixed(1)},${(padding.top + h).toFixed(1)} L ${toX(0).toFixed(1)},${(padding.top + h).toFixed(1)} Z`;
  // y 轴 4 条 grid
  const gridY = [0, 0.25, 0.5, 0.75, 1].map((r) => padding.top + h * r);
  const labelsY = [0, 0.5, 1].map((r) => Math.round(maxY * (1 - r)));
  return (
    <svg viewBox={'0 0 ' + width + ' ' + height} width="100%" height={height} preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs>
        <linearGradient id={'grad-' + color.replace(/[^a-z0-9]/gi, '')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {gridY.map((y, i) => (
        <line key={i} x1={padding.left} y1={y} x2={padding.left + w} y2={y} stroke="var(--border)" strokeWidth={1} strokeDasharray={i === 0 || i === 4 ? '0' : '2 3'} />
      ))}
      {labelsY.map((v, i) => (
        <text key={i} x={padding.left - 6} y={padding.top + h * (i / 2) + 4} fontSize="11" fill="var(--text-2)" textAnchor="end">{v}</text>
      ))}
      {fill && <path d={fillPath} fill={'url(#grad-' + color.replace(/[^a-z0-9]/gi, '') + ')'} />}
      <path d={linePath} fill="none" stroke={color} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={toX(i)} cy={toY(p.y)} r={3} fill={color} />
          <title>{p.x}：{p.y}</title>
        </g>
      ))}
      {/* x 轴 label：取首末 + 均匀分布 4 个 */}
      {points.length <= 8 ? points.map((p, i) => (
        <text key={i} x={toX(i)} y={height - 8} fontSize="10" fill="var(--text-2)" textAnchor="middle">{p.x.slice(5)}</text>
      )) : [0, Math.floor(points.length / 3), Math.floor((points.length * 2) / 3), points.length - 1].map((i) => (
        <text key={i} x={toX(i)} y={height - 8} fontSize="10" fill="var(--text-2)" textAnchor="middle">{points[i].x.slice(5)}</text>
      ))}
      {label && <text x={padding.left} y={14} fontSize="12" fontWeight="600" fill="var(--text-1)">{label}</text>}
    </svg>
  );
}

/** 水平柱状图（业务模块 / 优先级 / 状态） */
function BarChart({ items, color = 'var(--primary)', label }: {
  items: { name: string; value: number }[];
  color?: string;
  label?: string;
}) {
  if (items.length === 0) return <div className="muted" style={{ padding: 20, textAlign: 'center' }}>暂无数据</div>;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div>
      {label && <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-1)', marginBottom: 8 }}>{label}</div>}
      {items.map((it) => (
        <div key={it.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <div style={{ width: 110, fontSize: 12, color: 'var(--text-1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</div>
          <div style={{ flex: 1, height: 18, background: 'var(--panel-2)', borderRadius: 4, overflow: 'hidden', position: 'relative' }}>
            <div style={{ width: ((it.value / max) * 100) + '%', height: '100%', background: 'linear-gradient(90deg, ' + color + ' 0%, color-mix(in srgb, ' + color + ' 70%, transparent) 100%)', borderRadius: 4, transition: 'width 0.6s ease' }} />
          </div>
          <div style={{ width: 36, fontSize: 12, color: 'var(--text-1)', textAlign: 'right', fontWeight: 600 }}>{it.value}</div>
        </div>
      ))}
    </div>
  );
}

export default function DataBoard({ onOpen }: { onOpen: (id: number) => void }) {
  const { user } = useApp();
  const [viewRole, setViewRole] = useState(user?.role || 'RD');
  const [days, setDays] = useState(30);
  const [trends, setTrends] = useState<Trends | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const r = await api.get('/api/board/trends?role=' + viewRole + '&days=' + days);
        if (alive) setTrends(r);
      } catch (e: any) {
        if (alive) setError(e.message || '加载失败');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [viewRole, days]);

  // 数据加工：按时间正序 + 补零
  const dailyCreated = useMemo(() => {
    if (!trends) return [] as { x: string; y: number }[];
    const map = new Map<string, number>();
    for (const r of trends.daily) map.set(r.d, r.c);
    const out: { x: string; y: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      out.push({ x: key, y: map.get(key) || 0 });
    }
    return out;
  }, [trends, days]);

  const dailyDone = useMemo(() => {
    if (!trends) return [] as { x: string; y: number }[];
    const map = new Map<string, number>();
    for (const r of trends.daily_done) map.set(r.d, r.c);
    const out: { x: string; y: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      out.push({ x: key, y: map.get(key) || 0 });
    }
    return out;
  }, [trends, days]);

  const totalReq = useMemo(() => {
    if (!trends) return 0;
    return trends.byStatus.reduce((s, x) => s + x.c, 0);
  }, [trends]);

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="crumb">数据看板</div>
          <h1 className="board-greet">需求数据可视化</h1>
          <div className="muted" style={{ marginTop: 6, maxWidth: 560 }}>从时间、状态、优先级、业务模块多个维度看需求流转趋势。</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {user?.role === 'ADMIN' && (
            <div className="row" style={{ gap: 4 }}>
              {(['CSM', 'PO', 'RD', 'FE', 'QA'] as const).map((r) => (
                <button key={r} className={'btn btn-sm ' + (viewRole === r ? 'btn-primary' : '')} onClick={() => setViewRole(r)}>{roleLabel(r)}</button>
              ))}
            </div>
          )}
          <div className="row" style={{ gap: 4 }}>
            {[7, 30, 90].map((d) => (
              <button key={d} className={'btn btn-sm ' + (days === d ? 'btn-primary' : '')} onClick={() => setDays(d)}>{d}天</button>
            ))}
          </div>
        </div>
      </div>

      {error && <div className="card card-pad" style={{ color: '#ef4444' }}>加载失败：{error}</div>}

      {/* 顶部 3 个核心统计卡：待你处理 / 进行中 / 企业维度 */}
      <div className="stat-grid">
        <div className="card stat-card tone-warn">
          <div className="icon"><Icon name="todo" size={20} /></div>
          <div className="k">待你处理</div>
          <div className="v">{trends?.todoCount ?? '-'}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>当前节点轮到 {roleLabel(viewRole)} 处理</div>
        </div>
        <div className="card stat-card tone-neutral">
          <div className="icon"><Icon name="in-progress" size={20} /></div>
          <div className="k">进行中</div>
          <div className="v">{trends?.activeCount ?? '-'}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>创建未完成（不含已上线/已取消）</div>
        </div>
        <div className="card stat-card tone-good">
          <div className="icon"><Icon name="customer" size={20} /></div>
          <div className="k">企业维度</div>
          <div className="v">{trends?.customerCount ?? '-'}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>涉及企业 / 客户数</div>
        </div>
      </div>

      {/* 折线图区域 */}
      <div className="grid2" style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card card-pad">
          <div className="row" style={{ marginBottom: 8 }}>
            <Icon name="clarify" size={16} />
            <b style={{ fontSize: 14 }}>每日创建数</b>
            <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>近 {days} 天</span>
            <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>合计 {dailyCreated.reduce((s, p) => s + p.y, 0)}</span>
          </div>
          {loading ? <div className="muted" style={{ padding: 40, textAlign: 'center' }}><Icon name="loader" size={16} className="spin" /> 加载中…</div> : <LineChart points={dailyCreated} color="#2563eb" label="" />}
        </div>
        <div className="card card-pad">
          <div className="row" style={{ marginBottom: 8 }}>
            <Icon name="shipped" size={16} />
            <b style={{ fontSize: 14 }}>每日完成数</b>
            <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>近 {days} 天</span>
            <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>合计 {dailyDone.reduce((s, p) => s + p.y, 0)}</span>
          </div>
          {loading ? <div className="muted" style={{ padding: 40, textAlign: 'center' }}><Icon name="loader" size={16} className="spin" /> 加载中…</div> : <LineChart points={dailyDone} color="#10b981" label="" />}
        </div>
      </div>

      {/* 柱状图区域 */}
      <div className="grid2" style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card card-pad">
          <BarChart label="业务模块 Top 10" items={(trends?.byModule || []).map((m) => ({ name: m.name, value: m.c }))} color="#8b5cf6" />
        </div>
        <div className="card card-pad">
          <BarChart label="优先级分布" items={(trends?.byPriority || []).map((p) => ({ name: p.p, value: p.c }))} color="#f59e0b" />
        </div>
      </div>

      {/* 企业分布 */}
      <div className="card card-pad" style={{ marginTop: 16 }}>
        <BarChart label="企业 / 客户需求分布 Top 10" items={(trends?.byCustomer || []).map((c) => ({ name: c.name, value: c.c }))} color="#0ea5e9" />
      </div>

      {/* 状态分布 */}
      <div className="card card-pad" style={{ marginTop: 16 }}>
        <BarChart label="状态分布" items={(trends?.byStatus || []).map((s) => ({ name: STATUS_LABEL[s.status] || s.status, value: s.c }))} color="#06b6d4" />
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  SUBMITTED: '已提交',
  AI_RUNNING: 'AI 处理中',
  PENDING: '待处理',
  CLARIFYING: '待澄清',
  AI_FAILED: 'AI 失败',
  DONE: '已完成',
  CANCELLED: '已取消',
};
