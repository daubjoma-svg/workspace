import React, { useEffect, useState } from 'react';
import { api, User, ROLE_NAME } from '../../api';
import { useApp } from '../../App';
import { Icon } from '../../components/Icon';
import { SearchSelect } from '../../components/SearchSelect';
import { ConfirmModal } from '../../components/ConfirmModal';

const ROLE_OPTS = Object.entries(ROLE_NAME);

/** 管理员集中维护的产品 Jira 创建默认值，字段 ID 由所选项目的元数据提供。 */
const JIRA_DEFAULT_FIELD_NAMES = ['平台子业务线', '涉及的研发端', '归属BU'];
const DEFAULT_JIRA_BASE_URL = 'https://jira.fenbeijinfu.com';
type JiraDefaultField = {
  id: string;
  name: string;
  allowed_values?: { id: string; value: string }[];
};

type JiraEditProfile = {
  base_url: string;
  username: string;
  token_configured: boolean;
  field_defaults?: Record<string, string | string[]>;
  project_key: string;
  issue_type: string;
  sync?: {
    project_candidates?: { key: string; name: string }[];
    issue_type?: string;
    create_fields?: JiraDefaultField[];
  } | null;
};

type UserEditForm = {
  name: string;
  role: string;
  feishu_key: string;
  password: string;
  jira_base_url: string;
  jira_username: string;
  jira_token: string;
  jira_project_key: string;
  jira_issue_type: string;
  jira_project_candidates: { key: string; name: string }[];
  /** 保存整份默认值映射，避免只编辑三个字段时清空产品配置的其他字段。 */
  jira_field_defaults: Record<string, string | string[]>;
};

/** 人员管理：成员新增、角色/飞书/Jira 配置维护与删除。 */
export default function Users() {
  const { toast } = useApp();
  const [users, setUsers] = useState<User[]>([]);
  const [adding, setAdding] = useState(false);
  /** 统一删除确认弹窗 */
  const [delUser, setDelUser] = useState<{ id: number; name: string } | null>(null);
  const [form, setForm] = useState({ username: '', password: '', name: '', role: 'CSM', feishu_key: '' });
  /** 统一编辑弹窗：姓名、角色、飞书、密码及产品 Jira 配置都在此维护。 */
  const [editUser, setEditUser] = useState<User | null>(null);
  const [editForm, setEditForm] = useState<UserEditForm | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [currentPassword, setCurrentPassword] = useState<{ visible: boolean; loading: boolean; loaded: boolean; value: string } | null>(null);
  const [jiraProfileLoaded, setJiraProfileLoaded] = useState(false);
  const [jiraTokenConfigured, setJiraTokenConfigured] = useState(false);
  const [jiraDefaultFields, setJiraDefaultFields] = useState<JiraDefaultField[]>([]);
  const [jiraDefaultsLoading, setJiraDefaultsLoading] = useState(false);
  const [jiraDefaultsError, setJiraDefaultsError] = useState('');
  /** 角色 tab 切换（默认全部） */
  const [roleTab, setRoleTab] = useState<string>('ALL');
  // 按 tab 过滤后的用户列表
  const filteredUsers = roleTab === 'ALL' ? users : users.filter((u) => u.role === roleTab);
  // 各角色数量（用于 tab 徽章）
  const roleCount = (r: string) => r === 'ALL' ? users.length : users.filter((u) => u.role === r).length;

  const load = () => api.get('/api/users').then((list: User[]) => {
    setUsers(list);
  });
  useEffect(() => { load(); }, []);

  const editProjectKey = editForm?.jira_project_key || '';
  const editIssueType = editForm?.jira_issue_type || '';
  // 项目切换后重新读取字段，避免把其他项目的选项用于当前产品；关闭弹窗后忽略未完成请求。
  useEffect(() => {
    if (!editUser || editUser.role !== 'PO' || !jiraProfileLoaded || !jiraTokenConfigured || !editProjectKey) return;
    let cancelled = false;
    setJiraDefaultsLoading(true);
    setJiraDefaultsError('');
    setJiraDefaultFields([]);
    const query = new URLSearchParams({ project_key: editProjectKey, issue_type: editIssueType });
    api.get(`/api/admin/users/${editUser.id}/jira-default-fields?${query}`)
      .then((raw: any) => { if (!cancelled) setJiraDefaultFields(raw?.data || raw); })
      .catch((e: any) => { if (!cancelled) setJiraDefaultsError(e.message || 'Jira 默认字段读取失败'); })
      .finally(() => { if (!cancelled) setJiraDefaultsLoading(false); });
    return () => { cancelled = true; };
  }, [editUser?.id, editUser?.role, jiraProfileLoaded, jiraTokenConfigured, editProjectKey, editIssueType]);

  const openAdd = () => {
    // 在产品角色筛选页新增时沿用当前上下文，减少重复选择。
    setForm({ username: '', password: '', name: '', role: roleTab === 'PO' ? 'PO' : 'CSM', feishu_key: '' });
    setAdding(true);
  };
  const add = async () => {
    if (!form.username.trim() || !form.password || !form.name.trim()) return toast('请填写完整');
    try {
      await api.post('/api/admin/users', { ...form, username: form.username.trim(), name: form.name.trim() });
      setForm({ username: '', password: '', name: '', role: 'CSM', feishu_key: '' });
      setAdding(false);
      // Jira 账号由产品本人在需求详情中配置，管理员新增成员后不代配其他角色账号。
      load(); toast(form.role === 'PO' ? '产品成员已添加，请由该产品账号自行配置 Jira' : '已添加');
    } catch (e: any) { toast(e.message); }
  };
  const del = async (id: number, name: string) => {
    try { await api.del(`/api/admin/users/${id}`); setDelUser(null); load(); toast('已删除'); } catch (e: any) { toast(e.message); }
  };
  /** 打开统一编辑弹窗；产品行额外读取 Jira 配置，其他角色不请求 Jira 凭据。 */
  const openEdit = (u: User) => {
    setEditUser(u);
    setEditForm({ name: u.name, role: u.role, feishu_key: u.feishu_key || '', password: '', jira_base_url: '', jira_username: '', jira_token: '', jira_project_key: '', jira_issue_type: '', jira_project_candidates: [], jira_field_defaults: {} });
    setJiraDefaultFields([]);
    setJiraDefaultsLoading(false);
    setJiraDefaultsError('');
    setCurrentPassword(null);
    setJiraTokenConfigured(false);
    setJiraProfileLoaded(u.role !== 'PO');
    if (u.role !== 'PO') return;
    setEditLoading(true);
    api.get(`/api/admin/users/${u.id}/jira-profile`)
      .then((raw: any) => {
        const profile: JiraEditProfile = raw?.data || raw;
        setEditForm((prev) => prev ? {
          ...prev,
          jira_base_url: DEFAULT_JIRA_BASE_URL,
          jira_username: profile.username || '',
          jira_project_key: profile.project_key || '',
          jira_issue_type: profile.issue_type || '',
          jira_project_candidates: profile.sync?.project_candidates || [],
          jira_field_defaults: profile.field_defaults || {},
        } : prev);
        setJiraDefaultFields((profile.sync?.create_fields || []).filter((field) => JIRA_DEFAULT_FIELD_NAMES.includes(field.name)));
        setJiraTokenConfigured(!!profile.token_configured);
        setJiraProfileLoaded(true);
      })
      .catch((e: any) => toast(e.message || 'Jira 配置读取失败', 'error'))
      .finally(() => setEditLoading(false));
  };

  /** 留空清除当前字段，其余 Jira 默认值原样保留。 */
  const setJiraDefault = (fieldId: string, value: string) => {
    setEditForm((prev) => {
      if (!prev) return prev;
      const defaults = { ...prev.jira_field_defaults };
      if (value.trim()) defaults[fieldId] = value;
      else delete defaults[fieldId];
      return { ...prev, jira_field_defaults: defaults };
    });
  };

  /** 管理员按需查看当前密码；不可逆历史密码提示通过重置修改。 */
  const toggleCurrentPassword = async () => {
    if (!editUser) return;
    if (currentPassword?.visible) {
      setCurrentPassword((prev) => prev ? { ...prev, visible: false } : prev);
      return;
    }
    if (currentPassword?.loaded) {
      if (!currentPassword.value) return toast('该账号密码为历史不可逆存储，请通过新密码修改', 'error');
      setCurrentPassword((prev) => prev ? { ...prev, visible: true } : prev);
      return;
    }
    setCurrentPassword({ visible: false, loading: true, loaded: false, value: '' });
    try {
      const raw: any = await api.get(`/api/admin/users/${editUser.id}/password`);
      const result = raw?.data || raw;
      if (!result?.viewable) {
        setCurrentPassword({ visible: false, loading: false, loaded: true, value: '' });
        return toast('该账号密码为历史不可逆存储，请通过新密码修改', 'error');
      }
      setCurrentPassword({ visible: true, loading: false, loaded: true, value: result.password || '' });
    } catch (e: any) {
      setCurrentPassword(null);
      toast(e.message || '密码查看失败', 'error');
    }
  };

  /** 保存统一编辑内容；Jira 仅对产品目标账号写入。 */
  const saveEdit = async () => {
    if (!editUser || !editForm) return;
    if (!editForm.name.trim()) return toast('姓名不能为空', 'error');
    if (editForm.password && editForm.password.length < 6) return toast('新密码至少 6 位', 'error');
    if (editForm.role === 'PO' && !jiraProfileLoaded) return toast('Jira 配置仍在加载，请稍候', 'error');
    setEditSaving(true);
    try {
      await api.put(`/api/admin/users/${editUser.id}`, {
        name: editForm.name.trim(),
        role: editForm.role,
        feishu_key: editForm.feishu_key.trim(),
        ...(editForm.password ? { password: editForm.password } : {}),
      });
      if (editForm.role === 'PO') {
        const raw: any = await api.put(`/api/admin/users/${editUser.id}/jira-profile`, {
          base_url: editForm.jira_base_url.trim(),
          username: editForm.jira_username.trim(),
          api_token: editForm.jira_token || (jiraTokenConfigured ? '__KEEP__' : ''),
          project_key: editForm.jira_project_key.trim(),
          issue_type: editForm.jira_issue_type.trim(),
          field_defaults: editForm.jira_field_defaults,
        });
        const saved = raw?.data || raw;
        if (saved?.sync_error) toast(`成员已保存，但 Jira 同步失败：${saved.sync_error}`, 'error');
      }
      setEditUser(null); setEditForm(null); load();
      if (editForm.role !== 'PO' || !editForm.jira_token) toast('成员信息已保存', 'ok');
    } catch (e: any) { toast(e.message || '保存失败', 'error'); }
    finally { setEditSaving(false); }
  };

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="crumb">管理后台</div>
          <h1>人员管理</h1>
        </div>
        <button className="btn btn-primary" onClick={openAdd}>
          <Icon name="plus" size={20} /> 新增成员
        </button>
      </div>

      {/* 角色分组 tab */}
      <div className="row" style={{ marginBottom: 12, gap: 6, flexWrap: 'wrap' }}>
        {[
          { k: 'ALL', label: '全部' },
          { k: 'CSM', label: '需求发起人' },
          { k: 'PO', label: '产品' },
          { k: 'RD', label: '后端' },
          { k: 'FE', label: '前端' },
          { k: 'QA', label: '测试' },
          { k: 'ADMIN', label: '管理员' },
        ].map((t1) => (
          <button key={t1.k} className={'btn btn-sm ' + (roleTab === t1.k ? 'btn-primary' : '')}
            onClick={() => setRoleTab(t1.k)}
            style={{ borderRadius: 16 }}>
            {t1.label} <span style={{ marginLeft: 4, padding: '0 6px', background: roleTab === t1.k ? 'rgba(255,255,255,0.25)' : 'var(--panel-2)', borderRadius: 10, fontSize: 11 }}>{roleCount(t1.k)}</span>
          </button>
        ))}
      </div>

      <div className="card tbl-wrap">
        <table className="tbl">
          <thead><tr><th>ID</th><th>用户名</th><th>姓名</th><th>角色</th><th>飞书账号</th><th>密码</th><th>Jira 账号</th><th>操作</th></tr></thead>
          <tbody>
            {filteredUsers.map((u) => (
              <tr key={u.id}>
                <td className="muted">{u.id}</td><td>{u.username}</td><td>{u.name}</td>
                <td>
                  <span className="tag tag-grey">{ROLE_NAME[u.role] || u.role}</span>
                </td>
                <td>
                  {u.feishu_key
                    ? <span className="tag tag-green" title={u.feishu_key}>{u.feishu_key.length > 18 ? u.feishu_key.slice(0, 18) + '…' : u.feishu_key}</span>
                    : <span className="tag tag-grey">未绑定</span>}
                </td>
                <td>
                  <span className={u.password_configured ? 'tag tag-green' : 'tag tag-grey'} title="密码默认掩码显示">{u.password_configured ? '••••••' : '未设置'}</span>
                </td>
                <td>
                  {u.role === 'PO'
                    ? (u.jira_configured
                      ? <span className="tag tag-green" title="该产品已配置 Jira 账号">已配置{u.jira_username ? ` · ${u.jira_username}` : ''}</span>
                      : <span className="tag tag-grey" title="请由该产品账号自行配置 Jira">未配置</span>)
                    : <span className="tag tag-grey" title="仅产品角色需要配置 Jira">不适用</span>}
                </td>
                <td>
                  <span className="row" style={{ gap: 6 }}>
                    <button className="btn btn-sm btn-icon" title="编辑成员" aria-label={`编辑 ${u.name}`} onClick={() => openEdit(u)}>
                      <Icon name="edit" size={16} />
                    </button>
                    <button className="btn btn-sm btn-danger" disabled={u.role === 'ADMIN'}
                      title={u.role === 'ADMIN' ? '管理员账号不允许删除' : '删除成员'}
                      onClick={() => setDelUser({ id: u.id, name: u.name })}>删除</button>
                  </span>
                </td>
              </tr>
            ))}
            {filteredUsers.length === 0 && (
              <tr><td colSpan={8} className="empty" style={{ padding: '40px 10px' }}>暂无成员，点右上角「新增成员」添加</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {adding && (
        <div className="modal-mask" onClick={() => setAdding(false)}>
          <div className="modal card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-h">
              新增成员
              <button className="btn btn-sm btn-icon" onClick={() => setAdding(false)} aria-label="关闭弹窗">
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="modal-b">
              <div className="grid2">
                <div className="form-row"><label>用户名 *</label>
                  <input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" placeholder="登录账号" /></div>
                <div className="form-row"><label>姓名 *</label>
                  <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="显示名称" /></div>
                <div className="form-row"><label>初始密码 *</label>
                  <input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
                  <div className="hint">密码加密存储，管理员可在列表中查看与重置</div></div>
                <div className="form-row"><label>角色</label>
                  <SearchSelect
                    options={ROLE_OPTS.map(([k, v]) => ({ value: k, label: v }))}
                    value={form.role}
                    onChange={(v) => setForm({ ...form, role: String(v) })}
                    placeholder="请选择角色"
                  /></div>
                <div className="form-row" style={{ gridColumn: '1 / -1' }}><label>飞书账号（选填）</label>
                  <input className="input" value={form.feishu_key}
                    onChange={(e) => setForm({ ...form, feishu_key: e.target.value })}
                    placeholder="飞书 user_id 或邮箱（填写后流程流转到该用户节点时会推送飞书消息）" />
                  <div className="hint">选填。推荐填邮箱，跨应用稳定；不填则只收站内通知</div></div>
              </div>
            </div>
            <div className="modal-f">
              <button className="btn" onClick={() => setAdding(false)}>取消</button>
              <button className="btn btn-primary" onClick={add}>添加成员</button>
            </div>
          </div>
        </div>
      )}
      {/* 统一删除确认弹窗 */}
      {delUser && (
        <ConfirmModal
          title="删除用户"
          message={`确认删除用户「${delUser.name}」？该操作不可恢复。`}
          confirmText="删除"
          danger
          onCancel={() => setDelUser(null)}
          onConfirm={() => del(delUser.id, delUser.name)}
        />
      )}

      {/* 统一编辑弹窗：集中维护成员基础信息与产品 Jira 配置。 */}
      {editUser && editForm && (
        <div className="modal-mask" onClick={() => { setEditUser(null); setEditForm(null); }}>
          <div className="modal card user-edit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-h">
              <span><Icon name="edit" size={17} /> 编辑成员：{editUser.name}</span>
              <button className="btn btn-sm btn-icon" onClick={() => { setEditUser(null); setEditForm(null); }} aria-label="关闭"><Icon name="close" size={16} /></button>
            </div>
            <div className="modal-b">
              {editLoading ? <div className="empty">正在读取 Jira 配置…</div> : <>
                <div className="grid2">
                  <div className="form-row"><label>姓名 *</label>
                    <input className="input" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} autoFocus /></div>
                  <div className="form-row"><label>角色 *</label>
                    <SearchSelect options={ROLE_OPTS.map(([k, v]) => ({ value: k, label: v }))} value={editForm.role}
                      onChange={(v) => setEditForm({ ...editForm, role: String(v) })} placeholder="选择角色" /></div>
                  <div className="form-row" style={{ gridColumn: '1 / -1' }}><label>飞书账号（选填）</label>
                    <input className="input" value={editForm.feishu_key} onChange={(e) => setEditForm({ ...editForm, feishu_key: e.target.value })} placeholder="飞书 user_id 或邮箱" /></div>
                  <div className="form-row"><label>当前密码</label>
                    <span className="row" style={{ gap: 8 }}>
                      <button type="button" className="btn btn-sm btn-icon" onClick={() => void toggleCurrentPassword()} disabled={currentPassword?.loading || !editUser.password_configured}
                        title={currentPassword?.visible ? '隐藏密码' : '查看密码'} aria-label={currentPassword?.visible ? '隐藏密码' : '查看密码'}>
                        <Icon name={currentPassword?.visible ? 'eye-off' : 'eye'} size={16} />
                      </button>
                      <span className="tag tag-green">{currentPassword?.visible ? currentPassword.value : (editUser.password_configured ? '••••••' : '未设置')}</span>
                    </span>
                  </div>
                  <div className="form-row"><label>新密码（留空不修改）</label>
                    <input className="input" type="password" value={editForm.password} onChange={(e) => setEditForm({ ...editForm, password: e.target.value })} placeholder="至少 6 位" /></div>
                </div>

                {editForm.role === 'PO' && <>
                  <section className="user-edit-section" aria-label="Jira 配置">
                    <div className="section-title">Jira 配置</div>
                    <div className="user-edit-grid">
                      <div className="form-row user-edit-wide"><label>Jira 地址</label>
                        <input className="input" value={DEFAULT_JIRA_BASE_URL} readOnly /></div>
                      <div className="form-row"><label>Jira 账号</label>
                        <input className="input" value={editForm.jira_username} onChange={(e) => setEditForm({ ...editForm, jira_username: e.target.value })} placeholder="登录账号或邮箱" /></div>
                      <div className="form-row"><label>Jira 密码 / Token</label>
                        <input className="input" type="password" value={editForm.jira_token} onChange={(e) => setEditForm({ ...editForm, jira_token: e.target.value })} placeholder={jiraTokenConfigured ? '已配置，留空保持不变' : '请输入 Jira 密码或 API Token'} /></div>
                    </div>
                  </section>
                  <section className="user-edit-section" aria-label="Jira 创建默认值">
                    <div className="section-title">创建默认值</div>
                    <div className="user-edit-grid">
                      <div className="form-row user-edit-wide"><label>默认项目</label>
                        <SearchSelect
                          options={editForm.jira_project_candidates.map((p) => ({ value: p.key, label: p.name ? `${p.name}（${p.key}）` : p.key }))}
                          value={editForm.jira_project_key}
                          onChange={(v) => setEditForm({ ...editForm, jira_project_key: String(v) })}
                          placeholder="选择默认项目"
                          emptyText="暂无可创建项目"
                        />
                      </div>
                    </div>
                    {jiraDefaultsError && <div className="hint" role="alert">{jiraDefaultsError}</div>}
                    <div className="user-edit-default-grid">
                    {JIRA_DEFAULT_FIELD_NAMES.map((name) => {
                    const field = jiraDefaultFields.find((f) => f.name === name);
                    const value = field ? editForm.jira_field_defaults[field.id] : '';
                    const selected = Array.isArray(value) ? value.join(', ') : value || '';
                    const options = field?.allowed_values || [];
                    return <div className="form-row" key={name}>
                      <label id={`jira-default-${name}`}>{name}</label>
                      <div aria-labelledby={`jira-default-${name}`} role="group">
                        {options.length ? <SearchSelect
                          options={[{ value: '', label: '不设默认值' }, ...options.map((o) => ({ value: o.value, label: o.value }))]}
                          value={selected}
                          onChange={(v) => field && setJiraDefault(field.id, String(v))}
                          disabled={jiraDefaultsLoading || editSaving}
                          placeholder="选择默认值"
                        /> : <input className="input" aria-label={name} value={selected}
                          disabled={!field || jiraDefaultsLoading || editSaving}
                          onChange={(e) => field && setJiraDefault(field.id, e.target.value)}
                          placeholder={jiraDefaultsLoading ? '正在读取选项…' : field ? '留空不设默认值' : '该项目暂无此字段，请先保存 Jira 账号配置'} />}
                      </div>
                    </div>;
                    })}
                    </div>
                  </section>
                </>}
              </>}
            </div>
            <div className="modal-f">
              <button className="btn" onClick={() => { setEditUser(null); setEditForm(null); }} disabled={editSaving}>取消</button>
              <button className="btn btn-primary" onClick={() => void saveEdit()} disabled={editLoading || editSaving}>{editSaving ? '保存中…' : '保存'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
