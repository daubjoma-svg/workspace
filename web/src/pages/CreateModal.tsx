import React, { useEffect, useState } from 'react';
import { api, User, ROLE_NAME } from '../api';
import { useApp } from '../App';
import { Icon } from '../components/Icon';
import { SearchSelect } from '../components/SearchSelect';
import { ModuleSelect } from '../components/ModuleSelect';
import { CustomerInput } from '../components/CustomerInput';
import { VersionInput, isValidTargetVersion } from '../components/VersionInput';
import { RichTextEditor } from '../components/rich/RichTextEditor';
import { isEmptyHtml } from '../lib/sanitize';

export default function CreateModal({ onClose, onDone }: { onClose: () => void; onDone: (id: number) => void }) {
  const { toast } = useApp();
  const [users, setUsers] = useState<User[]>([]);
  const [customers, setCustomers] = useState<string[]>([]);
  const [selModules, setSelModules] = useState<number[]>([]);
  // 契约 v2：创建需求只选产品负责人 + 目标版本，研发/测试由产品在详情页指派
  const [form, setForm] = useState({ title: '', description: '', customer_name: '', priority: 'P2', target_version: '', po_id: '' });
  /** 提交进行中：按钮置 busy+loading 文案，禁用避免重复点击（submit 端点可能等 LLM 较久） */
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    api.get('/api/users').then(setUsers).catch(() => {});
    api.get('/api/customer-names').then(setCustomers).catch(() => {});
  }, []);

  const byRole = (r: string) => users.filter((u) => u.role === r);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (submitting) return;
    if (!form.title || isEmptyHtml(form.description)) return toast('请填写标题与描述');
    if (!form.po_id) return toast('请选择对接产品');
    // 后端 validTargetVersion 校验：target_version 必填且格式受限（示例 26M8V1）
    if (!form.target_version.trim()) return toast('请填写目标版本');
    if (!isValidTargetVersion(form.target_version)) return toast('目标版本格式不正确，示例：26M8V1（26年8月V1版）');
    setSubmitting(true);
    try {
      const r = await api.post('/api/requirements', {
        title: form.title,
        description: form.description,
        customer_name: form.customer_name,
        priority: form.priority,
        target_version: form.target_version.trim(),
        po_id: +form.po_id,
        module_ids: selModules,
      });
      // submit 端点 v0.7 改造后 fire-and-forget：AI 节点后台跑，submit 几 ms 返回
      // （不阻塞，但前端保持 awaiting 以兼容后端可能仍有同步路径）
      await api.post(`/api/requirements/${r.id}/submit`);
      onDone(r.id);
    } catch (e: any) { toast(e.message); }
    finally { setSubmitting(false); }
  };

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
            <RichTextEditor value={form.description} onChange={(v) => set('description', v)} minRows={4} placeholder="业务场景 / 期望效果 / 边界条件…" /></div>
          <div className="grid2">
            <div className="form-row"><label>客户名称</label>
              <CustomerInput value={form.customer_name} onChange={(v) => set('customer_name', v)} options={customers} /></div>
            <div className="form-row"><label>紧急度</label>
              <SearchSelect
                options={['P0', 'P1', 'P2', 'P3'].map((p) => ({ value: p, label: p }))}
                value={form.priority}
                onChange={(v) => set('priority', String(v))}
                placeholder="请选择紧急度"
              /></div>
          </div>
          <div className="form-row"><label>目标版本 *</label>
            <VersionInput value={form.target_version} onChange={(v) => set('target_version', v)} /></div>
          <div className="form-row">
            <label>涉及平台模块（前端 / 后端，均可选；AI 评审将读取对应代码）</label>
            <ModuleSelect selected={selModules} onChange={setSelModules} />
          </div>
          <div className="form-row">
            <label>对接产品 *</label>
            <SearchSelect
              options={[{ value: '', label: '请选择' }, ...byRole('PO').map((u) => ({ value: u.id, label: u.name, subLabel: ROLE_NAME[u.role] }))]}
              value={form.po_id}
              onChange={(v) => set('po_id', String(v))}
              placeholder="请选择"
            />
            <div className="hint">研发/测试负责人由产品在需求详情页指派</div>
          </div>
        </div>
        <div className="modal-f">
          <button className="btn" onClick={onClose} disabled={submitting}>取消</button>
          <button className="btn btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? <><Icon name="loader" size={16} /> 提交中…</> : '提交并进入流程'}
          </button>
        </div>
      </div>
    </div>
  );
}
