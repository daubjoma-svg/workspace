import React, { useEffect, useState } from 'react';
import { api, User, ROLE_NAME } from '../../api';
import { useApp } from '../../App';

export default function Users() {
  const { toast } = useApp();
  const [users, setUsers] = useState<User[]>([]);
  const [form, setForm] = useState({ username: '', password: '', name: '', role: 'CSM' });
  const load = () => api.get('/api/users').then(setUsers);
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!form.username || !form.password || !form.name) return toast('请填写完整');
    try { await api.post('/api/admin/users', form); setForm({ username: '', password: '', name: '', role: 'CSM' }); load(); toast('已添加'); }
    catch (e: any) { toast(e.message); }
  };
  const del = async (id: number) => {
    if (!confirm('确认删除该用户？')) return;
    try { await api.del(`/api/admin/users/${id}`); load(); } catch (e: any) { toast(e.message); }
  };
  const setRole = async (id: number, role: string) => {
    await api.put(`/api/admin/users/${id}`, { role }); load(); toast('角色已更新');
  };

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="crumb">管理后台</div>
          <h1>人员管理</h1>
        </div>
      </div>
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <b>新增成员</b>
        <div className="row" style={{ marginTop: 12 }}>
          <input className="input" placeholder="用户名" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <input className="input" placeholder="姓名" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input" placeholder="密码" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <select className="input" style={{ width: 120 }} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {Object.entries(ROLE_NAME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button className="btn btn-primary" onClick={add}>添加</button>
        </div>
      </div>
      <div className="card">
        <table className="tbl">
          <thead><tr><th>ID</th><th>用户名</th><th>姓名</th><th>角色</th><th>操作</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="muted">{u.id}</td><td>{u.username}</td><td>{u.name}</td>
                <td>
                  <select className="input" style={{ width: 110, padding: '4px 8px' }} value={u.role}
                    onChange={(e) => setRole(u.id, e.target.value)}>
                    {Object.entries(ROLE_NAME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </td>
                <td><button className="btn btn-sm btn-danger" onClick={() => del(u.id)}>删除</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
