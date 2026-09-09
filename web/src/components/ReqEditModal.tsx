import React, { useEffect, useState } from 'react';
import { api, User, Requirement, UpdateRequirementBody, updateRequirement, ROLE_NAME } from '../api';
import { useApp } from '../App';
import { Icon } from '../components/Icon';
import { SearchSelect } from '../components/SearchSelect';
import { ModuleSelect } from './ModuleSelect';
import { VersionInput, isValidTargetVersion } from '../components/VersionInput';
import { RichTextEditor } from './rich/RichTextEditor';
import { isEmptyHtml } from '../lib/sanitize';

interface ReqEditModalProps {
  req: Requirement;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * 需求编辑弹窗（复用 CreateModal 表单布局）。
 * 契约 v2：DRAFT 全字段可改；非 DRAFT 仅 description/customer_name/priority/target_version/module_ids
 * 可改（title/产品负责人禁用 + 提示，后端 400 硬兜底）；研发/测试由产品在详情页 /assign 指派，编辑弹窗不再提供；
 * DONE/CANCELLED 由入口隐藏。
 */
export function ReqEditModal({ req, onClose, onSaved }: ReqEditModalProps) {
  const { toast } = useApp();
  const isDraft = req.status === 'DRAFT';
  const [users, setUsers] = useState<User[]>([]);
  const [selModules, setSelModules] = useState<number[]>([]);
  const [form, setForm] = useState({
    title: req.title,
    description: req.description,
    customer_name: req.customer_name,
    priority: req.priority,
    target_version: req.target_version || '',
    jira_url: req.jira_url || '',
    po_id: req.po_id ? String(req.po_id) : '',
  });

  useEffect(() => {
    api.get('/api/users').then(setUsers).catch(() => {});
    // v0.7：modules 是 (业务模块 × 仓库) 笛卡尔积；去重得业务模块 id
    setSelModules(Array.from(new Set((req.modules || []).map((m) => m.business_module_id))));
  }, [req]);

  const byRole = (r: string) => users.filter((u) => u.role === r);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (isEmptyHtml(form.description)) return toast('请填写需求描述');
    // target_version 非空才提交（后端仅在校验通过时更新；留空 = 不修改，避免历史单无版本时编辑报 400）
    if (form.target_version.trim() && !isValidTargetVersion(form.target_version)) {
      return toast('目标版本格式不正确，示例：26M8V1（26年8月V1版）');
    }
    // Jira 链接：可选；非空则必须是 http(s) 开头
    const jiraUrl = form.jira_url.trim();
    if (jiraUrl && !/^https?:\/\//i.test(jiraUrl)) {
      return toast('Jira 链接必须以 http:// 或 https:// 开头');
    }
    const body: UpdateRequirementBody = {
      description: form.description,
      customer_name: form.customer_name,
      priority: form.priority,
      module_ids: selModules,
      jira_url: jiraUrl || null,
    };
    if (form.target_version.trim()) body.target_version = form.target_version.trim();
    if (isDraft) {
      if (!form.title.trim()) return toast('请填写需求标题');
      body.title = form.title;
      body.po_id = form.po_id ? +form.po_id : null;
    }
    try {
      await updateRequirement(req.id, body);
      toast('需求已更新'); onSaved();
    } catch (e: any) { toast(e.message); }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          {isDraft ? '编辑需求' : '编辑需求（已提交流程，部分字段不可改）'}
          <button className="btn btn-sm btn-icon" onClick={onClose} aria-label="关闭编辑弹窗">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal-b">
          <div className="form-row">
            <label>需求标题 *</label>
            <input className="input" value={form.title} disabled={!isDraft} onChange={(e) => set('title', e.target.value)} />
            {!isDraft && <div className="hint">已提交流程，不可修改</div>}
          </div>
          <div className="form-row"><label>需求描述 *（建议包含：业务场景 / 期望效果 / 边界条件）</label>
            <RichTextEditor value={form.description} onChange={(v) => set('description', v)} minRows={4} placeholder="业务场景 / 期望效果 / 边界条件…" /></div>
          <div className="grid2">
            <div className="form-row"><label>客户名称</label>
              <input className="input" value={form.customer_name} onChange={(e) => set('customer_name', e.target.value)} /></div>
            <div className="form-row"><label>紧急度</label>
              <SearchSelect
                options={['P0', 'P1', 'P2', 'P3'].map((p) => ({ value: p, label: p }))}
                value={form.priority}
                onChange={(v) => set('priority', String(v))}
                placeholder="请选择紧急度"
              /></div>
          </div>
          <div className="form-row"><label>目标版本</label>
            <VersionInput value={form.target_version} onChange={(v) => set('target_version', v)} />
            <div className="hint">留空表示保持原版本；格式：YYM月版本，如 26M8V1</div></div>
          <div className="form-row"><label>Jira 链接</label>
            <input className="input" value={form.jira_url} onChange={(e) => set('jira_url', e.target.value)}
              placeholder="https://jira.xxx/browse/PINGTAI-11880" />
            <div className="hint">关联 Jira 单后，列表会显示单号（如 PINGTAI-11880）并可点击跳转；清空即可取消关联</div></div>
          <div className="form-row"><label>涉及平台模块</label>
            <ModuleSelect selected={selModules} onChange={setSelModules} /></div>
          <div className="form-row">
            <label>对接产品</label>
            <SearchSelect
              options={[{ value: '', label: '请选择' }, ...byRole('PO').map((u) => ({ value: u.id, label: u.name, subLabel: ROLE_NAME[u.role] }))]}
              value={form.po_id}
              disabled={!isDraft}
              onChange={(v) => set('po_id', String(v))}
              placeholder="请选择"
            />
            {!isDraft && <div className="hint">已提交流程，产品负责人不可修改</div>}
          </div>
          <div className="hint">研发/测试负责人在需求详情页由产品指派</div>
        </div>
        <div className="modal-f">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={submit}>保存修改</button>
        </div>
      </div>
    </div>
  );
}
