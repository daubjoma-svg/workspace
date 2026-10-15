import React, { useEffect, useState } from 'react';
import { api, Requirement } from '../api';
import { useApp } from '../App';
import { Icon } from './Icon';
import { SearchSelect, SearchSelectOption } from './SearchSelect';

/** 最近选择过的项目（按浏览器本地存储，跨需求共用），最多保留 5 个。 */
const RECENT_KEY = 'sop_jira_recent_projects';
const RECENT_MAX = 5;
const DEFAULT_CUSTOMER_NAME = '分贝通科技有限公司';

type ProjectOption = { key: string; name: string };

/** 创建屏幕字段元数据；控件形态由 custom 后缀 / type / items 决定。 */
type JiraField = {
  id: string;
  name: string;
  type: string;
  items: string;
  custom: string;
  allowed_values: { id: string; value: string }[];
  default_value?: string | string[];
};

type JiraCreateForm = {
  project_key: string;
  project_name: string;
  issue_type: string;
  issue_types: string[];
  required_fields: JiraField[];
  default_fields: JiraField[];
};

/** 字段控件分类：单选选项 / 多选选项 / 问题选择器（异步检索单号）/ 普通文本输入。 */
function fieldKind(f: JiraField): 'single' | 'multi' | 'issue' | 'text' {
  const suffix = f.custom ? f.custom.slice(f.custom.lastIndexOf(':') + 1) : '';
  if (suffix.includes('issue-picker')) return 'issue';
  // Jira 元数据把这两个字段定义成 multicheckboxes，但产品创建 Jira 时只需要选一个值，
  // 页面使用单选下拉；提交时后端仍会按 Jira 要求转换成数组。
  if (f.name === '簇群分类（多选）' || f.name === '涉及的研发端') return 'single';
  if (suffix === 'multicheckboxes' || suffix === 'multiselect' || (f.type === 'array' && f.items === 'option')) return 'multi';
  if (suffix === 'select' || suffix === 'radiobuttons' || suffix === 'checkbox' || suffix === 'cascadingselect' || f.type === 'option') return 'single';
  return 'text';
}

export function JiraCreateModal({ req, onClose, onCreated }: { req: Requirement; onClose: () => void; onCreated: (url: string) => void }) {
  const { toast } = useApp();
  const [summary, setSummary] = useState(req.title);
  /** 当前产品账号的 Jira 配置摘要，用于创建前确认项目与默认类型。 */
  const [jiraProfile, setJiraProfile] = useState<{ base_url: string; username: string; project_key: string; issue_type: string; token_configured: boolean; sync?: { project_candidates?: ProjectOption[] } | null } | null>(null);
  const [projectKey, setProjectKey] = useState('');
  const [jiraProfileLoading, setJiraProfileLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [recentProjects, setRecentProjects] = useState<ProjectOption[]>([]);
  /** 创建表单元数据：可创建的问题类型、待补必填字段和常用产品默认字段。 */
  const [form, setForm] = useState<JiraCreateForm | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState('');
  /** 用户显式选择的问题类型；空字符串 = 交给后端按偏好自动选（避免与回填值来回触发重查）。 */
  const [issueType, setIssueType] = useState('');
  /** fieldId → 补填值（单选/文本为字符串，多选为字符串数组） */
  const [fieldValues, setFieldValues] = useState<Record<string, string | string[]>>({});
  /** 问题选择器字段的候选单号（fieldId → 选项） */
  const [issueOptions, setIssueOptions] = useState<Record<string, SearchSelectOption[]>>({});

  useEffect(() => {
    api.get('/api/users/me/jira-profile')
      .then((raw: any) => {
        const profile = raw?.data || raw;
        setJiraProfile(profile);
        // 默认选中当前配置项目，没有配置时退回候选列表首项，确保下拉值始终有对应选项。
        setProjectKey(profile?.project_key || profile?.sync?.project_candidates?.[0]?.key || '');
        try { setRecentProjects(JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')); } catch { setRecentProjects([]); }
      })
      .catch(() => setJiraProfile(null))
      .finally(() => setJiraProfileLoading(false));
  }, []);

  // 候选项目：优先同步返回的全量项目；只有单个项目时退化为当前默认项目，保证下拉始终有值。
  const allProjects: ProjectOption[] = jiraProfile?.sync?.project_candidates?.length
    ? jiraProfile.sync.project_candidates
    : (jiraProfile?.project_key ? [{ key: jiraProfile.project_key, name: '' }] : []);

  // 选中即记录到“最近查看的项目”，不必等到创建成功，符合用户对“最近使用”的预期。
  const rememberProject = (key: string) => {
    const hit = allProjects.find((p) => p.key === key);
    if (!hit) return;
    const next = [hit, ...recentProjects.filter((p) => p.key !== key)].slice(0, RECENT_MAX);
    setRecentProjects(next);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* 隐私模式下写入失败不影响创建 */ }
  };

  /** 问题选择器字段的候选检索：只读，失败不阻断创建（产品仍可手输单号）。 */
  const searchIssueOptions = async (fieldId: string, q: string, merge = false): Promise<SearchSelectOption[]> => {
    try {
      const raw: any = await api.get(`/api/jira/issue-search?field_id=${encodeURIComponent(fieldId)}&q=${encodeURIComponent(q)}`);
      const list = raw?.data || raw || [];
      const options = list.map((it: any) => ({ value: it.key, label: it.summary || it.key, subLabel: it.key }));
      setIssueOptions((prev) => {
        const merged = merge ? [...(prev[fieldId] || []), ...options] : options;
        const seen = new Set<string>();
        return {
          ...prev,
          [fieldId]: merged.filter((item: SearchSelectOption) => {
            const key = String(item.value);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }),
        };
      });
      return options;
    } catch { /* 检索失败保持原候选 */ return []; }
  };

  // 项目/类型变化后必填字段会变（不同创建屏幕的字段配置不同），必须重新拉取，不能复用上一次结果。
  useEffect(() => {
    if (!projectKey) { setForm(null); return; }
    let cancelled = false;
    setFormLoading(true);
    setFormError('');
    const qs = new URLSearchParams({ project_key: projectKey });
    if (issueType) qs.set('issue_type', issueType);
    api.get(`/api/requirements/${req.id}/jira-create-form?${qs.toString()}`)
      .then((raw: any) => {
        if (cancelled) return;
        const data: JiraCreateForm = raw?.data || raw;
        setForm(data);
        // 元数据变化时仅使用当前项目/类型的合法默认值；选择器保存的值可能来自另一项目。
        setFieldValues(() => {
          const next: Record<string, string | string[]> = {};
          for (const f of data.default_fields || []) {
            const configured = f.default_value;
            if (Array.isArray(configured) && configured.length) next[f.id] = fieldKind(f) === 'single' ? configured[0] : configured;
            else if (typeof configured === 'string' && configured) next[f.id] = configured;
          }
          for (const f of data.required_fields) {
            if (next[f.id] === undefined && f.name === '簇群分类（多选）') {
              const option = f.allowed_values.find((o) => o.value === '其他' || o.value === '其它');
              if (option) next[f.id] = option.value;
            }
          }
          return next;
        });
      })
      .catch((e: any) => { if (!cancelled) { setForm(null); setFormError(e.message); } })
      .finally(() => { if (!cancelled) setFormLoading(false); });
    return () => { cancelled = true; };
  }, [projectKey, issueType, req.id]);

  // 客户名称问题选择器限定在 KHNAME 项目；需求没有客户或搜索不到时，默认关联分贝通科技有限公司。
  useEffect(() => {
    if (!form) return;
    for (const f of form.required_fields) {
      if (fieldKind(f) === 'issue') {
        void (async () => {
          const requestedName = String(req.customer_name || '').trim();
          const options = await searchIssueOptions(f.id, requestedName, true);
          const normalized = (v: string) => v.replace(/\\s+/g, '').toLowerCase();
          const exact = requestedName
            ? options.find((o) => normalized(String(o.label)) === normalized(requestedName))
            : undefined;
          // 没有需求客户或需求客户在 KHNAME 中不存在时，查找并默认选择指定兜底客户。
          const fallbackOptions = exact ? [] : await searchIssueOptions(f.id, DEFAULT_CUSTOMER_NAME, true);
          const fallback = fallbackOptions.find((o) => normalized(String(o.label)) === normalized(DEFAULT_CUSTOMER_NAME))
            || fallbackOptions[0];
          // 需求客户必须精确命中；模糊结果不直接绑定，避免把相似客户关联错，未命中统一使用兜底客户。
          const selected = exact || fallback;
          if (selected) {
            setFieldValues((prev) => prev[f.id] ? prev : ({ ...prev, [f.id]: String(selected.value) }));
          }
        })();
      }
    }
    // 仅在表单元数据变化时预搜；searchIssueOptions 为组件内稳定函数，无需进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  const setValue = (fieldId: string, value: string | string[]) =>
    setFieldValues((prev) => ({ ...prev, [fieldId]: value }));

  const missingRequired = (form?.required_fields || []).filter((f) => {
    const v = fieldValues[f.id];
    return Array.isArray(v) ? v.length === 0 : !String(v ?? '').trim();
  });
  const requiredIds = new Set((form?.required_fields || []).map((f) => f.id));
  const commonFields = form?.default_fields || [];
  const otherRequiredFields = (form?.required_fields || []).filter((f) => !commonFields.some((item) => item.id === f.id));

  // Jira 的参与人员来源于当前需求已指派的研发、前端和测试负责人，并去重展示。
  const participantNames = [...new Set([req.rd_name, req.fe_name, req.qa_name].filter(Boolean))].join('、');
  const jiraReady = !!jiraProfile && !!jiraProfile.base_url && !!jiraProfile.username && !!jiraProfile.token_configured;
  const people = [
    ['产品经理', req.po_name || '未指派'],
    ['研发负责人', req.rd_name || '未指派'], ['前端负责人', req.fe_name || '未指派'],
    ['参与人员', participantNames || '未指派'], ['报告人', req.csm_name || '未填写'], ['QA', req.qa_name || '未指派'],
    ['上线时间', req.target_version || req.expect_date || '未指定'], ['优先级', req.priority || '未指定'],
  ];
  const create = async () => {
    if (!summary.trim() || busy || missingRequired.length) return;
    setBusy(true);
    try {
      const raw: any = await api.post(`/api/requirements/${req.id}/jira`, {
        summary: summary.trim(),
        project_key: projectKey,
        issue_type: issueType || undefined,
        // 显式选择的常用字段与补填的必填字段一起透传，由服务端覆盖产品默认值。
        fields: fieldValues,
      });
      const result = raw?.data || raw;
      rememberProject(projectKey);
      onCreated(result.url);
    }
    catch (e: any) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };

  // 「全部项目」里剔除已在“最近查看”出现的项，避免重复；最近查看的排在前面便于直接选。
  const restProjects = allProjects.filter((p) => !recentProjects.some((r) => r.key === p.key));
  const projectOptions: SearchSelectOption[] = recentProjects.concat(restProjects)
    .map((p) => ({ value: p.key, label: p.name || p.key, subLabel: p.name ? p.key : undefined }));

  /** 按字段类型渲染补填控件：选项类走 SearchSelect / 标签多选，问题选择器走可检索下拉。 */
  const renderField = (f: JiraField) => {
    const kind = fieldKind(f);
    const value = fieldValues[f.id];
    if (kind === 'multi') {
      const arr = Array.isArray(value) ? value : [];
      return <div className="chip-group">
        {f.allowed_values.map((o) => (
          <button key={o.id} type="button"
            className={`chip${arr.includes(o.value) ? ' on' : ''}`}
            onClick={() => setValue(f.id, arr.includes(o.value) ? arr.filter((x) => x !== o.value) : [...arr, o.value])}>
            {o.value}
          </button>
        ))}
      </div>;
    }
    if (kind === 'single') {
      return <SearchSelect
        options={f.allowed_values.map((o) => ({ value: o.value, label: o.value }))}
        value={typeof value === 'string' ? value : ''}
        onChange={(v) => setValue(f.id, String(v))}
        placeholder="搜索并选择…"
        emptyText="无匹配选项"
      />;
    }
    if (kind === 'issue') {
      return <>
        <SearchSelect
          options={issueOptions[f.id] || []}
          value={typeof value === 'string' ? value : ''}
          onChange={(v) => setValue(f.id, String(v))}
          onQueryChange={(q) => void searchIssueOptions(f.id, q)}
          placeholder="输入关键字搜索单号…"
          emptyText="无匹配单号，可直接粘贴单号"
        />
        <div className="hint" style={{ marginTop: 4 }}>按名称搜索对应 Jira 单号后选择；也可直接在上面粘贴单号（如 KHNAME-851）。</div>
      </>;
    }
    return <input className="input" value={typeof value === 'string' ? value : ''} onChange={(e) => setValue(f.id, e.target.value)} />;
  };

  return <div className="modal-mask" onClick={onClose}>
    <div className="modal card jira-create-modal" onClick={(e) => e.stopPropagation()}>
      <div className="modal-h"><span><Icon name="link" size={16} /> 创建 Jira</span><button className="btn btn-sm btn-icon" onClick={onClose} aria-label="关闭"><Icon name="close" size={16} /></button></div>
      <div className="modal-b">
        <div className="jira-form-grid jira-top-fields">
        <div className="form-row jira-field-wide"><label>概要 *</label><input className="input" value={summary} onChange={(e) => setSummary(e.target.value)} autoFocus /></div>
        <div className={`form-row${form && form.issue_types.length > 1 ? '' : ' jira-field-wide'}`}>
          <label>项目 *</label>
          <SearchSelect
            options={projectOptions}
            value={projectKey}
            onChange={(v) => { const k = String(v); setFieldValues({}); setForm(null); setProjectKey(k); setIssueType(''); rememberProject(k); }}
            placeholder={jiraProfileLoading ? '加载中…' : '搜索项目名称或 Key…'}
            emptyText="无匹配项目"
            disabled={jiraProfileLoading || !jiraProfile || projectOptions.length === 0}
          />
        </div>
        {form && form.issue_types.length > 1 && <div className="form-row">
          <label>类型 *</label>
          <SearchSelect
            options={form.issue_types.map((t) => ({ value: t, label: t }))}
            value={issueType || form.issue_type}
            onChange={(v) => { setFieldValues({}); setForm(null); setIssueType(String(v)); }}
            placeholder="选择问题类型"
          />
        </div>}
        </div>
        {!jiraProfileLoading && !jiraProfile && <div className="hint" role="alert">未读取到当前产品的 Jira 配置，请先在 Jira 设置中配置。</div>}
        {!jiraProfileLoading && jiraProfile && !jiraReady && <div className="hint" style={{ marginTop: 8, color: 'var(--danger-ink)' }}>Jira 地址、账号、Token 未配置完整，请先补齐后再创建。</div>}

        {!jiraProfileLoading && formLoading && <div className="hint" style={{ marginTop: 14 }}>正在读取该项目的创建字段…</div>}
        {!formLoading && formError && <div className="hint" style={{ marginTop: 14, color: 'var(--danger-ink)' }}>{formError}</div>}
        {!formLoading && form && (commonFields.length > 0 || otherRequiredFields.length > 0) && <section className="jira-section" aria-label="Jira 字段">
          <div className="section-title">Jira 字段</div>
          <div className="jira-form-grid jira-common-fields">
          {commonFields.map((f) => <div key={f.id} className={`form-row jira-field${f.name === '平台子业务线' ? ' jira-field-wide' : ''}`}>
            <label>{f.name}{requiredIds.has(f.id) ? ' *' : ''}</label>
            {renderField(f)}
          </div>)}
          </div>
          {otherRequiredFields.length > 0 && <div className="jira-required-label">其他必填项</div>}
          {otherRequiredFields.length > 0 && <div className="jira-form-grid jira-required-fields">{otherRequiredFields.map((f) => <div key={f.id} className={`form-row jira-field${fieldKind(f) === 'issue' || fieldKind(f) === 'multi' ? ' jira-field-wide' : ''}`}>
            <label>{f.name} *</label>
            {renderField(f)}
          </div>)}</div>}
        </section>}

        <details className="jira-preview-details">
        <summary>自动带入的字段 <Icon name="chevron-down" size={16} /></summary>
        <div className="jira-preview">
          <div className="jira-preview-row jira-preview-wide"><span className="muted">描述</span><span>最新 PRD（无 PRD 时使用原始需求描述）</span></div>
          {people.map(([label, value]) => <div key={label} className="jira-preview-row"><span className="muted">{label}</span><span>{value}</span></div>)}
        </div>
        </details>
      </div>
      <div className="modal-f"><button className="btn" onClick={onClose}>取消</button><button className="btn btn-primary" onClick={create} disabled={busy || jiraProfileLoading || formLoading || !form || !jiraProfile || !jiraReady || !summary.trim() || !projectKey || missingRequired.length > 0}>{busy ? <Icon name="loader" size={16} className="spin" /> : <Icon name="plus" size={16} />} 创建 Jira</button></div>
    </div>
  </div>;
}
