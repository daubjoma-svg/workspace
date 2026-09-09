import React, { useEffect, useState } from 'react';
import { api, User, Requirement, ROLE_NAME, assignRequirement } from '../api';
import { useApp } from '../App';
import { Icon } from './Icon';
import { SearchSelect } from './SearchSelect';

/**
 * 产品指派研发/测试（契约 v2：POST /api/requirements/:id/assign，权限后端校验）。
 * 仅在产品负责人或 ADMIN 的详情页渲染（可见性由 ReqDetail 的 canAssign 控制）。
 */
export function ReqAssign({ req, onSaved }: { req: Requirement; onSaved: () => void }) {
  const { toast } = useApp();
  const [users, setUsers] = useState<User[]>([]);
  const [rdSel, setRdSel] = useState(req.rd_id ? String(req.rd_id) : '');
  const [qaSel, setQaSel] = useState(req.qa_id ? String(req.qa_id) : '');
  const [jiraUrl, setJiraUrl] = useState(req.jira_url || '');
  const [assigning, setAssigning] = useState(false);

  useEffect(() => { api.get('/api/users').then(setUsers).catch(() => {}); }, []);
  // 需求负责人变化（详情页轮询刷新）时回显；用户手选中的不被覆盖
  useEffect(() => {
    setRdSel((prev) => (prev === '' && req.rd_id ? String(req.rd_id) : prev));
    setQaSel((prev) => (prev === '' && req.qa_id ? String(req.qa_id) : prev));
    setJiraUrl((prev) => (prev === '' && req.jira_url ? req.jira_url : prev));
  }, [req.rd_id, req.qa_id, req.jira_url]);

  const userOpts = (role: string) => [
    { value: '', label: '待指派' },
    ...users.filter((u) => u.role === role).map((u) => ({ value: u.id, label: u.name, subLabel: ROLE_NAME[u.role] })),
  ];

  const save = async () => {
    setAssigning(true);
    try {
      await assignRequirement(req.id, {
        rd_id: rdSel ? +rdSel : null,
        qa_id: qaSel ? +qaSel : null,
        jira_url: jiraUrl.trim() || null,
      });
      toast('指派与 Jira 链接已保存'); onSaved();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setAssigning(false); }
  };

  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <div className="section-title">指派研发 / 测试</div>
      <div className="grid2" style={{ marginBottom: 10 }}>
        <div className="form-row" style={{ marginBottom: 0 }}><label>研发负责人</label>
          <SearchSelect options={userOpts('RD')} value={rdSel} onChange={(v) => setRdSel(String(v))} placeholder="待指派" /></div>
        <div className="form-row" style={{ marginBottom: 0 }}><label>测试负责人</label>
          <SearchSelect options={userOpts('QA')} value={qaSel} onChange={(v) => setQaSel(String(v))} placeholder="待指派" /></div>
      </div>
      <div className="form-row" style={{ marginBottom: 10 }}>
        <label>Jira 链接（可选）</label>
        <input className="input" value={jiraUrl} onChange={(e) => setJiraUrl(e.target.value)}
          placeholder="如 https://xxx.atlassian.net/browse/PROJ-123" />
      </div>
      <button className="btn btn-primary btn-sm" onClick={save} disabled={assigning}>
        <Icon name="check" size={16} /> 保存指派
      </button>
    </div>
  );
}
