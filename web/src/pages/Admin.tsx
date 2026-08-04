import React, { useEffect, useState } from 'react';
import { api, User, SopNode, AI_ACTIONS, ROLE_NAME, CodeModule, ModuleMapping } from '../api';
import { useApp } from '../App';
import { Icon } from '../components/Icon';

export type AdminTab = 'users' | 'sop' | 'ai' | 'modules' | 'theme' | 'stats';

export const ADMIN_TABS: [AdminTab, string][] = [
  ['sop', 'SOP 编排'], ['modules', '模块管理'], ['users', '人员管理'],
  ['ai', 'AI 配置'], ['theme', '外观主题'], ['stats', '数据总览'],
];

export default function Admin({ tab }: { tab: AdminTab }) {
  return (
    <div>
      {tab === 'users' && <Users />}
      {tab === 'sop' && <Sop />}
      {tab === 'ai' && <AiProviders />}
      {tab === 'modules' && <Modules />}
      {tab === 'theme' && <Theme />}
      {tab === 'stats' && <Stats />}
    </div>
  );
}

/* ---------------- 人员管理 ---------------- */
function Users() {
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

/* ---------------- SOP 编排 ---------------- */
function Sop() {
  const { toast } = useApp();
  const [tpls, setTpls] = useState<any[]>([]);
  const [cur, setCur] = useState<number | null>(null);
  const [nodes, setNodes] = useState<Partial<SopNode>[]>([]);
  const [dirty, setDirty] = useState(false);
  const [editIdx, setEditIdx] = useState<number | null>(null);

  const load = async () => {
    const t = await api.get('/api/admin/sop-templates');
    setTpls(t);
    const id = cur ?? t.find((x: any) => x.is_default)?.id ?? t[0]?.id;
    setCur(id);
    setNodes(t.find((x: any) => x.id === id)?.nodes || []);
    setDirty(false);
  };
  useEffect(() => { load(); }, [cur]);

  const set = (i: number, patch: Partial<SopNode>) => {
    setNodes((ns) => ns.map((n, j) => j === i ? { ...n, ...patch } : n)); setDirty(true);
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= nodes.length) return;
    const ns = [...nodes];[ns[i], ns[j]] = [ns[j], ns[i]];
    setNodes(ns); setDirty(true);
  };
  const addNode = (type: 'HUMAN' | 'AI') => {
    setNodes((ns) => [...ns, {
      node_type: type, name: type === 'AI' ? 'AI·新节点' : '新的人工节点',
      role: type === 'HUMAN' ? 'PO' : undefined, ai_action: type === 'AI' ? 'CUSTOM' : undefined,
    }]);
    setDirty(true);
    setEditIdx(nodes.length); // 打开新节点编辑
  };
  const remove = (i: number) => { setNodes((ns) => ns.filter((_, j) => j !== i)); setDirty(true); setEditIdx(null); };
  const save = async () => {
    if (!nodes.length) return toast('至少保留一个节点');
    await api.put(`/api/admin/sop-templates/${cur}/nodes`, { nodes });
    toast('SOP 已保存'); load();
  };
  const addTpl = async () => {
    const name = prompt('新模板名称');
    if (!name) return;
    await api.post('/api/admin/sop-templates', { name }); setCur(null); load();
  };
  const setDefault = async (id: number) => { await api.put(`/api/admin/sop-templates/${id}`, { is_default: true }); load(); toast('已设为默认'); };

  const tpl = tpls.find((t) => t.id === cur);
  const readonly = !!tpl?.is_system;

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="crumb">管理后台</div>
          <h1>SOP 编排</h1>
          <div className="muted" style={{ marginTop: 6, maxWidth: 640 }}>标准交付流程为系统内置、不可修改;可新建自定义交付流程模板,并为 AI 节点配置默认提示词。</div>
        </div>
      </div>
      <div className="split" style={{ gridTemplateColumns: '230px 1fr' }}>
      <div>
        <div className="row" style={{ marginBottom: 10 }}>
          <b>流程模板</b>
          <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={addTpl}>+ 新建</button>
        </div>
        {tpls.map((t) => (
          <div key={t.id} className="card tpl-card" style={{ borderColor: t.id === cur ? 'var(--primary)' : undefined }}
            onClick={() => setCur(t.id)}>
            <div style={{ fontWeight: 600 }}>{t.name}</div>
            <div className="row" style={{ marginTop: 6 }}>
              {!!t.is_system && <span className="tag tag-blue">系统内置</span>}
              {!!t.is_default && <span className="tag tag-green">默认</span>}
              {!t.is_default && !t.is_system && <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setDefault(t.id); }}>设为默认</button>}
              <span className="muted" style={{ marginLeft: 'auto' }}>{t.nodes.length} 节点</span>
            </div>
          </div>
        ))}
      </div>

      <div className="card card-pad">
        <div className="row" style={{ marginBottom: 6 }}>
          <b>{tpl?.name} · 节点编排</b>
          {readonly && <span className="tag tag-blue">只读 · 系统内置</span>}
          {dirty && !readonly && <span className="tag tag-orange">未保存</span>}
          {!readonly && (
            <div style={{ marginLeft: 'auto' }} className="row">
              <button className="btn btn-sm" onClick={() => addNode('AI')}>+ AI 节点</button>
              <button className="btn btn-sm" onClick={() => addNode('HUMAN')}>+ 人工节点</button>
              <button className="btn btn-sm btn-primary" disabled={!dirty} onClick={save}>保存编排</button>
            </div>
          )}
        </div>
        <p className="muted" style={{ marginBottom: 14, fontSize: 12 }}>
          {readonly
            ? '这是平台内置的标准交付流程,不可修改或删除。点击节点可查看其默认 AI 提示词;如需自定义,请在左侧「新建」一个交付流程模板。'
            : '节点自上而下依次流转;AI 节点流转到时自动执行,人工节点等待对应角色处理。点击节点卡片可编辑详情与自定义 Prompt。'}
        </p>
        <div className="sop-flow">
          {nodes.map((n, i) => (
            <React.Fragment key={i}>
              <div className={`sop-node-item ${n.node_type === 'AI' ? 'ai' : 'human'} ${editIdx === i ? 'editing' : ''}`}
                onClick={() => setEditIdx(editIdx === i ? null : i)}>
                <div className="seq">{i + 1}</div>
                <span className={`node-kind ${n.node_type === 'AI' ? 'ai' : 'human'}`}>
                  {n.node_type === 'AI' ? 'AI' : '人工'}
                </span>
                <div className="node-main">
                  <div className="node-name">{n.name || <span className="muted">未命名节点</span>}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {n.node_type === 'AI'
                      ? `${AI_ACTIONS[n.ai_action || 'CUSTOM']}${n.ai_prompt ? (readonly ? ' · 默认提示词' : ' · 自定义 Prompt') : ''}`
                      : `负责角色:${ROLE_NAME[n.role || 'PO']}`}
                  </div>
                </div>
                {!readonly && (
                  <div className="row" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
                    <button className="btn btn-sm btn-icon" disabled={i === 0} onClick={() => move(i, -1)} title="上移" aria-label="上移节点"><Icon name="move-up" size={16} /></button>
                    <button className="btn btn-sm btn-icon" disabled={i === nodes.length - 1} onClick={() => move(i, 1)} title="下移" aria-label="下移节点"><Icon name="move-down" size={16} /></button>
                    <button className="btn btn-sm btn-danger" onClick={() => remove(i)} title="删除">删</button>
                  </div>
                )}
              </div>

              {/* 行内编辑抽屉 */}
              {editIdx === i && (
                <div className="node-editor">
                  <div className="grid2">
                    <div className="form-row"><label>节点名称</label>
                      <input className="input" value={n.name || ''} disabled={readonly} onChange={(e) => set(i, { name: e.target.value })} /></div>
                    {n.node_type === 'AI' ? (
                      <div className="form-row"><label>AI 动作</label>
                        <select className="input" value={n.ai_action || 'CUSTOM'} disabled={readonly} onChange={(e) => set(i, { ai_action: e.target.value })}>
                          {Object.entries(AI_ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select></div>
                    ) : (
                      <div className="form-row"><label>负责角色</label>
                        <select className="input" value={n.role || 'PO'} disabled={readonly} onChange={(e) => set(i, { role: e.target.value })}>
                          {['CSM', 'PO', 'RD', 'QA'].map((r) => <option key={r} value={r}>{ROLE_NAME[r]}</option>)}
                        </select></div>
                    )}
                  </div>
                  {n.node_type === 'AI' && (
                    <div className="form-row" style={{ marginBottom: 0 }}>
                      <label>{readonly ? '默认提示词(系统内置,只读)' : '自定义 Prompt(可选,追加到系统提示词后,用于约束该节点的输出)'}</label>
                      <textarea className="input" rows={readonly ? 6 : 3} value={n.ai_prompt || ''} readOnly={readonly}
                        placeholder="例如:评估时重点关注性能与兼容历史数据;输出需包含影响到的接口列表。"
                        onChange={(e) => set(i, { ai_prompt: e.target.value })} />
                    </div>
                  )}
                </div>
              )}
              {i < nodes.length - 1 && <div className="flow-arrow"><Icon name="move-down" size={16} /></div>}
            </React.Fragment>
          ))}
        </div>
        {nodes.length === 0 && <div className="empty">暂无节点,点击右上角添加</div>}
        <p className="muted" style={{ marginTop: 12 }}>
          提示:AI 节点会在流转到它时调用「AI 配置」里启用的大模型自动执行(未配置则用内置 Mock 离线演示);若 AI 判断需要澄清,会向 CSM 提问。{readonly ? '标准流程对新需求即时生效。' : '保存后对「新提交」的需求生效。'}
        </p>
      </div>
      </div>
    </div>
  );
}

/* ---------------- AI 配置 ---------------- */
function AiProviders() {
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

/* ---------------- 模块管理(GitLab + 平台模块映射) ---------------- */
function Modules() {
  const { toast } = useApp();
  const [cfg, setCfg] = useState({ base_url: '', token: '', token_set: false });
  const [testRes, setTestRes] = useState<any>(null);
  const [modules, setModules] = useState<CodeModule[]>([]);
  const [mappings, setMappings] = useState<ModuleMapping[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [syncing, setSyncing] = useState<Record<number, boolean>>({});
  const [mform, setMform] = useState({ module_key: '', name: '', description: '', gitlab_project_id: '', branch: 'main', sub_path: '' });
  const [pform, setPform] = useState({ platform_name: '', platform_key: '', code_module_id: '', path_prefix: '' });

  const loadAll = async () => {
    setModules(await api.get('/api/admin/modules'));
    setMappings(await api.get('/api/admin/mappings'));
  };
  useEffect(() => { (async () => { setCfg(await api.get('/api/admin/gitlab/config')); loadAll(); })(); }, []);

  const saveCfg = async () => {
    await api.put('/api/admin/gitlab/config', { base_url: cfg.base_url, token: cfg.token });
    toast('GitLab 配置已保存');
    setCfg(await api.get('/api/admin/gitlab/config'));
  };
  const test = async () => {
    setTestRes(null);
    const r = await api.get('/api/admin/gitlab/test');
    setTestRes(r);
    if (r.ok) toast(`连接成功:${r.user}`);
  };
  const loadProjects = async () => {
    try { setProjects(await api.get('/api/admin/gitlab/projects')); toast(`已加载 ${projects.length} 个 GitLab 项目`); }
    catch (e: any) { toast(e.message); }
  };
  const onPickProject = async (pid: string) => {
    setMform((f) => ({ ...f, gitlab_project_id: pid }));
    if (!pid) return setBranches([]);
    try { setBranches(await api.get(`/api/admin/gitlab/projects/${encodeURIComponent(pid)}/branches`)); }
    catch { setBranches([]); }
  };
  const addModule = async () => {
    if (!mform.module_key || !mform.name || !mform.gitlab_project_id) return toast('请填模块 Key/名称并选择 GitLab 项目');
    const proj = projects.find((p) => String(p.id) === String(mform.gitlab_project_id));
    try {
      await api.post('/api/admin/modules', { ...mform, gitlab_project_path: proj?.path || '' });
      setMform({ module_key: '', name: '', description: '', gitlab_project_id: '', branch: 'main', sub_path: '' });
      setBranches([]);
      loadAll(); toast('模块已创建,请点击「拉取」同步代码');
    } catch (e: any) { toast(e.message); }
  };
  const sync = async (id: number) => {
    setSyncing((s) => ({ ...s, [id]: true }));
    try { await api.post(`/api/admin/modules/${id}/sync`); toast('代码拉取成功'); }
    catch (e: any) { toast(e.message); }
    setSyncing((s) => ({ ...s, [id]: false }));
    loadAll();
  };
  const delModule = async (id: number) => {
    if (!confirm('删除该代码模块及其映射?')) return;
    await api.del(`/api/admin/modules/${id}`); loadAll(); toast('已删除');
  };
  const addMapping = async () => {
    if (!pform.platform_name || !pform.platform_key || !pform.code_module_id) return toast('请填平台模块并选择代码模块');
    try {
      await api.post('/api/admin/mappings', { ...pform, code_module_id: +pform.code_module_id });
      setPform({ platform_name: '', platform_key: '', code_module_id: '', path_prefix: '' });
      loadAll(); toast('平台模块映射已创建');
    } catch (e: any) { toast(e.message); }
  };
  const delMapping = async (id: number) => { await api.del(`/api/admin/mappings/${id}`); loadAll(); };

  const syncTag = (s: string) => s === 'OK' ? <span className="tag tag-green"><span className="dot ok" />已同步</span>
    : s === 'SYNCING' ? <span className="tag tag-blue">同步中…</span>
    : s === 'FAILED' ? <span className="tag tag-red">失败</span>
    : <span className="tag tag-grey">未拉取</span>;

  return (
    <div className="stack">
      <div className="topbar">
        <div>
          <div className="crumb">管理后台</div>
          <h1>模块管理</h1>
        </div>
      </div>
      {/* GitLab 连接配置 */}
      <div className="card card-pad">
        <div className="row" style={{ marginBottom: 4 }}>
          <b>GitLab 连接</b>
          <span className="muted">AI 评审与研发提示词的代码来源</span>
        </div>
        <div className="grid2" style={{ marginTop: 12 }}>
          <div className="form-row"><label>GitLab Base URL</label>
            <input className="input" placeholder="https://gitlab.company.com" value={cfg.base_url} onChange={(e) => setCfg({ ...cfg, base_url: e.target.value })} /></div>
          <div className="form-row"><label>Private Access Token{cfg.token_set && <span className="muted">(已配置,留空则不修改)</span>}</label>
            <input className="input" type="password" placeholder="glpat-…(需 read_api + read_repository 权限)" value={cfg.token} onChange={(e) => setCfg({ ...cfg, token: e.target.value })} /></div>
        </div>
        <div className="row">
          <button className="btn btn-primary" onClick={saveCfg}>保存配置</button>
          <button className="btn" onClick={test}>测试连接</button>
          {testRes && (
            testRes.ok
              ? <span className="tag tag-green"><span className="dot ok" />已连接为 {testRes.user}{testRes.project_count != null ? ` · 可见 ${testRes.project_count} 个项目` : ''}</span>
              : <span className="tag tag-red">{testRes.error}</span>
          )}
        </div>
      </div>

      <div className="split" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {/* 代码模块 */}
        <div className="card card-pad">
          <div className="row" style={{ marginBottom: 10 }}>
            <b>代码模块</b>
            <span className="muted">GitLab 仓库的本地快照</span>
            <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={loadProjects}>加载 GitLab 项目</button>
          </div>
          <div className="card card-pad" style={{ background: 'var(--panel-2)', marginBottom: 14 }}>
            <div className="grid2">
              <div className="form-row"><label>模块 Key *</label>
                <input className="input" placeholder="usercenter" value={mform.module_key} onChange={(e) => setMform({ ...mform, module_key: e.target.value })} /></div>
              <div className="form-row"><label>显示名 *</label>
                <input className="input" placeholder="用户中心" value={mform.name} onChange={(e) => setMform({ ...mform, name: e.target.value })} /></div>
              <div className="form-row"><label>GitLab 项目 *</label>
                <select className="input" value={mform.gitlab_project_id} onChange={(e) => onPickProject(e.target.value)}>
                  <option value="">{projects.length ? '请选择项目' : '先点上方「加载 GitLab 项目」'}</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.path}</option>)}
                </select></div>
              <div className="form-row"><label>分支</label>
                <select className="input" value={mform.branch} onChange={(e) => setMform({ ...mform, branch: e.target.value })}>
                  {!branches.length && <option value={mform.branch}>{mform.branch}</option>}
                  {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                </select></div>
              <div className="form-row" style={{ gridColumn: '1 / -1' }}><label>子路径(monorepo 可选)</label>
                <input className="input" placeholder="如 services/user(留空取整个仓库)" value={mform.sub_path} onChange={(e) => setMform({ ...mform, sub_path: e.target.value })} /></div>
            </div>
            <button className="btn btn-primary btn-sm" onClick={addModule}>+ 创建代码模块</button>
          </div>
          {modules.length === 0 && <div className="empty" style={{ padding: '28px 10px' }}>尚未配置代码模块</div>}
          {modules.map((m) => (
            <div className="module-item" key={m.id}>
              <div className="mi-head">
                <span className="mi-key">{m.module_key}</span>
                <b>{m.name}</b>
                {syncTag(m.sync_status)}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {m.gitlab_project_path || m.gitlab_project_id} · {m.branch}{m.sub_path ? ` · ${m.sub_path}` : ''}
                {m.commit_sha ? ` · ${m.commit_sha.slice(0, 8)}` : ''}
              </div>
              {m.last_synced_at && <div className="muted" style={{ fontSize: 11 }}>上次同步 {m.last_synced_at} · {m.file_count} 个文件{m.error_msg ? ` · ${m.error_msg}` : ''}</div>}
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn btn-sm btn-primary" disabled={syncing[m.id] || m.sync_status === 'SYNCING'} onClick={() => sync(m.id)}>
                  {syncing[m.id] ? '拉取中…' : m.sync_status === 'OK' ? '重新拉取' : '拉取代码'}
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => delModule(m.id)}>删除</button>
              </div>
            </div>
          ))}
        </div>

        {/* 平台模块映射 */}
        <div className="card card-pad">
          <div className="row" style={{ marginBottom: 10 }}>
            <b>平台模块映射</b>
            <span className="muted">业务视角 → 代码模块</span>
          </div>
          <div className="card card-pad" style={{ background: 'var(--panel-2)', marginBottom: 14 }}>
            <div className="grid2">
              <div className="form-row"><label>平台模块名 *</label>
                <input className="input" placeholder="用户中心" value={pform.platform_name} onChange={(e) => setPform({ ...pform, platform_name: e.target.value })} /></div>
              <div className="form-row"><label>平台 Key *</label>
                <input className="input" placeholder="user-center" value={pform.platform_key} onChange={(e) => setPform({ ...pform, platform_key: e.target.value })} /></div>
              <div className="form-row"><label>映射到代码模块 *</label>
                <select className="input" value={pform.code_module_id} onChange={(e) => setPform({ ...pform, code_module_id: e.target.value })}>
                  <option value="">请选择</option>
                  {modules.map((m) => <option key={m.id} value={m.id}>{m.name}({m.module_key})</option>)}
                </select></div>
              <div className="form-row"><label>路径前缀(可选)</label>
                <input className="input" placeholder="如 src/main" value={pform.path_prefix} onChange={(e) => setPform({ ...pform, path_prefix: e.target.value })} /></div>
            </div>
            <button className="btn btn-primary btn-sm" onClick={addMapping}>+ 建立映射</button>
          </div>
          {mappings.length === 0 && <div className="empty" style={{ padding: '28px 10px' }}>尚未建立映射,CSM 提需求时将无法选择模块</div>}
          {mappings.map((mp) => (
            <div className="module-item" key={mp.id}>
              <div className="mi-head">
                <b>{mp.platform_name}</b>
                <span className="pill">{mp.platform_key}</span>
                <span className="muted" style={{ fontSize: 12 }}>→ {mp.code_module_name}({mp.module_key})</span>
                {syncTag(mp.sync_status || 'IDLE')}
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn btn-sm btn-danger" onClick={() => delMapping(mp.id)}>删除映射</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card card-pad" style={{ background: 'color-mix(in srgb, var(--info) 5%, var(--panel))' }}>
        <b style={{ fontSize: 13 }}>使用说明</b>
        <ol className="muted" style={{ marginTop: 8, paddingLeft: 18, lineHeight: 1.9, fontSize: 12.5 }}>
          <li>配置 GitLab 地址与只读 Token → 测试连接。</li>
          <li>「加载 GitLab 项目」→ 选择项目创建<b>代码模块</b> → 点「拉取代码」生成快照。</li>
          <li>建立<b>平台模块映射</b>(如「用户中心」→ usercenter 仓库)。</li>
          <li>CSM 提交需求时按<b>平台模块</b>多选;AI 评审/研发提示词自动读取对应代码做可行性分析与代码级指引。</li>
        </ol>
      </div>
    </div>
  );
}

/* ---------------- 主题 ---------------- */
function Theme() {
  const { theme, refreshTheme, toast } = useApp();
  const [primary, setPrimary] = useState(theme.primary);
  const [mode, setMode] = useState(theme.mode);
  useEffect(() => { setPrimary(theme.primary); setMode(theme.mode); }, [theme]);

  const presets = ['#4f7cff', '#7c5cff', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6'];
  const save = async () => {
    await api.put('/api/settings/theme', { primary, mode });
    await refreshTheme(); toast('主题已更新');
  };
  // 实时预览
  useEffect(() => {
    document.documentElement.style.setProperty('--primary', primary);
    document.documentElement.dataset.mode = mode;
  }, [primary, mode]);

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="crumb">管理后台</div>
          <h1>外观主题</h1>
        </div>
      </div>
      <div className="card card-pad" style={{ maxWidth: 560 }}>
      <b>界面外观</b>
      <div className="form-row" style={{ marginTop: 14 }}>
        <label>主题色</label>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {presets.map((c) => (
            <button key={c} onClick={() => setPrimary(c)} style={{
              width: 34, height: 34, borderRadius: 9, background: c, border: primary === c ? '3px solid var(--text)' : '2px solid transparent',
            }} />
          ))}
          <input type="color" value={primary} onChange={(e) => setPrimary(e.target.value)}
            style={{ width: 34, height: 34, border: 'none', background: 'none', padding: 0 }} />
        </div>
      </div>
      <div className="form-row">
        <label>模式</label>
        <div className="row">
          {[['light', '浅色'], ['dark', '深色']].map(([m, label]) => (
            <button key={m} className={`btn ${mode === m ? 'btn-primary' : ''}`} onClick={() => setMode(m)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="form-row">
        <label>预览</label>
        <div className="row">
          <button className="btn btn-primary">主要按钮</button>
          <span className="tag tag-blue">标签</span>
          <div className="step cur"><span className="dot" /><span className="ai-badge">AI</span>节点</div>
        </div>
      </div>
      <button className="btn btn-primary" onClick={save}>保存</button>
      </div>
    </div>
  );
}

/* ---------------- 总览 ---------------- */
function Stats() {
  const [s, setS] = useState<any>(null);
  useEffect(() => { api.get('/api/admin/stats').then(setS); }, []);
  if (!s) return null;
  const statusName: Record<string, string> = {
    DRAFT: '草稿', SUBMITTED: '已提交', AI_RUNNING: 'AI 处理中', CLARIFYING: '待澄清',
    PENDING: '待处理', DONE: '已完成', CANCELLED: '已取消',
  };
  return (
    <div>
      <div className="topbar">
        <div>
          <div className="crumb">管理后台</div>
          <h1>数据总览</h1>
        </div>
      </div>
      <div className="grid3" style={{ marginBottom: 16 }}>
        {[['需求总数', s.requirements], ['成员数', s.users], ['完成数', s.byStatus.find((x: any) => x.status === 'DONE')?.n || 0]].map(([label, v]) => (
          <div className="card card-pad" key={label as string}>
            <div className="muted">{label}</div>
            <div style={{ fontSize: 28, fontWeight: 700, marginTop: 6, color: 'var(--primary)' }}>{v}</div>
          </div>
        ))}
      </div>
      <div className="grid2">
        <div className="card card-pad">
          <b>按状态分布</b>
          <table className="tbl" style={{ marginTop: 10 }}>
            <tbody>
              {s.byStatus.map((x: any) => (
                <tr key={x.status}><td>{statusName[x.status] || x.status}</td><td style={{ textAlign: 'right' }}>{x.n}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card card-pad">
          <b>按改动等级</b>
          <table className="tbl" style={{ marginTop: 10 }}>
            <tbody>
              {s.byLevel.length === 0 && <tr><td className="muted">暂无数据</td></tr>}
              {s.byLevel.map((x: any) => (
                <tr key={x.level}><td><span className="tag tag-blue">{x.level}</span></td><td style={{ textAlign: 'right' }}>{x.n}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
