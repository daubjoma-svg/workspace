import React, { useState } from 'react';
import { api, User } from '../api';
import { useApp } from '../App';

const FLOW = [
  { n: '01', t: 'CSM 提交需求', d: '客户视角一句话说清,选择涉及的平台模块' },
  { n: '02', t: 'AI 评估定级', d: '结合真实代码做可行性分析 · L1–L4 定级' },
  { n: '03', t: '产品生成 PRD', d: 'AI 起草 + 产品修订,版本留痕' },
  { n: '04', t: '研发提示词', d: '注入代码片段,生成可执行的实现指引' },
  { n: '05', t: '测试与验收', d: 'AI 生成用例,测试回流验收' },
];

export default function Login({ onLogin }: { onLogin: (u: User, token: string) => void }) {
  const { toast } = useApp();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [loading, setLoading] = useState(false);

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
      <section className="login-hero">
        <div className="h-brand">
          <div className="logo">S</div>
          AI · SOP
        </div>

        <div>
          <h2>把客户的一句话需求<br />变成可交付的 PRD 与代码</h2>
          <p className="lede">
            为 CSM / 产品 / 研发 / 测试打造的需求协作流水线。AI 全程参与评估、撰写与提示词生成，让简单需求即刻排期、复杂需求彻底想清楚。
          </p>
          <div className="flow">
            {FLOW.map((f) => (
              <div className="f-item" key={f.n}>
                <div className="f-num">{f.n}</div>
                <div className="f-txt">
                  <b>{f.t}</b>
                  <span>{f.d}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="h-foot">© 2026 · Requirement Delivery Platform</div>
      </section>

      <section className="login-panel">
        <div className="login-box">
          <h1>欢迎回来</h1>
          <p className="sub">使用工作账号登录，进入你所属角色的工作台</p>

          <form onSubmit={submit} className="stack">
            <div className="form-row" style={{ marginBottom: 0 }}>
              <label>用户名</label>
              <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
            </div>
            <div className="form-row" style={{ marginBottom: 0 }}>
              <label>密码</label>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </div>
            <button className="btn btn-primary btn-lg btn-block" disabled={loading}>
              {loading ? '登录中…' : '登 录'}
            </button>
          </form>

          <div className="demo">
            <b style={{ fontWeight: 700, color: 'var(--text)' }}>演示账号</b><br />
            管理员 <code>admin / admin123</code><br />
            CSM <code>csm01</code> · 产品 <code>po01</code> · 研发 <code>rd01</code> · 测试 <code>qa01</code>（密码均为 <code>123456</code>）
          </div>
        </div>
      </section>
    </div>
  );
}
