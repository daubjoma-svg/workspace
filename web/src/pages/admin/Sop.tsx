import React, { useEffect, useState } from 'react';
import { api, SopNode, AI_ACTIONS, ROLE_NAME } from '../../api';
import { useApp } from '../../App';
import { Icon } from '../../components/Icon';
import { SearchSelect } from '../../components/SearchSelect';
import { ConfirmModal } from '../../components/ConfirmModal';

export default function Sop() {
  const { toast } = useApp();
  const [tpls, setTpls] = useState<any[]>([]);
  const [cur, setCur] = useState<number | null>(null);
  const [nodes, setNodes] = useState<Partial<SopNode>[]>([]);
  const [dirty, setDirty] = useState(false);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  /** 统一弹窗状态：null=关闭；{type:'new'|'rename',id} 打开输入弹窗；{type:'delete',id} 删除确认 */
  const [dlg, setDlg] = useState<{ type: 'new' | 'rename' | 'delete'; id?: number; name?: string } | null>(null);

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
  const addTpl = () => setDlg({ type: 'new' });
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
            <div className="row" style={{ alignItems: 'center' }}>
              <div style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
              <button className="btn btn-sm btn-icon" style={{ flexShrink: 0 }} title="复制此模板（含所有节点）"
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    const r = await api.post(`/api/admin/sop-templates/${t.id}/clone`, {});
                    toast(`已复制：${r.name}（${r.node_count} 节点）`);
                    await load();
                    setCur(r.id);
                  } catch (err: any) { toast(err.message, 'error'); }
                }} aria-label="复制模板">
                <Icon name="copy" size={16} />
              </button>
              {!t.is_system && (
                <>
                  <button className="btn btn-sm btn-icon" style={{ flexShrink: 0 }} title="重命名"
                    onClick={(e) => { e.stopPropagation(); setDlg({ type: 'rename', id: t.id, name: t.name }); }} aria-label="重命名">
                    <Icon name="edit" size={16} />
                  </button>
                  <button className="btn btn-sm btn-icon" style={{ flexShrink: 0, color: 'var(--danger-ink)' }} title="删除模板"
                    onClick={(e) => { e.stopPropagation(); setDlg({ type: 'delete', id: t.id, name: t.name }); }} aria-label="删除模板">
                    <Icon name="x" size={16} />
                  </button>
                </>
              )}
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              {!!t.is_system && <span className="tag tag-blue">系统内置</span>}
              {!!t.is_default && <span className="tag tag-green">默认</span>}
              {!t.is_default && <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setDefault(t.id); }}>设为默认</button>}
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
                        <SearchSelect
                          options={Object.entries(AI_ACTIONS).map(([k, v]) => ({ value: k, label: v }))}
                          value={n.ai_action || 'CUSTOM'}
                          disabled={readonly}
                          onChange={(v) => set(i, { ai_action: String(v) })}
                          placeholder="请选择 AI 动作"
                        /></div>
                    ) : (
                      <div className="form-row"><label>负责角色</label>
                        <SearchSelect
                          options={[{ value: '', label: '无人' }, ...['CSM', 'PO', 'RD', 'QA'].map((r) => ({ value: r, label: ROLE_NAME[r] }))]}
                          value={n.role ?? ''}
                          disabled={readonly}
                          onChange={(v) => set(i, { role: String(v) })}
                          placeholder="请选择负责角色"
                        /></div>
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

      {/* 统一弹窗：新建/重命名（输入框）/删除（确认） */}
      {dlg?.type === 'new' && (
        <ConfirmModal
          title="新建流程模板"
          inputPlaceholder="模板名称，如：标准交付流程 - 变体A"
          confirmText="创建"
          onCancel={() => setDlg(null)}
          onConfirm={async (name) => {
            if (!name) return;
            await api.post('/api/admin/sop-templates', { name });
            setDlg(null); setCur(null); load(); toast('已创建');
          }}
        />
      )}
      {dlg?.type === 'rename' && (
        <ConfirmModal
          title="重命名流程模板"
          inputPlaceholder="模板名称"
          inputDefault={dlg.name}
          confirmText="保存"
          onCancel={() => setDlg(null)}
          onConfirm={async (name) => {
            if (!name || name === dlg.name) return setDlg(null);
            try { await api.put(`/api/admin/sop-templates/${dlg.id}`, { name }); setDlg(null); await load(); toast('已重命名'); }
            catch (err: any) { toast(err.message, 'error'); }
          }}
        />
      )}
      {dlg?.type === 'delete' && (
        <ConfirmModal
          title="删除流程模板"
          message={`删除模板「${dlg.name}」？该操作不可恢复。`}
          confirmText="删除"
          danger
          onCancel={() => setDlg(null)}
          onConfirm={async () => {
            try { await api.del(`/api/admin/sop-templates/${dlg.id}`); setDlg(null); await load(); toast('已删除'); }
            catch (err: any) { toast(err.message, 'error'); }
          }}
        />
      )}
    </div>
  );
}
