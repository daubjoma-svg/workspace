import React, { useEffect, useState } from 'react';
import { api, User, ROLE_NAME } from '../../api';
import { useApp } from '../../App';
import { Icon } from '../../components/Icon';
import { SearchSelect } from '../../components/SearchSelect';
import { ConfirmModal } from '../../components/ConfirmModal';

const ROLE_OPTS = Object.entries(ROLE_NAME);

/** 人员管理：顶部「+ 新增成员」按钮 + 弹窗；列表角色下拉 + 飞书账号维护 + 删除（二次确认） */
export default function Users() {
  const { toast } = useApp();
  const [users, setUsers] = useState<User[]>([]);
  const [adding, setAdding] = useState(false);
  /** 统一删除确认弹窗 */
  const [delUser, setDelUser] = useState<{ id: number; name: string } | null>(null);
  const [form, setForm] = useState({ username: '', password: '', name: '', role: 'CSM', feishu_key: '' });
  /** 行内飞书编辑态：key=用户 id；null 表示未在编辑 */
  const [editingFs, setEditingFs] = useState<number | null>(null);
  const [fsDraft, setFsDraft] = useState('');
  /** 改密码弹窗 */
  const [pwUser, setPwUser] = useState<{ id: number; name: string } | null>(null);
  const [pwNew, setPwNew] = useState('');
  /** 各用户口令回显：id -> {viewable,password}；viewable=false 表示存量 bcrypt 不可回显 */
  const [pwMap, setPwMap] = useState<Record<number, { viewable: boolean; password: string }>>({});
  /** 角色 tab 切换（默认全部） */
  const [roleTab, setRoleTab] = useState<string>('ALL');
  // 按 tab 过滤后的用户列表
  const filteredUsers = roleTab === 'ALL' ? users : users.filter((u) => u.role === roleTab);
  // 各角色数量（用于 tab 徽章）
  const roleCount = (r: string) => r === 'ALL' ? users.length : users.filter((u) => u.role === r).length;

  const load = () => api.get('/api/users').then((list: User[]) => {
    setUsers(list);
    // 管理员后台：并行拉取各用户口令用于回显（可逆加密可查看；存量 bcrypt 标记不可回显）
    Promise.all(list.map((u) =>
      api.get(`/api/admin/users/${u.id}/password`).then((r) => [u.id, r] as const).catch(() => null)
    )).then((entries) => {
      const m: Record<number, { viewable: boolean; password: string }> = {};
      entries.forEach((e) => { if (e) m[e[0]] = e[1]; });
      setPwMap(m);
    });
  });
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!form.username.trim() || !form.password || !form.name.trim()) return toast('请填写完整');
    try {
      await api.post('/api/admin/users', { ...form, username: form.username.trim(), name: form.name.trim() });
      setForm({ username: '', password: '', name: '', role: 'CSM', feishu_key: '' });
      setAdding(false);
      load(); toast('已添加');
    } catch (e: any) { toast(e.message); }
  };
  const del = async (id: number, name: string) => {
    try { await api.del(`/api/admin/users/${id}`); setDelUser(null); load(); toast('已删除'); } catch (e: any) { toast(e.message); }
  };
  const setRole = async (id: number, role: string) => {
    try { await api.put(`/api/admin/users/${id}`, { role }); load(); toast('角色已更新'); }
    catch (e: any) { toast(e.message); }
  };
  /** 保存密码（ADMIN 重置任意用户密码） */
  const savePw = async () => {
    if (!pwUser) return;
    if (!pwNew || pwNew.length < 6) return toast('新密码至少 6 位', 'error');
    try {
      await api.put(`/api/admin/users/${pwUser.id}`, { password: pwNew });
      toast(`${pwUser.name} 的密码已重置`,'ok');
      setPwUser(null); setPwNew('');
    } catch (e: any) { toast(e.message,'error'); }
  };
  /** 保存飞书账号（可清空） */
  const saveFeishu = async (id: number) => {
    try {
      await api.put(`/api/admin/users/${id}`, { feishu_key: fsDraft.trim() });
      setEditingFs(null); load();
      toast(fsDraft.trim() ? '飞书账号已绑定' : '飞书账号已清空');
    } catch (e: any) { toast(e.message); }
  };

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="crumb">管理后台</div>
          <h1>人员管理</h1>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={20} /> 新增成员
        </button>
      </div>

      {/* 角色分组 tab */}
      <div className="row" style={{ marginBottom: 12, gap: 6, flexWrap: 'wrap' }}>
        {[
          { k: 'ALL', label: '全部' },
          { k: 'CSM', label: '需求发起人' },
          { k: 'PO', label: '产品' },
          { k: 'RD', label: '研发' },
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
          <thead><tr><th>ID</th><th>用户名</th><th>姓名</th><th>角色</th><th>飞书账号</th><th>密码</th><th>操作</th></tr></thead>
          <tbody>
            {filteredUsers.map((u) => (
              <tr key={u.id}>
                <td className="muted">{u.id}</td><td>{u.username}</td><td>{u.name}</td>
                <td>
                  <SearchSelect
                    options={ROLE_OPTS.map(([k, v]) => ({ value: k, label: v }))}
                    value={u.role}
                    onChange={(v) => setRole(u.id, String(v))}
                    width={110}
                  />
                </td>
                <td>
                  {editingFs === u.id ? (
                    <span className="row" style={{ gap: 6 }}>
                      <input className="input" style={{ width: 180 }} value={fsDraft}
                        placeholder="user_id 或邮箱"
                        onChange={(e) => setFsDraft(e.target.value)}
                        autoFocus
                        onKeyDown={(e) => { if (e.key === 'Enter') saveFeishu(u.id); if (e.key === 'Escape') setEditingFs(null); }} />
                      <button className="btn btn-sm btn-primary" onClick={() => saveFeishu(u.id)}>保存</button>
                      <button className="btn btn-sm" onClick={() => setEditingFs(null)}>取消</button>
                    </span>
                  ) : (
                    <span className="row" style={{ gap: 6 }}>
                      {u.feishu_key
                        ? <span className="tag tag-green" title={u.feishu_key}>{u.feishu_key.length > 18 ? u.feishu_key.slice(0, 18) + '…' : u.feishu_key}</span>
                        : <span className="tag tag-grey">未绑定</span>}
                      <button className="btn btn-sm btn-icon" aria-label="编辑飞书账号"
                        onClick={() => { setEditingFs(u.id); setFsDraft(u.feishu_key || ''); }}>
                        <Icon name="edit" size={16} />
                      </button>
                    </span>
                  )}
                </td>
                <td>
                  <span className="row" style={{ gap: 6 }}>
                    {/* 口令可逆加密存储，管理员可直接查看；存量 bcrypt 不可回显，重置后可查看 */}
                    {pwMap[u.id]?.viewable
                      ? <span className="tag tag-green" title="口令以 AES-256-GCM 可逆加密存储，仅管理员可见">{pwMap[u.id].password.length > 18 ? pwMap[u.id].password.slice(0, 18) + '…' : pwMap[u.id].password}</span>
                      : <span className="tag tag-grey" title="旧版加密存储不可回显，点铅笔重置一次后即可查看">不可回显</span>}
                    <button className="btn btn-sm btn-icon" aria-label="重置密码"
                      disabled={u.role === 'ADMIN'}
                      title={u.role === 'ADMIN' ? '管理员账号不允许修改密码' : '重置密码'}
                      onClick={() => { setPwUser({ id: u.id, name: u.name }); setPwNew(''); }}>
                      <Icon name="edit" size={16} />
                    </button>
                  </span>
                </td>
                <td>
                  <button className="btn btn-sm btn-danger" onClick={() => setDelUser({ id: u.id, name: u.name })}>删除</button>
                </td>
              </tr>
            ))}
            {filteredUsers.length === 0 && (
              <tr><td colSpan={7} className="empty" style={{ padding: '40px 10px' }}>暂无成员，点右上角「新增成员」添加</td></tr>
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

      {/* 改密码弹窗 */}
      {pwUser && (
        <div className="modal-mask" onClick={() => setPwUser(null)}>
          <div className="modal card" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-h row">
              <Icon name="key" size={20} />
              <span>重置密码：{pwUser.name}</span>
              <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setPwUser(null)}>关闭</button>
            </div>
            <div className="modal-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="form-row" style={{ marginBottom: 0 }}>
                <label>新密码（≥ 6 位）</label>
                <input className="input" type="password" value={pwNew} autoFocus
                  onChange={(e) => setPwNew(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') savePw(); }}
                  placeholder="新密码" />
              </div>
              <div className="muted" style={{ fontSize: 12 }}>该操作将立即生效，对方需要用新密码重新登录。保存后可在列表中查看密码，输错可随时再改。</div>
              <div className="row" style={{ marginTop: 6, gap: 8 }}>
                <button className="btn btn-primary" onClick={savePw}>保存</button>
                <button className="btn" onClick={() => setPwUser(null)}>取消</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
