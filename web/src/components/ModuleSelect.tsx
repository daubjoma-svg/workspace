import React, { useEffect, useState } from 'react';
import { api, PublicBusinessModule } from '../api';

interface ModuleSelectProps {
  selected: number[];
  onChange: (ids: number[]) => void;
}

/** 平台模块多选（创建 / 编辑需求共用；从 CreateModal 抽出） */
export function ModuleSelect({ selected, onChange }: ModuleSelectProps) {
  const [modules, setModules] = useState<PublicBusinessModule[]>([]);
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
  return (
    <div className="chip-group">
      {modules.map((m) => (
        <button type="button" key={m.id}
          className={`chip ${selected.includes(m.id) ? 'on' : ''}`}
          onClick={() => toggle(m.id)} title={m.description || m.name}>
          {m.name}
        </button>
      ))}
    </div>
  );
}
