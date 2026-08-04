import React, { useEffect, useState } from 'react';
import { api, Requirement, Artifact, TimelineItem, STATUS_NAME, AI_ACTIONS } from '../api';
import { useApp } from '../App';
import { Icon } from '../components/Icon';

const KIND_NAME: Record<string, string> = {
  EVALUATION: 'AI 评估报告', PRD: 'PRD 文档', DEV_PROMPT: '研发提示词',
  TEST_CASE: '测试用例', TEST_REPORT: '测试报告', CODE_SUBMIT: '代码提交', NOTE: 'AI 记录',
};

export default function ReqDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const { user, toast } = useApp();
  const [req, setReq] = useState<Requirement | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [tab, setTab] = useState('EVALUATION');
  const [returnReason, setReturnReason] = useState('');
  const [showReturn, setShowReturn] = useState(false);
  const [showForce, setShowForce] = useState(false);
  const [forceNote, setForceNote] = useState('');
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [prdEdit, setPrdEdit] = useState('');
  const [editingPrd, setEditingPrd] = useState(false);

  const load = async () => {
    const r = await api.get(`/api/requirements/${id}`);
    setReq(r);
    setArtifacts(await api.get(`/api/requirements/${id}/artifacts`));
    setTimeline(await api.get(`/api/requirements/${id}/timeline`));
  };
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [id]);

  if (!req) return <div className="empty">加载中…</div>;

  const nodes = req.nodes || [];
  const curNode = nodes.find((n) => n.seq === req.current_seq);
  const [sname, scolor] = STATUS_NAME[req.status] || [req.status, 'grey'];
  const myRoleOnNode = curNode?.node_type === 'HUMAN' && curNode.role === user?.role;
  // 打回到 AI 节点后挂起：CSM（提交人）或管理员可确认重跑
  const heldAI = curNode?.node_type === 'AI' && req.status === 'PENDING';
  const canOperate = (myRoleOnNode && req.status === 'PENDING')
    || (heldAI && (req.csm_id === user?.id))
    || user?.role === 'ADMIN';
  const canClarify = req.status === 'CLARIFYING' && (req.csm_id === user?.id || user?.role === 'ADMIN');

  const doAction = async (action: string, body?: any) => {
    try { await api.post(`/api/requirements/${id}/${action}`, body); await load(); }
    catch (e: any) { toast(e.message); }
  };
  const answerAll = async () => {
    const open = req.open_clarifies || [];
    for (const c of open) {
      if (!answers[c.id]?.trim()) { toast('请回答全部问题，或选择强制提交'); return; }
    }
    for (const c of open) await api.post(`/api/clarifies/${c.id}/answer`, { answer: answers[c.id] });
    toast('已提交澄清，AI 重新处理中'); load();
  };
  const savePrd = async () => {
    await api.post(`/api/requirements/${id}/artifacts`, { kind: 'PRD', content: prdEdit });
    setEditingPrd(false); toast('PRD 已保存'); load();
  };

  const latest = (kind: string) => artifacts.find((a) => a.kind === kind);
  const renderContent = (a?: Artifact) => {
    if (!a) return <div className="empty">暂无内容</div>;
    try {
      const obj = JSON.parse(a.content);
      if (a.kind === 'EVALUATION') return <EvaluationView data={obj} />;
      if (a.kind === 'TEST_CASE' && Array.isArray(obj)) return <TestCaseView cases={obj} reqId={id} artifact={a} onSaved={load} />;
      if (a.kind === 'NOTE') return <NoteView data={obj} />;
      return <pre className="md">{JSON.stringify(obj, null, 2)}</pre>;
    } catch { return <div className="md">{a.content}</div>; }
  };

  const prd = latest('PRD');

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="crumb">
            <button className="btn-ghost btn btn-sm" onClick={onBack} style={{ padding: '2px 6px', marginLeft: -6 }}>
              <Icon name="back" size={16} />
              工作台
            </button>
            <span style={{ margin: '0 6px' }}>/</span>{req.req_no}
          </div>
          <div className="row" style={{ gap: 10 }}>
            <h1>{req.title}</h1>
            <span className={`tag tag-${scolor}`}>{sname}</span>
            {req.level && <span className="tag tag-blue">{req.level}</span>}
          </div>
        </div>
      </div>

      {/* 节点步骤条 */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="steps">
          {nodes.map((n) => {
            const done = n.seq < req.current_seq || req.status === 'DONE';
            const cur = n.seq === req.current_seq && req.status !== 'DONE';
            return (
              <div key={n.id} className={`step ${cur ? 'cur' : ''} ${done ? 'done' : ''}`}>
                <span className="dot" />
                {n.node_type === 'AI' && <span className="ai-badge">AI</span>}
                {n.name}
              </div>
            );
          })}
        </div>
        {curNode && req.status !== 'DONE' && (
          <div className="muted" style={{ marginTop: 12 }}>
            当前节点：「{curNode.name}」
            {curNode.node_type === 'AI' ? ` · AI 动作：${AI_ACTIONS[curNode.ai_action || 'CUSTOM']}` : ` · 负责人角色：${curNode.role}`}
          </div>
        )}
      </div>

      {/* 待澄清 */}
      {req.status === 'CLARIFYING' && (
        <div className="card card-pad" style={{ marginBottom: 16, borderColor: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 5%, var(--panel))' }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="dot warn" />
            <b>AI 提出了 {req.open_clarifies?.length} 个待澄清问题</b>
          </div>
          {((req.open_clarifies as any[]) || []).map((c: any, i: number) => (
            <div key={c.id} style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 500 }}>{i + 1}. {c.question}</div>
              {canClarify
                ? <textarea className="input" rows={2} style={{ marginTop: 6 }} placeholder="填写回答…"
                    value={answers[c.id] || ''} onChange={(e) => setAnswers((a) => ({ ...a, [c.id]: e.target.value }))} />
                : <div className="muted" style={{ marginTop: 4 }}>等待 CSM 回答</div>}
            </div>
          ))}
          {canClarify && (
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={answerAll}>提交回答</button>
              <button className="btn btn-danger" onClick={() => setShowForce(true)}>强制提交（跳过澄清）</button>
            </div>
          )}
        </div>
      )}

      {/* 人工操作区 */}
      {canOperate && (
        <div className="card card-pad row" style={{ marginBottom: 16, borderColor: 'var(--primary)', background: 'color-mix(in srgb, var(--primary) 4%, var(--panel))' }}>
          <div className="row" style={{ gap: 8, marginRight: 'auto' }}>
            <span className="dot cur" />
            <b>{heldAI ? `AI 节点「${curNode?.name}」已挂起（被打回/失败）` : `该你处理了：「${curNode?.name}」`}</b>
          </div>
          {user?.role === 'PO' && prd && <button className="btn" onClick={() => { setPrdEdit(prd.content); setEditingPrd(true); }}>编辑 PRD</button>}
          <button className="btn btn-primary" onClick={() => doAction('confirm')}>
            {heldAI ? '重新执行该 AI 节点' : '确认，流转下一步'}
          </button>
          {!heldAI && <button className="btn btn-danger" onClick={() => setShowReturn(true)}>打回</button>}
        </div>
      )}

      <div className="split">
        <div>
          {/* 需求信息 */}
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <div className="section-title">需求信息</div>
            <div className="grid3" style={{ fontSize: 13 }}>
              <div><span className="muted">客户：</span>{req.customer_name || '—'}</div>
              <div><span className="muted">紧急度：</span>{req.priority}</div>
              <div><span className="muted">期望上线：</span>{req.expect_date || '—'}</div>
              <div><span className="muted">CSM：</span>{req.csm_name}</div>
              <div><span className="muted">产品：</span>{req.po_name || '—'}</div>
              <div><span className="muted">研发/测试：</span>{req.rd_name || '—'} / {req.qa_name || '—'}</div>
            </div>
            {req.modules && req.modules.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <span className="muted" style={{ fontSize: 12 }}>关联平台模块：</span>
                <div className="chip-group" style={{ marginTop: 6 }}>
                  {req.modules.map((m) => (
                    <span key={m.id} className={`chip on sm`} title={`代码模块:${m.code_module_name} · ${m.sync_status === 'OK' ? '已同步 ' + (m.last_synced_at || '') : '未同步'}`}>
                      {m.platform_name}
                      <span className={`chip-dot ${m.sync_status === 'OK' ? '' : 'off'}`} />
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="md" style={{ marginTop: 14, padding: 14, background: 'var(--panel-2)', borderRadius: 10, border: '1px solid var(--border)' }}>{req.description}</div>
          </div>

          {/* 产物 */}
          <div className="card">
            <div className="row" style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', gap: 6 }}>
              {Object.keys(KIND_NAME).map((k) => {
                const has = artifacts.some((a) => a.kind === k);
                return (
                  <button key={k} className={`btn btn-sm ${tab === k ? 'btn-primary' : ''}`} style={!has ? { opacity: .45 } : {}}
                    onClick={() => setTab(k)}>
                    {KIND_NAME[k]}{has ? '' : ' ·无'}
                  </button>
                );
              })}
            </div>
            <div className="card-pad">{renderContent(latest(tab))}</div>
          </div>
        </div>

        {/* 时间线 */}
        <div className="card card-pad">
          <div className="section-title">流转记录</div>
          <div className="timeline">
            {[...timeline].reverse().map((t) => (
              <div className="tl-item" key={t.id}>
                <div style={{ fontSize: 13 }}><b>{t.operator}</b> · {actionName(t.action)}</div>
                {t.detail && <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{t.detail}</div>}
                <div className="muted">{t.created_at}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 打回弹窗 */}
      {showReturn && (
        <div className="modal-mask" onClick={() => setShowReturn(false)}>
          <div className="modal card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-h">打回到上一节点</div>
            <div className="modal-b">
              <div className="form-row"><label>打回原因 *</label>
                <textarea className="input" rows={3} value={returnReason} onChange={(e) => setReturnReason(e.target.value)} /></div>
            </div>
            <div className="modal-f">
              <button className="btn" onClick={() => setShowReturn(false)}>取消</button>
              <button className="btn btn-danger" onClick={async () => {
                if (!returnReason.trim()) return toast('请填写打回原因');
                await doAction('return', { reason: returnReason }); setShowReturn(false); setReturnReason('');
              }}>确认打回</button>
            </div>
          </div>
        </div>
      )}

      {/* 强制提交弹窗 */}
      {showForce && (
        <div className="modal-mask" onClick={() => setShowForce(false)}>
          <div className="modal card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-h">强制提交</div>
            <div className="modal-b">
              <p style={{ marginBottom: 12, color: 'var(--warn)' }}>未回答全部澄清问题，直接推进流程。该操作会记录在时间线中。</p>
              <div className="form-row"><label>备注（可选）</label>
                <input className="input" value={forceNote} onChange={(e) => setForceNote(e.target.value)} placeholder="强制提交原因…" /></div>
            </div>
            <div className="modal-f">
              <button className="btn" onClick={() => setShowForce(false)}>取消</button>
              <button className="btn btn-danger" onClick={async () => {
                await doAction('force-submit', { note: forceNote }); setShowForce(false); setForceNote('');
              }}>确认强制提交</button>
            </div>
          </div>
        </div>
      )}

      {/* PRD 编辑 */}
      {editingPrd && (
        <div className="modal-mask" onClick={() => setEditingPrd(false)}>
          <div className="modal card" style={{ width: 760 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-h">编辑 PRD（保存为新版本）</div>
            <div className="modal-b">
              <textarea className="input" rows={20} value={prdEdit} onChange={(e) => setPrdEdit(e.target.value)} style={{ fontFamily: 'monospace', fontSize: 13 }} />
            </div>
            <div className="modal-f">
              <button className="btn" onClick={() => setEditingPrd(false)}>取消</button>
              <button className="btn btn-primary" onClick={savePrd}>保存版本</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function actionName(a: string) {
  return ({
    CREATE: '创建草稿', SUBMIT: '提交需求', ENTER_NODE: '进入节点', AI_START: 'AI 开始执行',
    AI_DONE: 'AI 执行完成', AI_FAIL: 'AI 执行失败', CLARIFY: '发起澄清', CLARIFY_ANSWER: '回复澄清',
    CLARIFY_DONE: '澄清完成', CONFIRM: '确认流转', RETURN: '打回', FORCE_SUBMIT: '强制提交',
    ARTIFACT_SAVE: '保存产物', DONE: '流程完成', CANCEL: '取消需求',
  } as Record<string, string>)[a] || a;
}

function EvaluationView({ data }: { data: any }) {
  return (
    <div>
      <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <span className={`tag tag-${data.rationality?.verdict === 'REASONABLE' ? 'green' : 'orange'}`}>
          {data.rationality?.verdict === 'REASONABLE' ? '需求合理' : data.rationality?.verdict === 'NEED_CLARIFY' ? '需要澄清' : '存疑'}
        </span>
        {data.level && <span className="tag tag-blue">改动等级 {data.level}</span>}
        {data.effort && <span className="tag tag-grey">预估 {data.effort.min_days}-{data.effort.max_days} 人日</span>}
      </div>
      <p className="md">{data.rationality?.reason}</p>
      {data.perspectives && (
        <div className="grid3" style={{ marginTop: 14 }}>
          {[['customer', '客户视角'], ['product', '产品视角'], ['engineering', '研发视角']].map(([k, label]) => (
            <div key={k} style={{ padding: 14, background: 'var(--panel-2)', borderRadius: 10, border: '1px solid var(--border)' }}>
              <div className="section-title" style={{ marginBottom: 6 }}>{label}</div>
              <p className="md" style={{ fontSize: 12.5 }}>{data.perspectives[k]}</p>
            </div>
          ))}
        </div>
      )}
      {data.impact_scope?.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <b>影响范围</b>
          <table className="tbl" style={{ marginTop: 8 }}>
            <thead><tr><th>模块</th><th>文件</th><th>接口</th><th>置信度</th></tr></thead>
            <tbody>
              {data.impact_scope.map((s: any, i: number) => (
                <tr key={i}><td>{s.module}</td><td className="muted">{(s.files || []).join(', ') || '—'}</td>
                  <td className="muted">{(s.apis || []).join(', ') || '—'}</td><td>{Math.round((s.confidence || 0) * 100)}%</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.risks?.length > 0 && (
        <div style={{ marginTop: 14 }}><b>风险点</b>
          <ul style={{ marginTop: 6, paddingLeft: 18 }}>{data.risks.map((r: string, i: number) => <li key={i} style={{ fontSize: 13, padding: 2 }}>{r}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function NoteView({ data }: { data: any }) {
  return (
    <div>
      <p className="md">{data.summary}</p>
      {data.issues?.length > 0 && <ul style={{ marginTop: 10, paddingLeft: 18 }}>
        {data.issues.map((s: string, i: number) => <li key={i} style={{ color: 'var(--warn)', fontSize: 13, padding: 2 }}>{s}</li>)}</ul>}
    </div>
  );
}

function TestCaseView({ cases, reqId, artifact, onSaved }: { cases: any[]; reqId: number; artifact: Artifact; onSaved: () => void }) {
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
                <select className="input" style={{ width: 90, padding: '4px 8px' }} value={c.result}
                  onChange={(e) => setList((l) => l.map((x, j) => j === i ? { ...x, result: e.target.value } : x))}>
                  <option value="">未执行</option><option value="PASS">通过</option><option value="FAIL">失败</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={save}>保存执行结果</button>
    </div>
  );
}
