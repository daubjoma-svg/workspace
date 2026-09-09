import React, { useEffect, useState } from 'react';
import { api, CodeModule, BusinessModule } from '../../api';
import { useApp } from '../../App';
import { Icon } from '../../components/Icon';
import { SecretInput } from '../../components/SecretInput';
import { SearchSelect } from '../../components/SearchSelect';
import { ConfirmModal } from '../../components/ConfirmModal';

/**
 * 模块管理（v0.7 重构版）
 *
 * 左侧 1/3 — 代码仓库：
 *   加载 GitLab 项目 → 下拉选项目 → 添到代码仓库列表（自动从 GitLab 取名+路径）→ 同步 master
 *   编辑：sub_path（monorepo 子路径，可选）
 *
 * 右侧 2/3 — 业务模块：
 *   业务模块卡片：name + 描述 + 挂载的代码仓库 chips
 *   挂代码：弹窗从代码仓库列表选一个
 *
 * 砍掉了：粘贴代码（PASTE）、独立 Git token、module_key/name/description 手动输入
 */
export default function Modules() {
  const { toast } = useApp();
  const [codeModules, setCodeModules] = useState<CodeModule[]>([]);
  const [businessModules, setBusinessModules] = useState<BusinessModule[]>([]);
  const [gitlabProjects, setGitlabProjects] = useState<any[]>([]);
  const [gitlabCfg, setGitlabCfg] = useState({ base_url: '', token: '', token_set: false });
  const [showGitCfg, setShowGitCfg] = useState(false);
  const [busy, setBusy] = useState(false);

  // 业务模块编辑弹窗：editingBm 用 sentinel true 表示「新建模式」（null 关闭弹窗）
  const [editingBm, setEditingBm] = useState<BusinessModule | true | null>(null);
  const [bmForm, setBmForm] = useState({ name: '', description: '' });
  // 业务模块挂代码弹窗
  const [linkingBm, setLinkingBm] = useState<BusinessModule | null>(null);
  const [linkForm, setLinkForm] = useState({ code_module_id: '', path_prefix: '' });
  /** 统一删除确认弹窗：{type:'code',m} 删仓库 / {type:'biz',bm} 删业务模块 */
  const [delDlg, setDelDlg] = useState<{ type: 'code' | 'biz'; id: number; name: string } | null>(null);

  const loadAll = async () => {
    const [cm, bm, cfg] = await Promise.all([
      api.get('/api/admin/modules'),
      api.get('/api/admin/business-modules'),
      api.get('/api/admin/gitlab/config'),
    ]);
    setCodeModules(cm || []);
    setBusinessModules(bm || []);
    setGitlabCfg({ base_url: cfg?.base_url || '', token: '', token_set: !!cfg?.token_set });
  };
  useEffect(() => { loadAll(); }, []);

  const loadProjects = async () => {
    setBusy(true);
    try {
      const list = await api.get('/api/admin/gitlab/projects');
      setGitlabProjects(list || []);
      toast(`已加载 ${list?.length || 0} 个 GitLab 项目`);
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };

  const saveGitCfg = async () => {
    await api.put('/api/admin/gitlab/config', { base_url: gitlabCfg.base_url, token: gitlabCfg.token.trim() || undefined });
    toast('GitLab 配置已保存');
    await loadAll();
  };
  const testGit = async () => {
    try {
      const r = await api.get('/api/admin/gitlab/test');
      if (r.ok) toast(`连接成功: ${r.user}`);
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const addCode = async (gitlab_project_id: string) => {
    const p = gitlabProjects.find((x) => String(x.id) === String(gitlab_project_id));
    if (!p) return;
    try {
      await api.post('/api/admin/modules', { gitlab_project_id, gitlab_project_path: p.path || p.name });
      toast(`已添加 ${p.path || p.name}`);
      await loadAll();
    } catch (e: any) {
      // 重复添加：信息提示而非错误（前端过滤后基本不会触发，留兜底）
      const msg = e.message || '添加失败';
      if (msg.includes('已添加')) toast(`该 GitLab 项目已添加（前端已过滤，可能服务缓存未刷新）`);
      else toast(msg, 'error');
    }
  };
  const syncCode = async (id: number) => {
    setBusy(true);
    try {
      const r = await api.post(`/api/admin/modules/${id}/sync`, {});
      toast(`已同步 ${r.file_count} 个文件`);
      await loadAll();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  const removeCode = async (m: CodeModule) => {
    try { await api.del(`/api/admin/modules/${m.id}`); setDelDlg(null); toast('已删除'); await loadAll(); }
    catch (e: any) { toast(e.message, 'error'); }
  };
  const editCodePath = async (id: number, sub_path: string) => {
    try { await api.put(`/api/admin/modules/${id}`, { sub_path }); toast('已保存'); await loadAll(); }
    catch (e: any) { toast(e.message, 'error'); }
  };

  // 业务模块 CRUD
  const openBm = (bm: BusinessModule | null) => {
    // 新建模式：sentinel true；编辑模式：传 BusinessModule；关闭：null
    setEditingBm(bm ?? true);
    setBmForm(bm ? { name: bm.name, description: bm.description || '' } : { name: '', description: '' });
  };
  const saveBm = async () => {
    if (!bmForm.name.trim()) return toast('请填写业务模块名');
    try {
      // editingBm 是 true（新建）或 BusinessModule（编辑）
      if (editingBm && typeof editingBm !== 'boolean') await api.put(`/api/admin/business-modules/${editingBm.id}`, bmForm);
      else await api.post('/api/admin/business-modules', bmForm);
      toast('已保存');
      setEditingBm(null);
      await loadAll();
    } catch (e: any) { toast(e.message, 'error'); }
  };
  const removeBm = async (bm: BusinessModule) => {
    try { await api.del(`/api/admin/business-modules/${bm.id}`); setDelDlg(null); toast('已删除'); await loadAll(); }
    catch (e: any) { toast(e.message, 'error'); }
  };

  // 业务模块挂代码
  const openLink = (bm: BusinessModule) => {
    setLinkingBm(bm);
    setLinkForm({ code_module_id: '', path_prefix: '' });
  };
  const linkCode = async () => {
    if (!linkingBm || !linkForm.code_module_id) return toast('请选择代码仓库');
    try {
      await api.post(`/api/admin/business-modules/${linkingBm.id}/codes`, {
        code_module_id: Number(linkForm.code_module_id),
        path_prefix: linkForm.path_prefix,
      });
      toast('已挂载');
      setLinkingBm(null);
      await loadAll();
    } catch (e: any) { toast(e.message, 'error'); }
  };
  const unlinkCode = async (bm: BusinessModule, codeId: number) => {
    try { await api.del(`/api/admin/business-modules/${bm.id}/codes/${codeId}`); toast('已卸'); await loadAll(); }
    catch (e: any) { toast(e.message, 'error'); }
  };

  const unlinked = codeModules.filter((cm) => !businessModules.some((bm) => bm.codes.some((c) => c.code_module_id === cm.id)));

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="crumb">管理后台</div>
          <h1>模块管理</h1>
        </div>
      </div>

      {/* GitLab 连接 — 默认折叠（业务模块/代码仓库核心流程不依赖） */}
      <div className="card card-pad" style={{ padding: 0, marginBottom: 16 }}>
        <button type="button" onClick={() => setShowGitCfg((s) => !s)} className="row" style={{ width: '100%', padding: '14px 16px', border: 'none', background: 'none', color: 'var(--text)', cursor: 'pointer', textAlign: 'left' }}>
          <Icon name={showGitCfg ? 'chevron-down' : 'chevron-right'} size={16} />
          <b>GitLab 连接</b>
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>添加 GitLab 仓库需要；已有代码仓库则用同步</span>
          {gitlabCfg.token_set && <span className="tag tag-green" style={{ marginLeft: 'auto' }}>已配置</span>}
        </button>
        {showGitCfg && (
          <div style={{ padding: '0 16px 16px' }}>
            <div className="grid2" style={{ marginTop: 8 }}>
              <div className="form-row"><label>Base URL</label>
                <input className="input" placeholder="https://gitlab.company.com" value={gitlabCfg.base_url} onChange={(e) => setGitlabCfg({ ...gitlabCfg, base_url: e.target.value })} /></div>
              <div className="form-row"><label>Private Access Token{gitlabCfg.token_set && <span className="muted">（已配置，留空则不修改）</span>}</label>
                <SecretInput
                  value={gitlabCfg.token}
                  onChange={(v) => setGitlabCfg((c) => ({ ...c, token: v }))}
                  hasStored={gitlabCfg.token_set}
                  onReveal={async () => { const r = await api.get('/api/admin/gitlab/token'); return r?.token || ''; }}
                  placeholder={gitlabCfg.token_set ? '已配置，留空则不修改' : 'glpat-…（需 read_api + read_repository 权限）'}
                /></div>
            </div>
            <div className="row">
              <button className="btn btn-primary" onClick={saveGitCfg}>保存配置</button>
              <button className="btn" onClick={testGit}>测试连接</button>
            </div>
          </div>
        )}
      </div>

      <div className="split" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* 左：代码仓库 */}
        <div className="card card-pad">
          <div className="row" style={{ marginBottom: 12 }}>
            <b>代码仓库</b>
            <span className="muted" style={{ fontSize: 12 }}>{codeModules.length} 个</span>
            <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={loadProjects} disabled={busy}>
              <Icon name="refresh" size={16} /> 加载 GitLab 项目
            </button>
          </div>

          {gitlabProjects.length > 0 && (() => {
            // 过滤已添加的 GitLab 项目（避免下拉选了重复的导致 UNIQUE 冲突 400）
            const added = new Set(codeModules.map((c) => String(c.gitlab_project_id)));
            const available = gitlabProjects.filter((p) => !added.has(String(p.id)));
            if (available.length === 0) {
              return <div className="muted" style={{ fontSize: 12, padding: 8 }}>所有加载的 GitLab 项目都已添加为代码仓库</div>;
            }
            return (
              <div className="form-row">
                <SearchSelect
                  options={available.map((p) => ({ value: String(p.id), label: p.path || p.name, subLabel: p.name }))}
                  value=""
                  onChange={(v) => v && addCode(String(v))}
                  placeholder="下拉选 GitLab 项目添加为代码仓库（已添加的自动隐藏）"
                  emptyText="无可添加的 GitLab 项目"
                />
              </div>
            );
          })()}

          {codeModules.length === 0 ? (
            <div className="empty" style={{ padding: '28px 10px', textAlign: 'center' }}>
              尚未添加代码仓库
              <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>展开顶部「GitLab 连接」→「加载 GitLab 项目」→ 下拉选</div>
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {codeModules.map((m) => (
                <li key={m.id} style={{ borderTop: '1px solid var(--border)', padding: '12px 0' }}>
                  <div className="row" style={{ alignItems: 'center' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="mono" style={{ fontWeight: 600, fontSize: 13 }}>{m.gitlab_project_path || m.gitlab_project_id}</div>
                      <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                        {m.sync_status === 'OK' && <span className="tag tag-green" style={{ marginRight: 6 }}>已同步</span>}
                        {m.sync_status === 'FAILED' && <span className="tag tag-red" style={{ marginRight: 6 }}>失败</span>}
                        {m.sync_status === 'SYNCING' && <span className="tag tag-blue" style={{ marginRight: 6 }}>同步中</span>}
                        {m.sync_status === 'IDLE' && <span className="tag tag-grey" style={{ marginRight: 6 }}>未同步</span>}
                        master · {m.file_count || 0} 文件
                      </div>
                    </div>
                    <button className="btn btn-sm" onClick={() => syncCode(m.id)} disabled={busy} title="拉取代码">
                      <Icon name="refresh" size={16} /> 拉取
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => setDelDlg({ type: 'code', id: m.id, name: m.gitlab_project_path || m.gitlab_project_id })}>删除</button>
                  </div>
                  {m.error_msg && <div className="muted" style={{ color: 'var(--danger-ink)', fontSize: 11, marginTop: 4 }}>{m.error_msg.slice(0, 80)}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 右：业务模块 */}
        <div className="card card-pad">
          <div className="row" style={{ marginBottom: 12 }}>
            <b>业务模块</b>
            <span className="muted" style={{ fontSize: 12 }}>{businessModules.length} 个</span>
            <button className="btn btn-sm btn-primary" style={{ marginLeft: 'auto' }} onClick={() => openBm(null)}>
              <Icon name="plus" size={16} /> 新建业务模块
            </button>
          </div>

          {businessModules.length === 0 ? (
            <div className="empty" style={{ padding: '28px 10px', textAlign: 'center' }}>
              尚未配置业务模块
              <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>需求发起人提单时按业务模块关联 AI 代码上下文</div>
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {businessModules.map((bm) => (
                <li key={bm.id} style={{ borderTop: '1px solid var(--border)', padding: '12px 0' }}>
                  <div className="row" style={{ alignItems: 'center' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{bm.name}</div>
                      {bm.description && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{bm.description}</div>}
                    </div>
                    <button className="btn btn-sm" onClick={() => openBm(bm)}>编辑</button>
                    <button className="btn btn-sm btn-danger" onClick={() => setDelDlg({ type: 'biz', id: bm.id, name: bm.name })}>删除</button>
                  </div>
                  {/* 挂载的代码仓库 chips */}
                  <div style={{ marginTop: 8 }}>
                    {bm.codes.length === 0 ? (
                      <div className="muted" style={{ fontSize: 11, fontStyle: 'italic' }}>未挂载代码仓库</div>
                    ) : (
                      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                        {bm.codes.map((c) => (
                          <span key={c.code_module_id} className={`tag ${c.sync_status === 'OK' ? 'tag-green' : 'tag-grey'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <Icon name="code-branch" size={16} /> {c.gitlab_project_path || c.gitlab_project_id}
                            {c.path_prefix && <span className="muted" style={{ fontSize: 10 }}>· {c.path_prefix}</span>}
                            <button type="button" onClick={() => unlinkCode(bm, c.code_module_id)} aria-label="卸下" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, marginLeft: 2 }}>
                              <Icon name="x" size={16} />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => openLink(bm)}>
                      <Icon name="plus" size={16} /> 挂代码
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {unlinked.length > 0 && (
            <div className="muted" style={{ fontSize: 11, marginTop: 8, padding: 8, background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
              还有 {unlinked.length} 个仓库未挂载：{unlinked.map((c) => c.gitlab_project_path || c.gitlab_project_id).join('、')}
            </div>
          )}
        </div>
      </div>

      {/* 业务模块编辑弹窗 */}
      {editingBm && (
        <div className="modal-mask" onClick={() => setEditingBm(null)}>
          <div className="modal card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-h">
                            {editingBm && typeof editingBm !== 'boolean' ? '编辑业务模块' : '新建业务模块'}
              <button className="btn btn-sm btn-icon" onClick={() => setEditingBm(null)} aria-label="关闭">
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="modal-b">
              <div className="form-row"><label>业务模块名 *</label>
                <input className="input" value={bmForm.name} onChange={(e) => setBmForm({ ...bmForm, name: e.target.value })} placeholder="如：用户中心 / 订单中心 / 营销活动" autoFocus />
              </div>
              <div className="form-row"><label>描述</label>
                <textarea className="input" rows={3} value={bmForm.description} onChange={(e) => setBmForm({ ...bmForm, description: e.target.value })} placeholder="可选" />
              </div>
            </div>
            <div className="modal-f">
              <button className="btn" onClick={() => setEditingBm(null)}>取消</button>
              <button className="btn btn-primary" onClick={saveBm}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 挂代码弹窗 */}
      {linkingBm && (
        <div className="modal-mask" onClick={() => setLinkingBm(null)}>
          <div className="modal card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-h">
              挂代码到「{linkingBm.name}」
              <button className="btn btn-sm btn-icon" onClick={() => setLinkingBm(null)} aria-label="关闭">
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="modal-b">
              <div className="form-row"><label>代码仓库 *</label>
                <SearchSelect
                  options={unlinked.map((c) => ({ value: String(c.id), label: c.gitlab_project_path || c.gitlab_project_id }))}
                  value={linkForm.code_module_id}
                  onChange={(v) => setLinkForm({ ...linkForm, code_module_id: String(v) })}
                  placeholder="选择要挂的代码仓库（仅显示未挂载的）"
                />
              </div>
              <div className="form-row"><label>子路径前缀（可选）</label>
                <input className="input" value={linkForm.path_prefix} onChange={(e) => setLinkForm({ ...linkForm, path_prefix: e.target.value })} placeholder="如 src/main/java（monorepo 子目录）" />
                <div className="hint">不填则取该仓库的全部代码</div>
              </div>
            </div>
            <div className="modal-f">
              <button className="btn" onClick={() => setLinkingBm(null)}>取消</button>
              <button className="btn btn-primary" onClick={linkCode} disabled={!linkForm.code_module_id}>挂载</button>
            </div>
          </div>
        </div>
      )}

      {/* 统一删除确认弹窗 */}
      {delDlg?.type === 'code' && (
        <ConfirmModal
          title="删除代码仓库"
          message={`删除代码仓库「${delDlg.name}」？该操作不可恢复。`}
          confirmText="删除"
          danger
          onCancel={() => setDelDlg(null)}
          onConfirm={() => removeCode({ id: delDlg.id } as CodeModule)}
        />
      )}
      {delDlg?.type === 'biz' && (
        <ConfirmModal
          title="删除业务模块"
          message={`删除业务模块「${delDlg.name}」？其挂载关系也会一并删除。`}
          confirmText="删除"
          danger
          onCancel={() => setDelDlg(null)}
          onConfirm={() => removeBm({ id: delDlg.id } as BusinessModule)}
        />
      )}
    </div>
  );
}
