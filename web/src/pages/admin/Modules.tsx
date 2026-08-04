import React, { useEffect, useState } from 'react';
import { api, CodeModule, ModuleMapping } from '../../api';
import { useApp } from '../../App';

export default function Modules() {
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
