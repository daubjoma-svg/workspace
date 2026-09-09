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
      {/* Hero 摘要：等级 + 人日 + 判定（一行精炼，CSM/产品一眼看到） */}
      <div className="card card-pad" style={{ background: needsAttention ? 'var(--warn-wash)' : 'var(--success-wash)', borderColor: needsAttention ? 'var(--warn)' : 'var(--success)' }}>
        <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 14 }}>
          <div>
            <div className="muted" style={{ fontSize: 11 }}>改动等级</div>
            <div style={{
              fontSize: 32, fontWeight: 800,
              color: levelColor(data.level),
              background: `linear-gradient(135deg, ${levelColor(data.level)}22 0%, transparent 100%)`,
              padding: '2px 12px', borderRadius: 6,
            }}>{data.level || '—'}</div>
            {levelDesc(data.level) && (
              <div className="muted" style={{ fontSize: 11, marginTop: 4, color: levelColor(data.level) }}>{levelDesc(data.level)}</div>
            )}
          </div>
          {data.effort && (
            <div>
              <div className="muted" style={{ fontSize: 11 }}>预估工时</div>
              <div style={{ fontSize: 28, fontWeight: 700 }}>{data.effort.min_days}-{data.effort.max_days} <span style={{ fontSize: 14, fontWeight: 400 }} className="muted">人日</span></div>
            </div>
          )}
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <span className={`tag ${needsAttention ? 'tag-orange' : 'tag-green'}`} style={{ fontSize: 13, padding: '4px 12px' }}>
              {needsAttention ? '需关注' : '需求可行'}
            </span>
            {typeof data.effort?.confidence === 'number' && data.effort.confidence > 0 && (
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>置信度 {Math.round(data.effort.confidence * 100)}%</div>
            )}
          </div>
        </div>
        {data.rationality?.reason && (
          <p className="md" style={{ marginTop: 12, marginBottom: 0, fontSize: 13.5, color: 'var(--text-2)' }}>{data.rationality.reason}</p>
        )}
      </div>

      {/* 业务评估：客户 + 产品 双视角 */}
      {data.perspectives && (
        <div className="grid2" style={{ marginTop: 14 }}>
          {[['customer', '客户视角'], ['product', '产品视角']].map(([k, label]) => {
            const text = data.perspectives?.[k];
            if (!text) return null;
            return (
              <div key={k} className="card card-pad" style={{ background: 'var(--panel-2)' }}>
                <div className="section-title" style={{ marginBottom: 6 }}>{label}</div>
                <p className="md" style={{ fontSize: 13, lineHeight: 1.7 }}>{text}</p>
              </div>
            );
          })}
        </div>
      )}

      {/* 需要关注（合并原 attention_points + risks，按等级排序，业务级表述） */}
      {attentionMerged.length > 0 && (
        <div className="card card-pad" style={{ marginTop: 14, borderColor: needsAttention ? 'var(--warn)' : 'var(--border)' }}>
          <div className="section-title row" style={{ marginBottom: 10 }}>
            <Icon name="warning" size={16} />
            <span>需要关注（{attentionMerged.length}）</span>
            {needsAttention && <span className="tag tag-orange" style={{ marginLeft: 'auto', fontSize: 11 }}>有风险，建议先和 CSM/产品对齐</span>}
          </div>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
            {attentionMerged.map((item, i) => (
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

export function TestCaseView({ cases, reqId, artifact, onSaved }: { cases: any[]; reqId: number; artifact: Artifact; onSaved: () => void }) {
  const { toast } = useApp();
  const [list, setList] = useState(cases);
  const save = async () => {
    await api.post(`/api/requirements/${reqId}/artifacts`, { kind: 'TEST_CASE', content: JSON.stringify(list, null, 2) });
    toast('用例结果已保存'); onSaved();
  };
  return (
    <div>
      <table className="tbl">
        <thead><tr><th>类型</th><th>用例</th><th>步骤</th><th>预期</th><th>结果</th></tr></thead>
        <tbody>
          {list.map((c, i) => (
            <tr key={i}>
              <td><span className={`tag tag-${c.type === '正常流' ? 'green' : c.type === '边界流' ? 'orange' : 'red'}`}>{c.type}</span></td>
              <td>{c.title}</td><td className="muted">{c.steps}</td><td className="muted">{c.expect}</td>
              <td>
                <SearchSelect
                  options={[{ value: '', label: '未执行' }, { value: 'PASS', label: '通过' }, { value: 'FAIL', label: '失败' }]}
                  value={c.result}
                  onChange={(v) => setList((l) => l.map((x, j) => j === i ? { ...x, result: String(v) } : x))}
                  width={90}
                  placeholder="未执行"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={save}>保存执行结果</button>
    </div>
  );
}
