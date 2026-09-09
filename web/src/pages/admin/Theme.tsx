import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { useApp } from '../../App';
import { applyTheme, resolveAccent } from '../../theme';

// 可选主题色板：Blueprint Calm 同族深色调，均可与白色文字达到 4.5:1 以上。
// 说明：这是「用户可选的数据」而非样式硬编码——默认值不在此列表里取，
// 而是由 resolveAccent() 从 design-tokens.css 的 --accent 读出。
const PRESETS = ['#0E62A8', '#1E3A5F', '#0F766E', '#12805C', '#5B6B7C', '#7C3F00', '#B45309', '#B3261E'];

export default function Theme() {
  const { theme, refreshTheme, toast } = useApp();
  const [primary, setPrimary] = useState(() => resolveAccent(theme.primary, theme.mode));
  const [mode, setMode] = useState(theme.mode);
  useEffect(() => { setPrimary(resolveAccent(theme.primary, theme.mode)); setMode(theme.mode); }, [theme]);

  const presets = PRESETS;
  const save = async () => {
    await api.put('/api/settings/theme', { primary, mode });
    await refreshTheme(); toast('主题已更新');
  };
  // 实时预览（与 App 落地逻辑一致：等于 Token 默认值时交还给 Token 级联）
  useEffect(() => { applyTheme(primary, mode); }, [primary, mode]);

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="crumb">管理后台</div>
          <h1>外观主题</h1>
        </div>
      </div>
      <div className="card card-pad" style={{ maxWidth: 560 }}>
      <b>界面外观</b>
      <div className="form-row" style={{ marginTop: 14 }}>
        <label>主题色</label>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {presets.map((c) => (
            <button key={c} onClick={() => setPrimary(c)}
              aria-label={`主题色 ${c}`} aria-pressed={primary.toLowerCase() === c.toLowerCase()}
              title={c}
              style={{
                width: 34, height: 34, borderRadius: 'var(--radius-sm)', background: c,
                border: primary.toLowerCase() === c.toLowerCase() ? '3px solid var(--text)' : '2px solid transparent',
              }} />
          ))}
          {/* 取色器：Token 读取失败时不渲染受控空值，避免非法 color input */}
          {primary && (
            <input type="color" value={primary} aria-label="自定义主题色"
              onChange={(e) => setPrimary(e.target.value)}
              style={{ width: 34, height: 34, border: 'none', background: 'none', padding: 0 }} />
          )}
        </div>
      </div>
      <div className="form-row">
        <label>模式</label>
        <div className="row">
          {[['light', '浅色'], ['dark', '深色']].map(([m, label]) => (
            <button key={m} className={`btn ${mode === m ? 'btn-primary' : ''}`} onClick={() => setMode(m)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="form-row">
        <label>预览</label>
        <div className="row">
          <button className="btn btn-primary">主要按钮</button>
          <span className="tag tag-blue">标签</span>
          <div className="step cur"><span className="dot" /><span className="ai-badge">AI</span>节点</div>
        </div>
      </div>
      <button className="btn btn-primary" onClick={save}>保存</button>
      </div>
    </div>
  );
}
