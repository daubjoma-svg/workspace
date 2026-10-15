import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { Icon } from './Icon';
import { SearchSelect } from './SearchSelect';

type JiraSync = {
  project_name: string;
  project_candidates: { key: string; name: string }[];
  unmapped_fields: string[];
  synced_at: string;
  synced_by: { id: number; name: string } | null;
  stale: boolean;
  create_fields: { id: string; name: string; required: boolean; type: string; items: string; custom: string; allowed_values?: { id: string; value: string }[] }[];
};

type JiraProfile = {
  base_url: string; username: string; token_configured: boolean;
  project_key: string; issue_type: string; field_mapping: Record<string, string>;
  field_defaults: Record<string, string | string[]>;
  sync: JiraSync | null; sync_error?: string;
};

const DEFAULT_JIRA_BASE_URL = 'https://jira.fenbeijinfu.com';

const FIELD_LABELS: Record<string, string> = {
  customer_name: '客户名称', product_manager: '产品经理', rd: '研发负责人',
  fe: '前端负责人', participants: '参与人员', reporter: '报告人', qa: 'QA',
  online_time: '上线时间', priority: '优先级', modules: '业务模块',
};

/** 同步时间按本地时间展示，避免产品看到 UTC 时间对不上操作时间 */
function formatSyncTime(value?: string) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function JiraSettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved?: () => void }) {
  const { toast } = useApp();
  const [profile, setProfile] = useState<JiraProfile>({ base_url: DEFAULT_JIRA_BASE_URL, username: '', token_configured: false, project_key: '', issue_type: '产品需求', field_mapping: {}, field_defaults: {}, sync: null });
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Jira 凭据只能由当前产品账号维护，管理员人员页只展示配置状态。
  const endpoint = '/api/users/me/jira-profile';
  useEffect(() => { api.get(endpoint).then((v: any) => setProfile(v?.data || v)).catch((e: any) => toast(e.message, 'error')).finally(() => setLoading(false)); }, [endpoint]);
  const set = (key: keyof JiraProfile, value: string) => setProfile((p) => ({ ...p, [key]: value }));

  // 保存凭据后由服务端自动拉取并同步项目/类型/字段映射，同步结果全员共用
  const save = async () => {
    setSaving(true);
    try {
      const raw: any = await api.put(endpoint, {
        base_url: profile.base_url,
        username: profile.username,
        api_token: token || (profile.token_configured ? '__KEEP__' : ''),
        project_key: profile.project_key,
        issue_type: profile.issue_type,
        field_defaults: profile.field_defaults,
      });
      const saved: JiraProfile = raw?.data || raw;
      setProfile(saved);
      setToken('');
      if (saved.sync_error) toast(`配置已保存，但自动同步失败：${saved.sync_error}`, 'error');
      else toast('配置已保存，Jira 信息已同步');
      onSaved?.();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setSaving(false); }
  };

  const sync = profile.sync;
  const mappedCount = Object.values(profile.field_mapping || {}).filter(Boolean).length;
  const totalFields = Object.keys(FIELD_LABELS).length;
  const unmappedLabels = (sync?.unmapped_fields || []).map((k) => FIELD_LABELS[k] || k);
  const setDefault = (fieldId: string, value: string) => setProfile((p) => {
    const next = { ...(p.field_defaults || {}) };
    if (value.trim()) next[fieldId] = value;
    else delete next[fieldId];
    return { ...p, field_defaults: next };
  });

  return <div className="modal-mask" onClick={onClose}>
    <div className="modal card" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
      <div className="modal-h"><span><Icon name="settings" size={17} /> Jira 设置</span><button className="btn btn-sm btn-icon" onClick={onClose} aria-label="关闭"><Icon name="close" size={16} /></button></div>
      <div className="modal-b">
        {loading ? <div className="empty">加载中…</div> : <>
          <div className="section-title">账号配置</div>
          <div className="muted" style={{ fontSize: 12, margin: '6px 0 10px' }}>
            填写账号后保存会自动同步项目、需求类型与字段映射；默认项目可按产品单独设置。
          </div>
          <div className="form-row"><label>Jira 地址</label><input className="input" value={DEFAULT_JIRA_BASE_URL} readOnly /></div>
          <div className="form-row"><label>账号名 *</label><input className="input" value={profile.username} onChange={(e) => set('username', e.target.value)} placeholder="登录账号或邮箱" /></div>
          <div className="form-row"><label>密码 *</label><input className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={profile.token_configured ? '已配置，留空保持不变' : 'Jira 密码（Jira Cloud 填 API Token）'} /></div>
          <div className="form-row"><label>默认项目</label>
            <SearchSelect
              options={(profile.sync?.project_candidates || []).map((p) => ({ value: p.key, label: p.name ? `${p.name}（${p.key}）` : p.key }))}
              value={profile.project_key}
              onChange={(v) => set('project_key', String(v))}
              placeholder="选择默认项目"
              emptyText="请先保存账号并完成同步"
            />
            <div className="hint">例如选择「平台系统需求池（PINGTAI）」；创建 Jira 时会优先使用该项目。</div>
          </div>

          <div className="section-title" style={{ marginTop: 18 }}>创建默认值（可选）</div>
          <div className="muted" style={{ fontSize: 12, margin: '6px 0 10px' }}>
            只填写需要固定的字段；需求已有值时优先使用需求值。问题选择器请填 Jira 单号（如 KHNAME-851），选项或人员字段填写 Jira 接受的值。
          </div>
          {sync?.create_fields?.length ? sync.create_fields.map((field) => {
            const value = profile.field_defaults?.[field.id];
            const options = field.allowed_values || [];
            return <div className="form-row" key={field.id}>
              <label>{field.name}{field.required ? '（必填兜底）' : ''}</label>
              {options.length ? <SearchSelect
                options={options.map((o) => ({ value: o.value, label: o.value }))}
                value={Array.isArray(value) ? value[0] || '' : value || ''}
                onChange={(v) => setDefault(field.id, String(v))}
                placeholder="选择默认值"
                emptyText="无匹配选项"
              /> : <input className="input" value={Array.isArray(value) ? value.join(', ') : value || ''}
                onChange={(e) => setDefault(field.id, e.target.value)}
                placeholder={`Jira 字段 ${field.id}，留空表示不设默认值`} />}
            </div>;
          }) : <div className="muted" style={{ fontSize: 12 }}>保存 Jira 账号并同步成功后，这里会显示可配置的创建字段。</div>}

          <div className="section-title" style={{ marginTop: 18 }}>已同步信息</div>
          {sync ? (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <span>项目</span><span style={{ color: 'var(--text)' }}>{profile.project_key}{sync.project_name ? ` · ${sync.project_name}` : ''}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <span>需求类型</span><span style={{ color: 'var(--text)' }}>{profile.issue_type}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <span>字段映射</span><span style={{ color: 'var(--text)' }}>{mappedCount}/{totalFields}{unmappedLabels.length ? `（未匹配：${unmappedLabels.join('、')}）` : ''}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
                <span>同步来源</span><span style={{ color: 'var(--text)' }}>{sync.synced_by?.name || '—'} · {formatSyncTime(sync.synced_at)}</span>
              </div>
              {sync.stale && <div style={{ marginTop: 6, color: 'var(--warn-ink)' }}>当前地址与该信息同步时的地址不一致，保存后会重新同步。</div>}
              {sync.project_candidates.length > 1 && <div style={{ marginTop: 6, color: 'var(--warn-ink)' }}>
                站点下有 {sync.project_candidates.length} 个可创建项目，可在上方选择本产品的默认项目。
              </div>}
              {unmappedLabels.length > 0 && <div style={{ marginTop: 6 }}>未匹配的字段会以「需求协作信息」写入描述，不影响创建。</div>}
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>尚未同步。填好地址、账号、密码并保存后自动完成。</div>
          )}
          {profile.sync_error && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--danger-ink)' }}>上次自动同步失败：{profile.sync_error}</div>}
        </>}
      </div>
      <div className="modal-f">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-primary" onClick={save} disabled={loading || saving}>
          {saving ? <Icon name="loader" size={16} className="spin" /> : null} {saving ? '保存并同步中…' : '保存并同步'}
        </button>
      </div>
    </div>
  </div>;
}
