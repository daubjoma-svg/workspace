import React, { useState } from 'react';
import { api } from '../../api';
import { useApp } from '../../App';
import { Icon } from '../../components/Icon';
import { SecretInput } from '../../components/SecretInput';
import { SearchSelect } from '../../components/SearchSelect';

/** Provider 公开字段（后端 toPublic 恒掩码，api_key_set 表示是否已配置密钥） */
export interface Provider {
  id: number;
  name: string;
  type: string;
  base_url?: string;
  model?: string;
  enabled: boolean;
  api_key_set: boolean;
  last_tested_at?: string | null;
  last_test_error?: string | null;
}

const TYPE_OPTS: [string, string][] = [
  ['openai-compat', 'OpenAI 兼容（OpenAI/Kimi/DeepSeek…）'],
  ['anthropic', 'Anthropic Claude'],
  ['trae-cli', 'Trae CLI（本机 traecli 进程，填 trae-lt-xxx 令牌）'],
  ['mock', 'Mock'],
];

interface ProviderModalProps {
  /** null = 新增；非 null = 编辑 */
  provider: Provider | null;
  /** 默认 agent id（用于「+ 添加模型」时预填 type/base_url/model） */
  defaultAgentId?: string;
  onClose: () => void;
  onSaved: () => void;
}

// agent id → 默认 type/base_url/model 映射（与 AiProviders.tsx 的 AGENTS 保持一致）
const AGENT_DEFAULTS: Record<string, { type: string; base_url: string; model: string; label: string }> = {
  claude: { type: 'anthropic',     base_url: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514', label: 'Claude' },
  codex:  { type: 'openai-compat', base_url: 'https://api.openai.com',     model: 'gpt-5.6',                label: 'Codex' },
  // Trae：走本机 traecli 进程。API Key 栏填 trae-lt-xxx CLI 登录令牌；留空则用本机已登录态
  trae:   { type: 'trae-cli',      base_url: '',                          model: '',                     label: 'Trae' },
  kimi:   { type: 'openai-compat', base_url: 'https://api.moonshot.cn',    model: 'kimi-k2-0905-preview',   label: 'Kimi' },
};

/** 添加 / 编辑共用的 Provider 配置弹窗 */
export default function ProviderModal({ provider, defaultAgentId, onClose, onSaved }: ProviderModalProps) {
  const { toast } = useApp();
  const isEdit = !!provider;
  const initDefaults = defaultAgentId ? AGENT_DEFAULTS[defaultAgentId] : null;
  const [form, setForm] = useState({
    name: provider?.name || (initDefaults ? `${initDefaults.label} 模型` : ''),
    type: provider?.type || initDefaults?.type || 'openai-compat',
    base_url: provider?.base_url || initDefaults?.base_url || '',
    api_key: '',
    model: provider?.model || initDefaults?.model || '',
  });
  const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false);

  /** 明文只读接口：仅在用户点眼睛时调用（红线：不持久化明文） */
  const revealKey = async (): Promise<string> => {
    if (!provider) return '';
    try {
      const r = await api.get(`/api/admin/ai-providers/${provider.id}/key`);
      return r.key || '';
    } catch (e: any) {
      toast(e.message || '查看 Key 失败', 'error');
      return '';
    }
  };

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    // trae-cli 自动用默认名（隐藏了名称输入框），无需校验
    const finalName = form.type === 'trae-cli' ? (form.name.trim() || 'Trae 模型') : form.name.trim();
    if (!finalName) return toast('请填写名称');
    setSaving(true);
    try {
      if (isEdit) {
        const body: Record<string, unknown> = {
          name: finalName,
          type: form.type,
          // trae-cli / mock 不需要 base_url（trae-cli 走本机进程；mock 走内置 fallback）
          base_url: (form.type === 'trae-cli' || form.type === 'mock') ? null : form.base_url,
          model: form.model,
        };
        // api_key 留空 = 保留原 key；已点「清除」= 置空串清除；输入新值 = 重加密
        if (form.api_key.trim()) body.api_key = form.api_key.trim();
        else if (clearKey) body.api_key = '';
        await api.put(`/api/admin/ai-providers/${provider!.id}`, body);
        toast('Provider 已更新');
      } else {
        await api.post('/api/admin/ai-providers', {
          name: finalName,
          type: form.type,
          base_url: (form.type === 'trae-cli' || form.type === 'mock') ? null : form.base_url,
          api_key: form.api_key.trim(),
          model: form.model,
          enabled: true,
        });
        toast('已添加并启用');
      }
      onSaved();
    } catch (e: any) {
      toast(e.message || '保存失败', 'error');
    } finally { setSaving(false); }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          {isEdit ? '编辑 AI Provider' : '添加 AI Provider'}
          <button className="btn btn-sm btn-icon" onClick={onClose} aria-label="关闭弹窗">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal-b">
          <div className="grid2">
            {form.type === 'trae-cli' ? (
              <>
                {/* Trae CLI：走本机 traecli 进程，只需 Model + API Key（令牌）；其余自动 */}
                <div className="form-row" style={{ gridColumn: '1 / -1' }}>
                  <label>说明</label>
                  <div className="hint" style={{ padding: '6px 0' }}>
                    Trae CLI 走本机 traecli 进程（已自动配置），只需选模型 + 填 trae-lt-xxx 令牌。
                    <br />可用模型：GLM-5.3 / DeepSeek-V4-Flash / Kimi-K2.7-Code / Doubao-Seed-2.1-Pro …
                  </div>
                </div>
                <div className="form-row" style={{ gridColumn: '1 / -1' }}><label>Model</label>
                  <input className="input" value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="GLM-5.3" /></div>
                <div className="form-row" style={{ gridColumn: '1 / -1' }}>
                  <label>CLI 登录令牌（可选）</label>
                  <SecretInput
                    key={clearKey ? 'cleared' : 'normal'}
                    value={form.api_key}
                    onChange={(v) => { set('api_key', v); if (v) setClearKey(false); }}
                    hasStored={isEdit && provider!.api_key_set}
                    onReveal={revealKey}
                    onClear={isEdit ? () => { setClearKey(true); set('api_key', ''); } : undefined}
                    placeholder="trae-lt-xxxx…（留空则用本机已登录态）"
                  />
                  <div className="hint">填 trae-lt-xxx CLI 登录令牌更稳；留空则用本机已登录的 Trae 会话</div>
                </div>
              </>
            ) : (
              <>
                <div className="form-row"><label>名称 *</label>
                  <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="如 Claude / Kimi" /></div>
                <div className="form-row"><label>类型</label>
                  <SearchSelect
                    options={TYPE_OPTS.map(([v, l]) => ({ value: v, label: l }))}
                    value={form.type}
                    onChange={(v) => set('type', String(v))}
                    placeholder="请选择类型"
                  /></div>
                <div className="form-row" style={{ gridColumn: '1 / -1' }}><label>Base URL</label>
                  <input className="input" value={form.base_url} onChange={(e) => set('base_url', e.target.value)}
                    placeholder="https://api.moonshot.cn"
                    disabled={form.type === 'mock'}
                    title={form.type === 'mock' ? 'Mock 不需要 Base URL' : ''} /></div>
                <div className="form-row"><label>Model</label>
                  <input className="input" value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="moonshot-v1-8k" /></div>
                <div className="form-row">
                  <label>API Key</label>
                  <SecretInput
                    key={clearKey ? 'cleared' : 'normal'}
                    value={form.api_key}
                    onChange={(v) => { set('api_key', v); if (v) setClearKey(false); }}
                    hasStored={isEdit && provider!.api_key_set}
                    onReveal={revealKey}
                    onClear={isEdit ? () => { setClearKey(true); set('api_key', ''); } : undefined}
                    placeholder={isEdit ? (clearKey ? '保存后将清除已存 Key' : '留空则保留已存 Key') : '输入模型 API Key'}
                  />
                  <div className="hint">{isEdit ? 'API Key 留空保存 = 保留原 Key；点眼睛查看已存明文' : '新增后默认启用并接管请求'}</div>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="modal-f">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={saving} onClick={submit}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  );
}
