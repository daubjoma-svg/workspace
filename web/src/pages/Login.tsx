import React, { useState, useEffect, useRef } from 'react';
import { api, User } from '../api';
import { useApp } from '../App';

/* ── SOP 七段管线
 * n1 和 n7 cy 相同（水平对齐），中间 5 个节点沿上下对称波浪起伏；
 * 节点整体居于画布上半（cy=100~230），底部 y=240 以下留给左下角文案；
 * 外环 r=22、内圆 r=16、strokeWidth=2、光点 r=9+4；
 * 编号 13px mono / 标签 12px / desc 10px mono；viewBox=800×360。 */
const PIPE_NODES = [
  { id: 'n1', cx: 110, cy: 230, code: '01', label: '需求提交',   desc: '客户视角' },
  { id: 'n2', cx: 210, cy: 100, code: '02', label: '完整性预检', desc: 'AI 检查' },
  { id: 'n3', cx: 310, cy: 230, code: '03', label: '需求评估',   desc: 'L1–L4 定级' },
  { id: 'n4', cx: 410, cy: 100, code: '04', label: 'PRD 生成',  desc: 'AI 起草' },
  { id: 'n5', cx: 510, cy: 230, code: '05', label: '研发提示词', desc: '代码指引' },
  { id: 'n6', cx: 610, cy: 100, code: '06', label: '测试用例',   desc: '用例生成' },
  { id: 'n7', cx: 700, cy: 230, code: '07', label: '交付验收',   desc: '上线' },
];
const PIPE_EDGES = [
  { id: 'e1', d: 'M 130,214 C 150,180 170,130 192,116', delay: 0    },
  { id: 'e2', d: 'M 228,116 C 250,145 270,190 292,214', delay: 0.14 },
  { id: 'e3', d: 'M 328,214 C 348,180 370,130 392,116', delay: 0.28 },
  { id: 'e4', d: 'M 428,116 C 450,145 470,190 492,214', delay: 0.42 },
  { id: 'e5', d: 'M 528,214 C 548,180 570,130 592,116', delay: 0.56 },
  { id: 'e6', d: 'M 628,116 C 650,145 670,190 682,214', delay: 0.7  },
];

/* ── 注册表单 ── */
const REGISTER_ROLES: { value: 'CSM' | 'PO' | 'RD' | 'FE' | 'QA'; label: string }[] = [
  { value: 'CSM', label: '需求发起人' },
  { value: 'PO', label: '产品' },
  { value: 'RD', label: '后端' },
  { value: 'FE', label: '前端' },
  { value: 'QA', label: '测试' },
];

export function RegisterForm({ onLogin }: { onLogin: (u: User, token: string) => void }) {
  const { toast } = useApp();
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [feishuKey, setFeishuKey] = useState('');
  const [role, setRole] = useState<'CSM' | 'PO' | 'RD' | 'QA' | 'FE'>('CSM');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !username.trim() || !password) return toast('请填写姓名、登录名与密码');
    setLoading(true);
    try {
      const r = await api.post('/api/auth/register', {
        username: username.trim(),
        password,
        name: name.trim(),
        role,
        ...(feishuKey.trim() ? { feishu_key: feishuKey.trim() } : {}),
      });
      onLogin(r.user, r.token);
    } catch (err: any) { toast(err.message); }
    finally { setLoading(false); }
  };

  return (
    <form onSubmit={submit} className="stack">
      <div className="form-row" style={{ marginBottom: 0 }}>
        <label>姓名</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="你的姓名" autoComplete="name" />
      </div>
      <div className="form-row" style={{ marginBottom: 0 }}>
        <label>角色</label>
        <div className="seg-tabs" style={{ display: 'flex', width: '100%', marginTop: 6 }} role="radiogroup" aria-label="注册角色">
          {REGISTER_ROLES.map((r) => (
            <button key={r.value} type="button"
              className={`seg-tab ${role === r.value ? 'on' : ''}`}
              role="radio" aria-checked={role === r.value}
              onClick={() => setRole(r.value)}
              style={{ flex: 1 }}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="form-row" style={{ marginBottom: 0 }}>
        <label>登录名</label>
        <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="用于登录的唯一账号" autoComplete="username" />
      </div>
      <div className="form-row" style={{ marginBottom: 0 }}>
        <label>密码</label>
        <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="设置登录密码" autoComplete="new-password" />
      </div>
      <div className="form-row" style={{ marginBottom: 0 }}>
        <label>飞书 user_id 或邮箱（选填）</label>
        <input className="input" value={feishuKey} onChange={(e) => setFeishuKey(e.target.value)} placeholder="如 ou_xxx 或 n***@************" autoComplete="off" />
        <div className="hint">选填。填写后，需求流转到你负责的节点时将通过飞书应用发消息提醒</div>
      </div>
      <button className="btn btn-primary btn-lg btn-block" disabled={loading}>
        {loading ? '注册中…' : '注 册'}
      </button>
    </form>
  );
}

/* ── 蓝图画布：工程网格 + SOP 七段蛇形管线（原5节点视觉规格） ── */
function BlueprintCanvas() {
  const [elapsed, setElapsed] = useState(0);
  const rafRef = useRef<number>(0);
  const startRef = useRef<number>(0);

  useEffect(() => {
    const tick = (t: number) => {
      if (!startRef.current) startRef.current = t;
      setElapsed(t - startRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const pulse = (elapsed % 7000) / 7000;
  const total = PIPE_NODES.length;
  const VB_W = 800, VB_H = 360;

  return (
    <svg className="bp-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="xMaxYMid meet" aria-hidden="true">
      <defs>
        <pattern id="grid-fine" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" />
        </pattern>
        <pattern id="grid-coarse" width="100" height="100" patternUnits="userSpaceOnUse">
          <path d="M 100 0 L 0 0 0 100" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="0.8" />
        </pattern>
        <radialGradient id="pulse-grad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.9)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
      </defs>
      <rect width={VB_W} height={VB_H} fill="url(#grid-fine)" />
      <rect width={VB_W} height={VB_H} fill="url(#grid-coarse)" />

      {/* 游标卡尺刻度 */}
      <g stroke="rgba(255,255,255,0.18)" strokeWidth="0.8">
        {Array.from({ length: Math.ceil(VB_W / 50) + 1 }, (_, i) => (
          <line key={`xt${i}`} x1={i * 50} y1={0} x2={i * 50} y2={i % 2 === 0 ? 10 : 5} />
        ))}
        {Array.from({ length: Math.ceil(VB_H / 50) + 1 }, (_, i) => (
          <line key={`yt${i}`} x1={0} y1={i * 50} x2={i % 2 === 0 ? 10 : 5} y2={i * 50} />
        ))}
      </g>

      {/* 管线底色 + 流动光点 */}
      {PIPE_EDGES.map((e) => {
        const p = (((pulse - e.delay) % 1) + 1) % 1;
        return (
          <g key={e.id}>
            <path d={e.d} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="2" strokeLinecap="round" />
            <circle r="9" fill="url(#pulse-grad)" style={{ offsetPath: `path('${e.d}')`, offsetDistance: `${p * 100}%` } as React.CSSProperties} />
            <circle r="4" fill="rgba(255,255,255,0.9)" style={{ offsetPath: `path('${e.d}')`, offsetDistance: `${p * 100}%` } as React.CSSProperties} />
          </g>
        );
      })}

      {/* 节点 */}
      {PIPE_NODES.map((n, i) => {
        const isEnd = i === total - 1;
        const lit = Math.min(1, Math.max(0, (pulse * total - i * 0.13) * 1.1));
        return (
          <g key={n.id} style={{ opacity: 0.55 + 0.45 * lit }}>
            <circle cx={n.cx} cy={n.cy} r="22" fill="none"
              stroke={`rgba(255,255,255,${0.25 + 0.25 * lit})`}
              strokeWidth="1.5" strokeDasharray="4 3" />
            <circle cx={n.cx} cy={n.cy} r="16"
              fill={isEnd ? `rgba(127,219,255,${0.1 + 0.15 * lit})` : `rgba(255,255,255,${0.06 + 0.08 * lit})`}
              stroke={isEnd ? `rgba(127,219,255,${0.6 + 0.3 * lit})` : `rgba(255,255,255,${0.5 + 0.3 * lit})`}
              strokeWidth="1.5" />
            <text x={n.cx} y={n.cy + 1} textAnchor="middle" dominantBaseline="middle"
              fill={isEnd ? '#7FDBFF' : 'rgba(255,255,255,0.95)'}
              fontSize="13" fontFamily="var(--font-mono)" fontWeight="590">{n.code}</text>
            <text x={n.cx} y={n.cy + 38} textAnchor="middle" fill="rgba(255,255,255,0.88)"
              fontSize="12" fontWeight="510" letterSpacing="0.02em">{n.label}</text>
            <text x={n.cx} y={n.cy + 54} textAnchor="middle" fill="rgba(255,255,255,0.42)"
              fontSize="10" fontFamily="var(--font-mono)">{n.desc}</text>
          </g>
        );
      })}

      {/* 四角图框标记 */}
      {[[8, 8], [VB_W - 8, 8], [8, VB_H - 8], [VB_W - 8, VB_H - 8]].map(([x, y], i) => (
        <g key={i}>
          <line x1={x} y1={y} x2={x + (i % 2 === 0 ? 24 : -24)} y2={y} stroke="rgba(255,255,255,0.25)" strokeWidth="1" />
          <line x1={x} y1={y} x2={x} y2={y + (i < 2 ? 24 : -24)} stroke="rgba(255,255,255,0.25)" strokeWidth="1" />
        </g>
      ))}
    </svg>
  );
}

export default function Login({ onLogin }: { onLogin: (u: User, token: string) => void }) {
  const { toast } = useApp();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const r = await api.post('/api/auth/login', { username, password });
      onLogin(r.user, r.token);
    } catch (err: any) { toast(err.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="login-wrap">
      {/* ── 左侧：蓝图英雄区 ── */}
      <section className="login-hero">
        <div className="bp-bleed" />
        <BlueprintCanvas />

        <div className="hero-content">
          <div className="h-brand">
            <div className="logo-mark">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
                <rect x="1" y="1" width="20" height="20" rx="4" stroke="currentColor" strokeWidth="1.5" />
                <line x1="7" y1="1" x2="7" y2="21" stroke="currentColor" strokeWidth="0.8" strokeDasharray="2 2" opacity="0.4" />
                <line x1="15" y1="1" x2="15" y2="21" stroke="currentColor" strokeWidth="0.8" strokeDasharray="2 2" opacity="0.4" />
                <circle cx="11" cy="11" r="3" fill="currentColor" />
              </svg>
            </div>
            <span className="brand-name">AI · SOP</span>
            <span className="brand-ver">v1.1</span>
          </div>

          <div className="hero-copy">
            <h1 className="hero-title">需求交付-AI-SOP</h1>
            <p className="hero-sub">requirement to delivery, powered by AI.</p>
            <p className="hero-lede">
              从一句话到可交付方案，<br />
              让 AI 替你走完评估、起草、<br />
              研发指引与测试的每一步。
            </p>
          </div>

          <div className="h-foot">
            <span className="foot-mono">BLUEPRINT-CALM</span>
            <span className="foot-dot" />
            <span>© 2026 RDP</span>
          </div>
        </div>
      </section>

      {/* ── 右侧：表单区 ── */}
      <section className="login-panel">
        <div className="login-box">
          <div className="seg-tabs auth-tabs" role="tablist" aria-label="登录或注册">
            <button type="button" className={`seg-tab ${mode === 'login' ? 'on' : ''}`} role="tab" aria-selected={mode === 'login'} onClick={() => setMode('login')}>登 录</button>
            <button type="button" className={`seg-tab ${mode === 'register' ? 'on' : ''}`} role="tab" aria-selected={mode === 'register'} onClick={() => setMode('register')}>注 册</button>
          </div>

          {mode === 'login' ? (
            <div className="auth-fade-in">
              <h2 className="auth-title">欢迎回来</h2>
              <p className="auth-sub">进入你的工作台</p>

              <form onSubmit={submit} className="stack auth-form">
                <div className="form-row auth-field" data-focused={focusedField === 'u' || undefined}>
                  <label>用户名</label>
                  <input
                    className="input"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    onFocus={() => setFocusedField('u')}
                    onBlur={() => setFocusedField(null)}
                    autoFocus
                    autoComplete="username"
                    placeholder="输入你的账号"
                  />
                </div>
                <div className="form-row auth-field" data-focused={focusedField === 'p' || undefined}>
                  <label>密码</label>
                  <input
                    className="input"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onFocus={() => setFocusedField('p')}
                    onBlur={() => setFocusedField(null)}
                    autoComplete="current-password"
                    placeholder="输入密码"
                  />
                </div>
                <button className={`btn btn-primary btn-lg btn-block auth-submit ${loading ? 'is-loading' : ''}`} disabled={loading}>
                  {loading ? (
                    <>
                      <svg className="spin" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="20 10" strokeLinecap="round" />
                      </svg>
                      验证中…
                    </>
                  ) : '登 录'}
                </button>
              </form>
            </div>
          ) : (
            <div className="auth-fade-in">
              <h2 className="auth-title">创建账号</h2>
              <p className="auth-sub">选择你的角色，注册后进入对应工作台</p>
              <RegisterForm onLogin={onLogin} />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
