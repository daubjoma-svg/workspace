import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { useApp } from '../../App';

export default function AiProviders() {
  const { toast } = useApp();
  const [list, setList] = useState<any[]>([]);
  const [form, setForm] = useState({ name: '', type: 'openai-compat', base_url: '', api_key: '', model: '' });
  const load = () => api.get('/api/admin/ai-providers').then(setList);
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!form.name) return toast('请填名称');
    await api.post('/api/admin/ai-providers', { ...form, enabled: true });
    setForm({ name: '', type: 'openai-compat', base_url: '', api_key: '', model: '' });
    load(); toast('已添加并启用');
  };
  const enable = async (id: number) => { await api.put(`/api/admin/ai-providers/${id}`, { enabled: true }); load(); };
  const del = async (id: number) => { await api.del(`/api/admin/ai-providers/${id}`); load(); };

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="crumb">管理后台</div>
          <h1>AI 配置</h1>
        </div>
      </div>
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <b>接入 LLM（不配置则使用内置 Mock，离线可演示）</b>
        <div className="grid2" style={{ marginTop: 12 }}>
          <div className="form-row"><label>名称</label>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如 Claude / Kimi" /></div>
          <div className="form-row"><label>类型</label>
            <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="openai-compat">OpenAI 兼容（OpenAI/Kimi/DeepSeek…）</option>
              <option value="anthropic">Anthropic Claude</option>
              <option value="mock">Mock</option>
            </select></div>
          <div className="form-row"><label>Base URL</label>
            <input className="input" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://api.moonshot.cn" /></div>
          <div className="form-row"><label>Model</label>
            <input className="input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="moonshot-v1-8k" /></div>
          <div className="form-row" style={{ gridColumn: '1 / -1' }}><label>API Key</label>
            <input className="input" type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} /></div>
        </div>
        <button className="btn btn-primary" onClick={add}>添加并启用</button>
      </div>
      <div className="card">
        <table className="tbl">
          <thead><tr><th>名称</th><th>类型</th><th>Base URL</th><th>Model</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td><td className="muted">{p.type}</td>
                <td className="muted">{p.base_url || '—'}</td><td className="muted">{p.model || '—'}</td>
                <td>{p.enabled ? <span className="tag tag-green">启用中</span> : <span className="tag tag-grey">停用</span>}</td>
                <td className="row">
                  {!p.enabled && <button className="btn btn-sm" onClick={() => enable(p.id)}>启用</button>}
                  <button className="btn btn-sm btn-danger" onClick={() => del(p.id)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
