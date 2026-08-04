import React, { useEffect, useState } from 'react';
import { api, User, PlatformModule } from '../api';
import { useApp } from '../App';
import { Icon } from '../components/Icon';

export default function CreateModal({ onClose, onDone }: { onClose: () => void; onDone: (id: number) => void }) {
  const { toast } = useApp();
  const [users, setUsers] = useState<User[]>([]);
  const [modules, setModules] = useState<PlatformModule[]>([]);
  const [selModules, setSelModules] = useState<number[]>([]);
  const [form, setForm] = useState({ title: '', description: '', customer_name: '', priority: 'P2', expect_date: '', po_id: '', rd_id: '', qa_id: '' });
  useEffect(() => { api.get('/api/users').then(setUsers); api.get('/api/platform-modules').then(setModules); }, []);

  const byRole = (r: string) => users.filter((u) => u.role === r);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const toggleModule = (id: number) => setSelModules((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);

  const submit = async () => {
    if (!form.title || !form.description) return toast('请填写标题与描述');
    try {
      const r = await api.post('/api/requirements', {
        ...form,
        po_id: form.po_id ? +form.po_id : null,
        rd_id: form.rd_id ? +form.rd_id : null,
        qa_id: form.qa_id ? +form.qa_id : null,
        module_ids: selModules,
      });
      await api.post(`/api/requirements/${r.id}/submit`);
      onDone(r.id);
    } catch (e: any) { toast(e.message); }
  };

  const RoleSelect = ({ k, role, label }: { k: string; role: string; label: string }) => (
    <div className="form-row">
      <label>{label}</label>
      <select className="input" value={(form as any)[k]} onChange={(e) => set(k, e.target.value)}>
        <option value="">请选择</option>
        {byRole(role).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
    </div>
  );

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          提交需求
          <button className="btn btn-sm btn-icon" onClick={onClose} aria-label="关闭提交需求弹窗">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal-b">
          <div className="form-row"><label>需求标题 *</label>
            <input className="input" value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="一句话描述需求" /></div>
          <div className="form-row"><label>需求描述 *（建议包含：业务场景 / 期望效果 / 边界条件）</label>
            <textarea className="input" rows={5} value={form.description} onChange={(e) => set('description', e.target.value)} /></div>
          <div className="grid2">
            <div className="form-row"><label>客户名称</label>
              <input className="input" value={form.customer_name} onChange={(e) => set('customer_name', e.target.value)} /></div>
            <div className="form-row"><label>紧急度</label>
              <select className="input" value={form.priority} onChange={(e) => set('priority', e.target.value)}>
                {['P0', 'P1', 'P2', 'P3'].map((p) => <option key={p}>{p}</option>)}
              </select></div>
          </div>
          <div className="form-row"><label>期望上线时间</label>
            <input className="input" type="date" value={form.expect_date} onChange={(e) => set('expect_date', e.target.value)} /></div>
          <div className="form-row">
            <label>涉及平台模块(AI 评审将读取对应代码)</label>
            {modules.length === 0
              ? <div className="muted" style={{ fontSize: 12, padding: '8px 0' }}>管理员尚未配置平台模块,可不选;配置后 AI 将基于真实代码评估。</div>
              : (
                <div className="chip-group">
                  {modules.map((m) => (
                    <button type="button" key={m.id}
                      className={`chip ${selModules.includes(m.id) ? 'on' : ''}`}
                      onClick={() => toggleModule(m.id)} title={m.code_module_name}>
                      {m.platform_name}
                      {m.sync_status === 'OK' && <span className="chip-dot" />}
                    </button>
                  ))}
                </div>
              )}
          </div>
          <div className="grid3">
            <RoleSelect k="po_id" role="PO" label="对接产品 *" />
            <RoleSelect k="rd_id" role="RD" label="对接研发 *" />
            <RoleSelect k="qa_id" role="QA" label="对接测试 *" />
          </div>
        </div>
        <div className="modal-f">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={submit}>提交并进入流程</button>
        </div>
      </div>
    </div>
  );
}
