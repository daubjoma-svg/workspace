import React, { useEffect, useState } from 'react';
import { api, PublicBusinessModule } from '../api';

interface ModuleSelectProps {
  selected: number[];
  onChange: (ids: number[]) => void;
}

/** 平台模块多选（创建 / 编辑需求共用；从 CreateModal 抽出） */
export function ModuleSelect({ selected, onChange }: ModuleSelectProps) {
  const [modules, setModules] = useState<PublicBusinessModule[]>([]);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  useEffect(() => {
    api.get('/api/business-modules-public').then(setModules).catch(() => {});
  }, []);

  const toggle = (id: number) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  if (modules.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 12, padding: '8px 0' }}>
        管理员尚未配置平台模块，可不选；配置后 AI 将基于真实代码评估。
      </div>
    );
  }
  const groups = [['FRONTEND', '前端模块'], ['BACKEND', '后端模块']] as const;
  return <div>{groups.map(([type, label]) => {
    const items = modules.filter((m) => m.type === type);
    if (!items.length) return null;
    return <div key={type} style={{ marginBottom: 8 }}><div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{label}（可选）</div><div className="chip-group">
      {items.map((m) => (
        <span key={m.id} style={{ position: 'relative', display: 'inline-flex' }}
          onMouseEnter={() => setHoveredId(m.id)} onMouseLeave={() => setHoveredId(null)}>
          <button type="button"
            className={`chip ${selected.includes(m.id) ? 'on' : ''}`}
            onClick={() => toggle(m.id)} title={m.description || m.name}
            aria-describedby={m.description ? `module-note-${m.id}` : undefined}>
            {m.name}
          </button>
          {hoveredId === m.id && m.description && (
            <span id={`module-note-${m.id}`} role="tooltip" style={{
              position: 'absolute', zIndex: 1000, left: 0, bottom: 'calc(100% + 6px)',
              width: 260, padding: '8px 10px', borderRadius: 6,
              background: '#1f2937', color: '#ffffff', border: '1px solid #374151', fontSize: 12,
              lineHeight: 1.5, whiteSpace: 'normal', boxShadow: 'var(--shadow-md, 0 4px 12px rgba(0,0,0,.18))',
              pointerEvents: 'none',
            }}>{m.description}</span>
          )}
        </span>
      ))}</div></div>;
  })}</div>;
}
