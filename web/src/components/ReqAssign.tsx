import React, { useEffect, useState } from 'react';
import { api, User, Requirement, ROLE_NAME, assignRequirement } from '../api';
import { useApp } from '../App';
import { Icon } from './Icon';
import { SearchSelect } from './SearchSelect';

/**
 * 产品指派研发/测试（契约 v2：POST /api/requirements/:id/assign，权限后端校验）。
 * 仅在产品负责人或 ADMIN 的详情页渲染（可见性由 ReqDetail 的 canAssign 控制）。
 */
export function ReqAssign({ req, onSaved, onGenerateJira }: { req: Requirement; onSaved: () => void; onGenerateJira?: () => void }) {
  const { toast } = useApp();
  const [users, setUsers] = useState<User[]>([]);
  const [rdSel, setRdSel] = useState(req.rd_id ? String(req.rd_id) : '');
  const [feSel, setFeSel] = useState(req.fe_id ? String(req.fe_id) : '');
  const [qaSel, setQaSel] = useState(req.qa_id ? String(req.qa_id) : '');
  const [jiraUrl, setJiraUrl] = useState(req.jira_url || '');
  const [jiraEditing, setJiraEditing] = useState(!req.jira_url);
  const [assigning, setAssigning] = useState(false);

  useEffect(() => { api.get('/api/users').then(setUsers).catch(() => {}); }, []);
  // 负责人轮询回显时保留用户尚未保存的选择。
  useEffect(() => {
    setRdSel((prev) => (prev === '' && req.rd_id ? String(req.rd_id) : prev));
    setFeSel((prev) => (prev === '' && req.fe_id ? String(req.fe_id) : prev));
    setQaSel((prev) => (prev === '' && req.qa_id ? String(req.qa_id) : prev));
  }, [req.rd_id, req.fe_id, req.qa_id]);

  // 已保存链接变化代表创建或保存成功，应替换旧草稿并退出编辑；普通轮询不触发，避免覆盖手动输入。
  useEffect(() => {
    setJiraUrl(req.jira_url || '');
    setJiraEditing(!req.jira_url);
  }, [req.jira_url]);

  const userOpts = (role: string) => [
    { value: '', label: '待指派' },
    ...users.filter((u) => u.role === role).map((u) => ({ value: u.id, label: u.name, subLabel: ROLE_NAME[u.role] })),
  ];

  const save = async () => {
    setAssigning(true);
    try {
      await assignRequirement(req.id, {
        rd_id: rdSel ? +rdSel : null,
        fe_id: feSel ? +feSel : null,
        qa_id: qaSel ? +qaSel : null,
        jira_url: (jiraEditing ? jiraUrl.trim() : req.jira_url) || null,
      });
      setJiraEditing(false);
      toast('指派与 Jira 链接已保存'); onSaved();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setAssigning(false); }
  };

  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <div className="section-title">指派后端 / 前端 / 测试</div>
      <div className="grid2 jira-assignment-owners" style={{ marginBottom: 10 }}>
        <div className="form-row" style={{ marginBottom: 0 }}><label>后端负责人</label>
          <SearchSelect options={userOpts('RD')} value={rdSel} onChange={(v) => setRdSel(String(v))} placeholder="待指派" /></div>
        <div className="form-row" style={{ marginBottom: 0 }}><label>前端负责人</label>
          <SearchSelect options={userOpts('FE')} value={feSel} onChange={(v) => setFeSel(String(v))} placeholder="待指派" /></div>
        <div className="form-row" style={{ marginBottom: 0 }}><label>测试负责人</label>
          <SearchSelect options={userOpts('QA')} value={qaSel} onChange={(v) => setQaSel(String(v))} placeholder="待指派" /></div>
      </div>
      <div className="form-row jira-assignment-field">
        <label htmlFor={jiraEditing || !req.jira_url ? 'assign-jira-url' : undefined}>Jira 链接或单号 *</label>
        {!jiraEditing && req.jira_url ? <div className="jira-assignment-value">
          {/^https?:\/\//i.test(req.jira_url) ? <a className="jira-assignment-link" href={req.jira_url} target="_blank" rel="noopener noreferrer" title={req.jira_url}>
            <Icon name="link" size={16} /><span>{req.jira_url}</span><Icon name="forward" size={16} />
          </a> : <span className="jira-assignment-plain">{req.jira_url}</span>}
          <button type="button" className="btn btn-sm" onClick={() => { setJiraUrl(req.jira_url || ''); setJiraEditing(true); }}><Icon name="edit" size={16} /> 修改</button>
        </div> : <div className="jira-assignment-value">
          <input id="assign-jira-url" className="input" value={jiraUrl} onChange={(e) => setJiraUrl(e.target.value)}
            placeholder="如 PINGTAI-11952 或完整 Jira 链接" />
          {req.jira_url && <button type="button" className="btn btn-sm" onClick={() => { setJiraUrl(req.jira_url || ''); setJiraEditing(false); }}>取消</button>}
        </div>}
        <div className="hint">产品节点需关联 Jira 后才能提交。</div>
      </div>
      <div className="jira-assignment-actions">
        {onGenerateJira && <button type="button" className="btn" onClick={onGenerateJira} title="根据需求和 PRD 一键创建 Jira">
          <Icon name="plus" size={16} /> 一键创建 Jira
        </button>}
        <button className="btn btn-primary" onClick={save} disabled={assigning}>
          <Icon name="check" size={16} /> {assigning ? '保存中…' : '保存指派'}
        </button>
      </div>
    </div>
  );
}
