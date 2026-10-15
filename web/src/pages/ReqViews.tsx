import { useState } from 'react';
import { api, Artifact } from '../api';
import { useApp } from '../App';
import { Icon } from '../components/Icon';
import type { ArtifactMeta } from '../lib/artifactMeta';
import { EvalMetaBar } from '../components/EvalMetaBar';
import { SearchSelect } from '../components/SearchSelect';

export function actionName(a: string) {
  return ({
    CREATE: '创建草稿', SUBMIT: '提交需求', ENTER_NODE: '进入节点', AI_START: 'AI 开始执行',
    AI_DONE: 'AI 执行完成', AI_FAIL: 'AI 执行失败', CLARIFY: '发起澄清', CLARIFY_ANSWER: '回复澄清',
    CLARIFY_DONE: '澄清完成', CONFIRM: '确认流转', RETURN: '打回', FORCE_SUBMIT: '强制提交',
    ARTIFACT_SAVE: '保存产物', DONE: '流程完成', CANCEL: '取消需求',
    ASSIGN: '产品指派', CHAT_SEND: '发送消息', CHAT_ANSWER: '回复消息',
    AI_PRD_GEN: 'AI 生成 PRD',
  } as Record<string, string>)[a] || a;
}

export function EvaluationView({ data, meta }: { data: any; meta: ArtifactMeta | null }) {
  const verdict = data.rationality?.verdict;
  const needsAttention = verdict === 'NEEDS_ATTENTION';
  const isMock = meta?.is_mock;
  const attention: string[] = Array.isArray(data.attention_points) ? data.attention_points : [];

  /** L1-L5 改动等级 → 颜色（绿→黄→橙→红 渐变；L5 标红） */
  function levelColor(level?: string): string {
    switch ((level || '').toUpperCase()) {
      case 'L1': return '#10b981'; // 深绿（小改）
      case 'L2': return '#84cc16'; // 浅绿
      case 'L3': return '#f59e0b'; // 黄（中改）
      case 'L4': return '#f97316'; // 橙
      case 'L5': return '#dc2626'; // 红（大改/重大重构）
      default:   return 'var(--primary)';
    }
  }
  /** 等级 → 业务含义（前端展示给 CSM/产品看） */
  function levelDesc(level?: string): string {
    switch ((level || '').toUpperCase()) {
      case 'L1': return '微小改动（字段/文案/配置调整）';
      case 'L2': return '小改动（单文件/单接口）';
      case 'L3': return '中等改动（多文件/单模块）';
      case 'L4': return '较大改动（跨模块/含数据迁移）';
      case 'L5': return '重大重构（架构调整/跨系统）';
      default:   return '';
    }
  }
  // 风险合并到「需要关注」（统一显示），按 level 排序（高→低）
  const risks: any[] = Array.isArray(data.risks) ? data.risks : [];
  const attentionMerged: { text: string; level?: string }[] = [
    ...attention.map((t) => ({ text: String(t) })),
    ...risks.map((r) => typeof r === 'string' ? { text: r } : { text: r.description, level: r.level }),
  ];
  const levelRank = (l?: string) => l === '高' ? 0 : l === '中' ? 1 : l === '低' ? 2 : 3;
  attentionMerged.sort((a, b) => levelRank(a.level) - levelRank(b.level));
  const visibleAttention = attentionMerged.slice(0, 6);
  const scheduling = data.scheduling || {
    status: needsAttention ? 'NEEDS_CONFIRMATION' : 'READY',
    advice: needsAttention ? '建议先确认关注事项，再进入排期。' : '可按当前优先级进入常规排期。',
  };
  const scheduleLabels: Record<string, [string, string]> = {
    FAST_TRACK: ['可快速排期', 'tag-green'],
    READY: ['可排期', 'tag-green'],
    NEEDS_CONFIRMATION: ['补充信息后排期', 'tag-orange'],
    HOLD: ['暂不建议排期', 'tag-danger'],
  };
  const [scheduleLabel, scheduleClass] = scheduleLabels[scheduling.status] || scheduleLabels.NEEDS_CONFIRMATION;
  const summary = data.summary || data.rationality?.reason || '暂无评估总结';
  // 已保存的评估可能漏传或返回非法值，缺失不能据此判断为旧版本，也不能补造分数。
  const confidence: number | null = typeof data.confidence === 'number' && Number.isFinite(data.confidence)
    && data.confidence >= 0 && data.confidence <= 1 ? data.confidence : null;

  // 退化：is_mock=true（兜底产物）都显示「AI 评估未产出」友好提示，不渲染内容
  if (isMock) {
    return (
      <div>
        <div className="card card-pad" style={{ background: 'var(--panel-2)', borderColor: 'var(--warn)' }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <Icon name="warning" size={20} />
            <b>AI 评估未产出</b>
          </div>
          <div className="muted">本次评估为兜底产物（非真实 AI 输出），建议：
            <ol style={{ marginTop: 8, paddingLeft: 20 }}>
              <li>点上方「重新执行该 AI 节点」重跑（AI 偶有 content_filter 拦截可重试）</li>
              <li>或点「跳过继续」让流程继续，需求发起人人工补一份评估</li>
            </ol>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* 模板 A：先给结论，让需求提出人无需阅读长清单即可决定是否进入排期。
          三个指标统一「标签 / 数值 / 说明」三段式，缺说明时补占位符以保证基线对齐。 */}
      <div className="card card-pad" style={{ background: needsAttention ? 'var(--warn-wash)' : 'var(--success-wash)', borderColor: needsAttention ? 'var(--warn)' : 'var(--success)' }}>
        <div className="section-title" style={{ marginBottom: 6 }}>结论摘要</div>
        <p className="md" style={{ margin: 0, fontSize: 15, lineHeight: 1.7, fontWeight: 600 }}>{summary}</p>
        <div className="eval-summary">
          <div className="eval-stat">
            <div className="k">改动等级</div>
            <div className="v" style={{ color: levelColor(data.level) }}>{data.level || '—'}</div>
            <div className="sub" style={{ color: levelColor(data.level) }}>{levelDesc(data.level) || '\u00a0'}</div>
          </div>
          <div className="eval-stat">
            <div className="k">预估工时</div>
            <div className="v">
              {data.effort ? `${data.effort.min_days}-${data.effort.max_days}` : '—'}
              <span className="unit">人日</span>
            </div>
            <div className="sub">
              {typeof data.effort?.confidence === 'number' && data.effort.confidence > 0
                ? `工时置信度 ${Math.round(data.effort.confidence * 100)}%`
                : '\u00a0'}
            </div>
          </div>
          {/* AI 自评置信度：反映「信息是否足够、结论有多可靠」，≥85% 表示信息已足够、不会再有澄清追问。
              与「工时置信度」不是同一个指标（后者只针对人日估算的把握）。 */}
          <div className="eval-stat">
            <div className="k">AI 预测置信度</div>
            {confidence === null ? (
              <>
                <div className="v muted">—</div>
                <div className="sub">本次评估未返回有效置信度，需重新评估</div>
              </>
            ) : (
              <>
                <div className="v" style={{ color: confidence >= 0.85 ? 'var(--success-ink)' : 'var(--warn-ink)' }}>
                  {Math.round(confidence * 100)}<span className="unit">%</span>
                </div>
                <div className="sub">{confidence >= 0.85 ? '信息已足够' : '信息仍有缺口，可能继续澄清'}</div>
              </>
            )}
          </div>
          <div className="eval-verdict">
            <span className={`tag ${scheduleClass}`}>{scheduleLabel}</span>
            <div className="sub">需求合理性：{needsAttention ? '需关注' : '合理'}</div>
          </div>
        </div>
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)', fontSize: 13, lineHeight: 1.65 }}>
          <b>排期建议：</b>{scheduling.advice}
        </div>
      </div>

      {/* 只展示最重要的 3-6 项；历史报告即使字段更多也不再淹没首屏。 */}
      {visibleAttention.length > 0 && (
        <div className="card card-pad" style={{ marginTop: 14, borderColor: needsAttention ? 'var(--warn)' : 'var(--border)' }}>
          <div className="section-title row" style={{ marginBottom: 10 }}>
            <Icon name="warning" size={16} />
            <span>需要关注（{visibleAttention.length}）</span>
            {needsAttention && <span className="tag tag-orange" style={{ marginLeft: 'auto', fontSize: 11 }}>有风险，建议先和 CSM/产品对齐</span>}
          </div>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
            {visibleAttention.map((item, i) => (
              <li key={i} style={{ padding: '8px 0', borderTop: i === 0 ? 'none' : '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                {item.level && <span className={`tag ${item.level === '高' ? 'tag-danger' : item.level === '中' ? 'tag-warn' : 'tag-grey'}`} style={{ flex: '0 0 auto', fontSize: 10, padding: '1px 6px' }}>{item.level}</span>}
                <span style={{ fontSize: 13, lineHeight: 1.65, flex: 1 }}>{item.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="muted" style={{ marginTop: 12, fontSize: 11, textAlign: 'right' }}>
        AI 评审只关注需求合理性、价值、难度与风险，不含技术实现细节（如有疑问请「和 AI 追问对话」了解）
      </div>
    </div>
  );
}

export function NoteView({ data }: { data: any }) {
  return (
    <div>
      <p className="md">{data.summary}</p>
      {data.issues?.length > 0 && <ul style={{ marginTop: 10, paddingLeft: 18 }}>
        {data.issues.map((s: string, i: number) => <li key={i} style={{ color: 'var(--warn)', fontSize: 13, padding: 2 }}>{s}</li>)}</ul>}
    </div>
  );
}

/** 用例对需求查看者可见；只有详情页判定有维护权限时才显示执行控件，默认只读。 */
export function TestCaseView({ cases, reqId, artifact, canEdit = false, onSaved }: { cases: any[]; reqId: number; artifact: Artifact; canEdit?: boolean; onSaved: () => void }) {
  const { toast } = useApp();
  const [list, setList] = useState(cases);
  /** 保存失败（包括负责人变更后的 403）必须明确提示，不能展示保存成功。 */
  const save = async () => {
    if (!canEdit) return;
    try {
      await api.post(`/api/requirements/${reqId}/artifacts`, { kind: 'TEST_CASE', content: JSON.stringify(list, null, 2) });
      toast('用例结果已保存'); onSaved();
    } catch (error: any) {
      console.warn('[TestCaseView] save failed', { requirement_id: reqId, reason: error.message });
      toast(error.message || '用例结果保存失败', 'error');
    }
  };
  const setResult = (i: number, v: string) => setList((l) => l.map((x, j) => (j === i ? { ...x, result: v } : x)));
  const setAll = (v: string) => setList((l) => l.map((x) => ({ ...x, result: v })));
  const passed = list.filter((c) => c.result === 'PASS').length;
  const allPassed = list.length > 0 && passed === list.length;
  // result 只认 'PASS' 为通过；勾选即通过，取消勾选回到「未执行」（失败态只能走右侧下拉，避免误覆盖）
  const isPass = (c: any) => c.result === 'PASS';
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        {canEdit && <>
          <button className="btn btn-primary btn-sm" onClick={() => setAll('PASS')} disabled={allPassed}>一键勾选通过</button>
          <button className="btn btn-sm" onClick={() => setAll('')} disabled={passed === 0}>清空结果</button>
        </>}
        <span className="muted" style={{ fontSize: 12 }}>已通过 {passed}/{list.length}</span>
        {!canEdit && <span className="muted" style={{ fontSize: 12 }}>只读</span>}
      </div>
      <table className="tbl">
        <thead><tr>
          {canEdit && <th style={{ width: 36 }}>
            <input type="checkbox" checked={allPassed} title="全选通过" onChange={(e) => setAll(e.target.checked ? 'PASS' : '')} />
          </th>}
          <th>类型</th><th>用例</th><th>步骤</th><th>预期</th><th>结果</th>
        </tr></thead>
        <tbody>
          {list.map((c, i) => (
            <tr key={i}>
              {canEdit && <td>
                <input
                  type="checkbox"
                  checked={isPass(c)}
                  title="勾选=通过"
                  onChange={(e) => setResult(i, e.target.checked ? 'PASS' : '')}
                />
              </td>}
              <td><span className={`tag tag-${c.type === '正常流' ? 'green' : c.type === '边界流' ? 'orange' : 'red'}`}>{c.type}</span></td>
              <td>{c.title}</td><td className="muted">{c.steps}</td><td className="muted">{c.expect}</td>
              <td>
                {canEdit ? <SearchSelect
                  options={[{ value: '', label: '未执行' }, { value: 'PASS', label: '通过' }, { value: 'FAIL', label: '失败' }]}
                  value={c.result}
                  onChange={(v) => setResult(i, String(v))}
                  width={90}
                  placeholder="未执行"
                /> : <span>{c.result === 'PASS' ? '通过' : c.result === 'FAIL' ? '失败' : '未执行'}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canEdit && <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={save}>保存执行结果</button>}
    </div>
  );
}
