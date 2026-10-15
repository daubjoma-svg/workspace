import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useApp } from '../../App';
import { Icon } from '../../components/Icon';
import ProviderModal, { Provider } from './ProviderModal';
import { ConfirmModal } from '../../components/ConfirmModal';

/**
 * AI 配置页（v2：Agent + 模型组 风格）
 *  - 顶部 Agent 区：4 类 Agent 卡片（Claude / Codex / Kimi），每卡片有 logo + 启用开关
 *    "启用" = 该 agent 下任意一个 provider 处于 enabled 状态
 *  - 下方模型组：选中一个 Agent 后展示该 Agent 下的所有 model（来自 ai_providers 表）
 *    每行：开关 + 模型 ID + 显示名 + 推理档下拉 + 删除
 *  - 「> 从 CLI 检测」扫描本地已安装的 claude/codex/kimi CLI 工具（新增模型仅走此入口）
 *  - 「保存模型组」即时保存（每次改动直接 PUT/POST/DELETE）
 */

// Agent 类型定义（前端硬编码 + 后端 type 映射）
interface AgentDef {
  id: string;            // 用于前端归类
  label: string;         // 显示名
  type: string;          // 落库到 ai_providers.type 的值
  color: string;         // logo 背景色
  emoji: string;         // 占位 logo
  baseUrl: string;       // 新建 provider 时默认值
  defaultModel: string;  // 新建 provider 时默认 model
}

const AGENTS: AgentDef[] = [
  { id: 'claude', label: 'Claude', type: 'anthropic',     color: '#d97706', emoji: '🟠', baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-20250514' },
  { id: 'codex',  label: 'Codex',  type: 'openai-compat', color: '#10a37f', emoji: '🟢', baseUrl: 'https://api.openai.com',     defaultModel: 'gpt-5.6' },
  // Trae：走本机 traecli 进程（type=trae-cli）。填 trae-lt-xxx CLI 登录令牌即可用；留空则用本机已登录态
  { id: 'trae',   label: 'Trae',   type: 'trae-cli',      color: '#3b82f6', emoji: '🔵', baseUrl: '',                        defaultModel: '' },
  { id: 'kimi',   label: 'Kimi',   type: 'openai-compat', color: '#1d4ed8', emoji: '🌙', baseUrl: 'https://api.moonshot.cn',    defaultModel: 'kimi-k2-0905-preview' },
];

// 推理档下拉选项（与后端 capability 字段对齐）
const REASONING_OPTIONS = [
  { value: 'json_schema',  label: '默认档（强约束）' },
  { value: 'json_object',  label: '精确档（弱约束）' },
  { value: 'prompt_only',  label: '创造档（无约束）' },
];

export default function AiProviders() {
  const { toast } = useApp();
  const [list, setList] = useState<Provider[]>([]);
  const [adding, setAdding] = useState(false);
  const [addingAgentId, setAddingAgentId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [delP, setDelP] = useState<Provider | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string>('codex');
  const [scanning, setScanning] = useState(false);

  /** 把 provider 按 agent id 归类（与下方 grouped 一致），供默认选中 + 检测用 */
  const agentOf = (p: any): string | null => {
    if (p.type === 'anthropic') return 'claude';
    if (p.type === 'trae-cli' || p.name?.toLowerCase().includes('trae')) return 'trae';
    if (p.base_url?.includes('moonshot') || p.base_url?.includes('kimi') || p.name?.toLowerCase().includes('kimi')) return 'kimi';
    return 'codex';
  };
  const load = async () => {
    const data = await api.get('/api/admin/ai-providers');
    setList(data);
    // 默认选中第一个有启用 provider 的 agent（用户进页面看到「能用」的那个）
    setSelectedAgent((cur) => {
      const enabledIds = new Set(data.filter((p: any) => p.enabled).map((p: any) => agentOf(p)).filter(Boolean));
      if (enabledIds.has(cur)) return cur;
      for (const a of AGENTS) if (enabledIds.has(a.id)) return a.id;
      // 都没启用：选中第一个有 provider 的
      const hasAny = new Set(data.map((p: any) => agentOf(p)).filter(Boolean));
      for (const a of AGENTS) if (hasAny.has(a.id)) return a.id;
      return cur;
    });
  };
  useEffect(() => { load(); }, []);

  // 按 agent id 归类 providers
  const grouped = useMemo(() => {
    const m: Record<string, Provider[]> = { claude: [], codex: [], trae: [], kimi: [] };
    list.forEach((p) => {
      // 按 type 匹配
      if (p.type === 'anthropic') m.claude.push(p);
      else if (p.type === 'trae-cli' || p.name?.toLowerCase().includes('trae')) m.trae.push(p);
      else if (p.base_url?.includes('moonshot') || p.base_url?.includes('kimi') || p.name?.toLowerCase().includes('kimi')) m.kimi.push(p);
      else m.codex.push(p); // 默认 openai-compat 归到 codex
    });
    return m;
  }, [list]);

  // 每个 agent 是否有 enabled provider
  const agentEnabled = (agentId: string) => grouped[agentId]?.some((p) => p.enabled) || false;

  const closeModal = () => { setAdding(false); setEditing(null); setAddingAgentId(null); };
  const reload = () => { closeModal(); load(); };

  // Agent 整体开关：开 = 把该 agent 下所有 provider enabled（保证至少一个 active）；关 = 全部 disabled
  const toggleAgent = async (agentId: string) => {
    const items = grouped[agentId] || [];
    if (items.length === 0) {
      // 没有 provider — 提示用户先添加
      toast(`「${AGENTS.find((a) => a.id === agentId)?.label}」下还没有模型，请先添加`, 'error');
      return;
    }
    const newEnabled = !agentEnabled(agentId);
    await Promise.all(items.map((p) => api.put(`/api/admin/ai-providers/${p.id}`, { enabled: newEnabled })));
    toast(newEnabled ? `已启用 ${items.length} 个模型` : `已停用 ${items.length} 个模型`);
    load();
  };

  // 单个 provider 开关
  const toggleProvider = async (p: Provider) => {
    await api.put(`/api/admin/ai-providers/${p.id}`, { enabled: !p.enabled });
    load();
  };

  // 改推理档（即 capability）
  const setReasoning = async (p: Provider, capability: string) => {
    await api.put(`/api/admin/ai-providers/${p.id}`, { capability });
    toast('推理档已更新');
    load();
  };

  const del = async (p: Provider) => {
    await api.del(`/api/admin/ai-providers/${p.id}`);
    setDelP(null); load(); toast('已删除');
  };

  // 从 CLI 检测：扫描本地已安装的 claude/codex/kimi/traecli，自动新增 provider。
  // traecli 会 `traecli models` 枚举本机可用模型，每个模型建一个 trae-cli provider。
  const scanCli = async () => {
    setScanning(true);
    try {
      const r = await api.get('/api/admin/ai-providers/scan-cli');
      const agents: any[] = r.agents || [];
      const installed = agents.filter((a) => a.installed);
      if (installed.length === 0) {
        toast('本地未检测到 claude / codex / kimi / traecli CLI', 'error');
        return;
      }
      let created = 0;
      let removed = 0;
      for (const a of installed) {
        const agentDef = AGENTS.find((x) => x.id === a.id);
        if (!agentDef) continue;
        const existing = grouped[a.id] || [];
        // traecli：按枚举出的模型逐个建 provider（模型名可能含空格，用 type+model 去重）
        const models: string[] = Array.isArray(a.models) ? a.models : [];
        if (models.length > 0) {
          // 历史遗留的空 model 占位 provider（旧版本重复点击产生）先复用，避免出现无名空行
          const placeholders = existing.filter((p) => p.type === 'trae-cli' && !String(p.model || '').trim());
          const known = new Set(existing.filter((p) => p.type === 'trae-cli' && String(p.model || '').trim()).map((p) => p.model));
          const pending = models.filter((m) => !known.has(m));
          let reused = 0;
          for (const model of pending) {
            if (reused < placeholders.length) {
              await api.put(`/api/admin/ai-providers/${placeholders[reused++].id}`, { name: `${a.label} · ${model}`, model });
            } else {
              await api.post('/api/admin/ai-providers', {
                name: `${a.label} · ${model}`,
                type: 'trae-cli',
                base_url: '',
                model,
                enabled: 0,
              });
            }
            created += 1;
          }
          // 模型数少于占位数时，多余的占位直接删掉，不留空行
          for (const ph of placeholders.slice(reused)) { await api.del(`/api/admin/ai-providers/${ph.id}`); removed += 1; }
          continue;
        }
        // 其他 CLI：只建一个默认 provider
        const exists = existing.some((p) => p.name === `${a.label} (本地 CLI)` || (!!agentDef.baseUrl && p.base_url === agentDef.baseUrl));
        if (exists) continue;
        await api.post('/api/admin/ai-providers', {
          name: `${a.label} (本地 CLI)`,
          type: agentDef.type,
          base_url: agentDef.baseUrl,
          model: agentDef.defaultModel,
          enabled: 0,
        });
        created += 1;
      }
      toast(created > 0
        ? `已接入 ${created} 个模型${removed ? `，清理 ${removed} 个空配置` : ''}`
        : '本地 CLI 已全部配置');
      load();
    } catch (e: any) {
      toast(e.message || 'CLI 检测失败', 'error');
    } finally { setScanning(false); }
  };

  // 一键健康检测：遍历所有 provider，检测 API Key 配置 + 真实连通性
  const [checking, setChecking] = useState(false);
  const [health, setHealth] = useState<any>(null);
  const runHealthCheck = async () => {
    setChecking(true); setHealth(null);
    try {
      const r = await api.post('/api/admin/ai-providers/health-check');
      setHealth(r);
    } catch (e: any) {
      toast(e.message || '检测失败', 'error');
    } finally { setChecking(false); }
  };

  // 「+ 配置」按钮：直接为该 agent 打开新增 modal
  const addForAgent = (agentId: string) => {
    setAddingAgentId(agentId);
    setAdding(true);
  };

  // 「+ 添加模型」按钮（模型组内）
  const addModelForSelected = () => {
    setAddingAgentId(selectedAgent);
    setAdding(true);
  };

  const currentAgentModels = grouped[selectedAgent] || [];

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="crumb">管理后台</div>
          <h1>AI 配置</h1>
        </div>
      </div>

      {/* 说明区 */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
          <div>
            <b>AI 配置</b>
            <div className="muted" style={{ marginTop: 4 }}>
              配置不同 Agent（Claude/Codex/Trae/Kimi）的接入点和模型；
              启用的 Agent 出现在新建任务、工作流等选择器里。API Key 加密存储，密文仅在点「小眼睛」时临时展示。
            </div>
          </div>
          <button className="btn btn-primary" disabled={checking} onClick={runHealthCheck} style={{ flex: '0 0 auto' }}>
            <Icon name="settings" size={16} /> {checking ? '检测中…' : '一键检测'}
          </button>
        </div>

        {/* 检测结果面板 */}
        {health && (
          <div className="card card-pad" style={{ marginTop: 12, borderColor: health.summary?.fail > 0 ? 'var(--warn)' : 'var(--success)', background: 'var(--panel-2)' }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <b>检测结果</b>
              <span className={`tag ${health.summary?.fail > 0 ? 'tag-warn' : 'tag-green'}`}>
                通过 {health.summary?.ok || 0} / 共 {health.summary?.total || 0}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(health.providers || []).map((p: any) => (
                <div key={p.id} className="row" style={{ gap: 8, padding: '6px 10px', background: 'var(--panel)', borderRadius: 6, alignItems: 'flex-start' }}>
                  <span className={`tag ${p.status === 'OK' ? 'tag-green' : p.status === 'NO_KEY' ? 'tag-grey' : 'tag-danger'}`} style={{ flex: '0 0 auto', fontSize: 10 }}>
                    {p.status === 'OK' ? '通过' : p.status === 'NO_KEY' ? '未配Key' : '失败'}
                  </span>
                  <div style={{ flex: 1, fontSize: 12.5 }}>
                    <b>{p.name}</b>
                    <span className="muted" style={{ marginLeft: 6 }}>{p.model || ''}</span>
                    {!p.enabled && <span className="tag tag-grey" style={{ marginLeft: 6, fontSize: 10 }}>未启用</span>}
                    {p.status === 'OK' && p.latency_ms != null && (
                      <div className="muted" style={{ fontSize: 11 }}>连通正常 · {p.latency_ms}ms{p.reply ? ` · ${p.reply}` : ''}</div>
                    )}
                    {p.status !== 'OK' && (
                      <div style={{ color: p.status === 'NO_KEY' ? 'var(--text-2)' : 'var(--danger)', fontSize: 11 }}>
                        {p.error}
                        {p.suggestion && <span className="muted">（{p.suggestion}）</span>}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Agent 区 */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <b>Agent</b>
            <div className="muted" style={{ fontSize: 12 }}>启用后出现在新建任务派发选择器里（已有任务照常跑）</div>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {AGENTS.map((a) => {
            const enabled = agentEnabled(a.id);
            const count = grouped[a.id]?.length || 0;
            // 检测该 agent 下是否有任一 provider 已配 Key
            const hasKey = a.id === 'trae' || grouped[a.id]?.some((p) => p.api_key_set) || false;  // trae-cli 走本机进程，不需要 Key
            return (
              <div
                key={a.id}
                className="card card-pad"
                style={{
                  borderColor: selectedAgent === a.id ? 'var(--primary)' : (enabled && !hasKey ? 'var(--warn)' : 'var(--border)'),
                  background: selectedAgent === a.id ? 'color-mix(in srgb, var(--primary) 6%, var(--panel))' : 'var(--panel)',
                  cursor: 'pointer',
                }}
                onClick={() => setSelectedAgent(a.id)}
              >
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: 6,
                      background: a.color, color: '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 14,
                    }}>{a.emoji}</div>
                    <b>{a.label}</b>
                  </div>
                  <label
                    className="switch"
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <input type="checkbox" checked={enabled} onChange={() => toggleAgent(a.id)} />
                    <span className="slider" />
                  </label>
                </div>
                <div style={{ fontSize: 12, color: enabled && !hasKey ? 'var(--warn)' : 'var(--text-2)' }}>
                  {count > 0
                    ? (enabled && !hasKey
                        ? `⚠️ 已启用但未配 API Key（点击配 Key 后 AI 才能真跑）`
                        : `${count} 个模型${a.id === 'trae' ? ' · 本机 CLI' : hasKey ? ' · 已配 Key' : ''}`)
                    : '暂无模型'}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 模型组（选中 agent 的模型列表） */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <b>{AGENTS.find((a) => a.id === selectedAgent)?.label} 模型组</b>
            <div className="muted" style={{ fontSize: 12 }}>
              勾选的模型才会出现在各处的「模型」下拉里（新建任务、工作流步骤…）；
              每个模型可设默认推理档（Reasoning）：用 Agent 时选中该模型即按此档运行，无需另选
            </div>
          </div>
          <button className="btn btn-sm" disabled={scanning} onClick={scanCli}>
            <Icon name="settings" size={16} /> {scanning ? '检测中…' : '从 CLI 检测'}
          </button>
        </div>

        {/* 模型列表 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {currentAgentModels.map((p) => (
            <div key={p.id} className="row" style={{ gap: 10, padding: '8px 12px', background: 'var(--panel-2)', borderRadius: 8 }}>
              <label className="switch">
                <input type="checkbox" checked={p.enabled} onChange={() => toggleProvider(p)} />
                <span className="slider" />
              </label>
              <div style={{ width: 220 }}>
                <input
                  className="input"
                  value={p.model || ''}
                  onChange={(e) => {
                    const newModel = e.target.value;
                    setList((prev) => prev.map((x) => x.id === p.id ? { ...x, model: newModel } : x));
                  }}
                  onBlur={(e) => {
                    if (e.target.value !== p.model) {
                      api.put(`/api/admin/ai-providers/${p.id}`, { model: e.target.value });
                      toast('模型 ID 已更新');
                    }
                  }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <input
                  className="input"
                  value={p.name || ''}
                  onChange={(e) => {
                    const newName = e.target.value;
                    setList((prev) => prev.map((x) => x.id === p.id ? { ...x, name: newName } : x));
                  }}
                  onBlur={(e) => {
                    if (e.target.value !== p.name) {
                      api.put(`/api/admin/ai-providers/${p.id}`, { name: e.target.value });
                      toast('显示名已更新');
                    }
                  }}
                />
              </div>
              <div style={{ width: 180 }}>
                <select
                  className="input"
                  value={(p as any).capability || 'json_schema'}
                  onChange={(e) => setReasoning(p, e.target.value)}
                >
                  {REASONING_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <button className="btn btn-sm btn-icon" onClick={() => setDelP(p)} aria-label="删除">
                <Icon name="x" size={16} />
              </button>
            </div>
          ))}
          {currentAgentModels.length === 0 && (
            <div className="muted" style={{ padding: '24px 12px', textAlign: 'center' }}>
              {AGENTS.find((a) => a.id === selectedAgent)?.label} 下还没有模型，可点右上角「从 CLI 检测」自动接入
            </div>
          )}
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn btn-primary btn-sm" onClick={() => toast('模型组已即时保存（每次改动自动入库）')}>
            保存模型组
          </button>
        </div>
      </div>

      {(adding || editing) && (
        <ProviderModal
          provider={editing}
          defaultAgentId={addingAgentId || selectedAgent}
          onClose={closeModal}
          onSaved={reload}
        />
      )}

      {delP && (
        <ConfirmModal
          title="删除 AI 模型"
          message={`确认删除模型「${delP.name} (${delP.model})」？该操作不可恢复。`}
          confirmText="删除"
          danger
          onCancel={() => setDelP(null)}
          onConfirm={() => del(delP)}
        />
      )}
    </div>
  );
}
