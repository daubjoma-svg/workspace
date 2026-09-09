import React, { useEffect, useRef, useState } from 'react';
import { api, Requirement, Artifact, TimelineItem, STATUS_NAME, AI_ACTIONS } from '../api';
import { useApp } from '../App';
import { Icon } from '../components/Icon';
import { actionName, EvaluationView, NoteView, TestCaseView } from './ReqViews';
import { AiWarnBar } from '../components/AiWarnBar';
import { parseArtifactMeta } from '../lib/artifactMeta';
import { renderMarkdown } from '../lib/markdown';
import { PrdEditor } from '../components/PrdEditor';
import { ReqEditModal } from '../components/ReqEditModal';
import { AiRunningBar } from '../components/AiRunningBar';
import { ReqChat } from '../components/ReqChat';
import { ReqAssign } from '../components/ReqAssign';
import { RichText } from '../components/RichText';
import { isHtmlContent, sanitizeHtml } from '../lib/sanitize';
import { aiReplyToHtml } from '../lib/aiReply';

const KIND_NAME: Record<string, string> = {
  EVALUATION: 'AI 评估报告', PRD: 'PRD 文档', DEV_PROMPT: '研发提示词',
  TEST_CASE: '测试用例', TEST_REPORT: '测试报告',
};

/** 从 Jira URL 提取末尾单号段（与列表 jiraLabel 一致）。 */
function jiraLabel(url: string | null | undefined): string {
  if (!url) return '';
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    return segs.length ? segs[segs.length - 1] : '';
  } catch {
    const segs = String(url).split('/').filter(Boolean);
    return segs.length ? segs[segs.length - 1] : '';
  }
}

export default function ReqDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const { user, toast } = useApp();
  const [req, setReq] = useState<Requirement | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [tab, setTab] = useState('EVALUATION');
  const [returnReason, setReturnReason] = useState('');
  const [showReturn, setShowReturn] = useState(false);
  const [editingPrd, setEditingPrd] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  /** 流转记录默认收起（量大时占地方），点开折叠 */
  const [showTimeline, setShowTimeline] = useState(false);
  /** 和 AI 继续对话：就着当前 tab 的产物追问（历史落库 req_ai_chats，可回看） */
  const [aiOpen, setAiOpen] = useState(false);
  const [aiQ, setAiQ] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiTurns, setAiTurns] = useState<{ q: string; a: string; who: string; when?: string }[]>([]);
  const aiBodyRef = useRef<HTMLDivElement>(null);
  // 新消息追加后自动滚到底
  useEffect(() => {
    const el = aiBodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [aiTurns.length, aiBusy]);

  const loadAiChats = async () => {
    try {
      const rows = await api.get(`/api/requirements/${id}/ai-chats`);
      setAiTurns((rows || []).map((x: any) => ({ q: x.question, a: x.reply, who: x.created_by, when: x.created_at })));
    } catch { /* 历史拉取失败不阻断 */ }
  };
  useEffect(() => { loadAiChats(); }, [id]);

  const askAi = async () => {
    if (!aiQ.trim() || aiBusy) return;
    const question = aiQ.trim();
    setAiQ('');
    setAiTurns((t) => [...t, { q: question, a: '', who: user?.name || '我', when: new Date().toISOString() }]);
    setAiBusy(true);
    try {
      // AI 永远走 Agent 模式（自主探索代码），无需用户填 focus_paths
      const r = await api.post(`/api/requirements/${id}/ai-chat`, { message: question, artifact_kind: tab });
      setAiTurns((t) => [...t, { q: '', a: r.reply || '', who: 'AI', when: new Date().toISOString() }]);
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setAiBusy(false); }
  };

  const load = async () => {
    try {
      const [r, a, t] = await Promise.all([
        api.get(`/api/requirements/${id}`),
        api.get(`/api/requirements/${id}/artifacts`),
        api.get(`/api/requirements/${id}/timeline`),
      ]);
      setReq(r); setArtifacts(a); setTimeline(t);
    } catch (e) {
      // 单次拉取失败不渲染任何东西（保留上一次的数据，避免空白闪烁）
      console.warn('[ReqDetail] load failed', e);
    }
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [id]);

  if (!req) return <div className="empty">加载中…</div>;

  const nodes = req.nodes || [];
  const curNode = nodes.find((n) => n.seq === req.current_seq);
  const [sname, scolor] = STATUS_NAME[req.status] || [req.status, 'grey'];
  const myRoleOnNode = curNode?.node_type === 'HUMAN' && curNode.role === user?.role;
  // 打回到 AI 节点后挂起：CSM（提交人）或管理员可确认重跑；AI 执行失败（AI_FAILED）同样挂起待重跑
  const heldAI = curNode?.node_type === 'AI' && (req.status === 'PENDING' || req.status === 'AI_FAILED');
  // AI 正在执行（包括澄清等待）：禁止任何人点确认/打回，避免并发触发导致多轮 advance 串联跳步
  const nodeAiBusy = curNode?.node_type === 'AI' && (req.status === 'AI_RUNNING' || req.status === 'CLARIFYING');
  // 方案 B：当前 AI 节点最近产物是兜底（is_mock）时提示「AI 未真评估」+ 给「跳过继续」选项
  const curArtifact = heldAI ? artifacts.filter((a) => a.kind === (curNode?.ai_action === 'EVALUATE' ? 'EVALUATION' : 'NOTE')).pop() : null;
  const curIsMock = heldAI && !!curArtifact && !!(parseArtifactMeta(curArtifact.meta)?.is_mock);
  // 流程已结束（DONE/CANCELLED，current_seq=999/-1 查不到节点）或当前节点不在模板里时，
  // 任何人（含 ADMIN）都不应再看到「该你处理了」操作卡，避免渲染「该你处理了：undefined」
  const flowEnded = req.status === 'DONE' || req.status === 'CANCELLED' || !curNode;
  const canOperate = !flowEnded && (
    (myRoleOnNode && req.status === 'PENDING' && !nodeAiBusy)
    || (heldAI && (req.csm_id === user?.id))
    || (user?.role === 'ADMIN' && (req.status === 'PENDING' || req.status === 'AI_FAILED' || heldAI))
  );
  const [submitting, setSubmitting] = useState(false);
  const doAction = async (action: string, body?: any) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.post(`/api/requirements/${id}/${action}`, body);
      await load();
      // confirm/force-submit 后页面应已切换到新节点，强制滚动到顶部让用户看到节点徽章变化
      if (action === 'confirm' || action === 'force-submit' || action === 'return') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        toast(action === 'return' ? '已打回需求提交节点' : '已流转到下一节点');
      }
    } catch (e: any) { toast(e.message); }
    finally { setSubmitting(false); }
  };
  // 编辑权限：提单人或 ADMIN；DONE/CANCELLED 后端 400，直接隐藏
  const canEditReq = (user?.role === 'ADMIN' || req.csm_id === user?.id)
    && req.status !== 'DONE' && req.status !== 'CANCELLED';
  // 产品（负责人或 ADMIN）可指派研发/测试；只在 PO 节点 + 流程未结束 + 当前未过 PO 节点时显示
  // 用户需求：PO 不指派不允许 confirm；过了 PO 节点后指派不允许再改（避免修改后责任不清）
  const isPoNode = nodes.find((n) => n.seq === req.current_seq)?.role === 'PO';
  const canAssign = (user?.role === 'ADMIN' || req.po_id === user?.id)
    && req.status !== 'DONE' && req.status !== 'CANCELLED'
    && isPoNode;
  // QA 人工节点已完成 → 测试产物区提示「等待目标版本即可上线」
  const qaDone = req.status === 'DONE' || nodes.some((n) => n.role === 'QA' && n.seq < req.current_seq);

  const savePrd = async (content: string) => {
    try { await api.post(`/api/requirements/${id}/artifacts`, { kind: 'PRD', content }); setEditingPrd(false); toast('PRD 已保存'); load(); }
    catch (e: any) { toast(e.message); }
  };

  const latest = (kind: string) => artifacts.find((a) => a.kind === kind);
  const renderContent = (a?: Artifact) => {
    if (!a) return <div className="empty">暂无内容</div>;
    const meta = parseArtifactMeta(a.meta);
    const warn = <AiWarnBar meta={meta} />;
    // PRD 产物：新版 HTML 富文本 → sanitizeHtml 白名单渲染；存量 Markdown/纯文本 → renderMarkdown（元素树天然免 XSS）
    if (a.kind === 'PRD') {
      const prdHtml = isHtmlContent(a.content) ? sanitizeHtml(a.content) : null;
      return <>{warn}<div className="md md-render">{prdHtml ? <div dangerouslySetInnerHTML={{ __html: prdHtml }} /> : renderMarkdown(a.content)}</div></>;
    }
    // DEV_PROMPT 产物：Markdown 文本（traecli 直接给 Markdown，不再是 JSON 结构）→ renderMarkdown 富文本渲染
    if (a.kind === 'DEV_PROMPT') {
      // 兼容历史 JSON 兜底产物 {text,_source:'fallback'}：剥离包装
      let text = a.content;
      try { const o = JSON.parse(text); if (o && typeof o.text === 'string') text = o.text; } catch { /* 保持原文（已经是 markdown） */ }
      return <>{warn}<div className="md md-render">{renderMarkdown(String(text))}</div></>;
    }
    try {
      const obj = JSON.parse(a.content);
      if (a.kind === 'EVALUATION') return <>{warn}<EvaluationView data={obj} meta={meta} /></>;
      if (a.kind === 'TEST_CASE' && Array.isArray(obj)) return <>{warn}<TestCaseView cases={obj} reqId={id} artifact={a} onSaved={load} /></>;
      if (a.kind === 'NOTE') return <>{warn}<NoteView data={obj} /></>;
      // 历史兜底产物（旧版本 minimalFallback 包成 {text,_source:'fallback'}）且不是 EVALUATION/TEST_CASE/NOTE：用友好提示替代 raw JSON
      // EVALUATION/TEST_CASE/NOTE 走自己的 View 组件，由 View 内部按 is_mock 处理，不在此处拦截。
      if (obj && typeof obj === 'object' && obj._source === 'fallback') {
        const friendly = obj.text || obj.summary || 'AI 未返回结构化产物，请人工补充。';
        return <>{warn}<div className="md" style={{ color: 'var(--text-2)' }}>{friendly}<br /><span className="muted">（历史兜底产物，非真实 AI 输出）</span></div></>;
      }
      return <>{warn}<pre className="md">{JSON.stringify(obj, null, 2)}</pre></>;
    } catch { return <>{warn}<div className="md">{a.content}</div></>; }
  };

  const prd = latest('PRD');
  // 产品评审人工节点：无 PRD 产物时前端先拦确认流转（后端 400 为硬兜底）
  const needPrd = user?.role === 'PO' && curNode?.node_type === 'HUMAN' && curNode?.role === 'PO' && !prd;
  const onConfirm = () => {
    if (needPrd) { toast('请补充 PRD 文档后确认流转'); return; }
    // PO 节点 confirm 前端校验：必须先指派 RD + QA（后端也会校验兜底，但前端拦截可滚动到指派区）
    if (isPoNode && (!req.rd_id || !req.qa_id)) {
      toast('请先指派研发负责人和测试负责人后再提交');
      // 滚动到指派区（ReqAssign 就在需求描述下方）
      const el = document.getElementById('req-assign-anchor');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    doAction('confirm');
  };

  const showTestDone = qaDone && (tab === 'TEST_CASE' || tab === 'TEST_REPORT');

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

      {/* AI 分析中：整页顶部进度提示（细条 + spinner，让用户立即感知系统在干活） */}
      {req.status === 'AI_RUNNING' && <div className="ai-progress-bar" role="status" aria-live="polite"><Icon name="loader" size={16} className="spin" /><span>AI 正在分析中，预计 5-15 秒…</span></div>}

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
        <AiRunningBar aiRunning={req.status === 'AI_RUNNING' && curNode?.node_type === 'AI'} aiAction={curNode?.ai_action} startAt={(req as any).status_changed || (req as any).touched_at || req.updated_at} />
      </div>

      {/* 人工操作区 */}
      {canOperate && (
        <div className="card card-pad row" style={{ marginBottom: 16, borderColor: 'var(--primary)', background: 'color-mix(in srgb, var(--primary) 4%, var(--panel))' }}>
          <div className="row" style={{ gap: 8, marginRight: 'auto' }}>
            <span className="dot cur" />
            <b>{heldAI
              ? (curIsMock
                ? `AI 节点「${curNode?.name}」未产出真实评估（兜底产物），请三选：重新执行 / 跳过继续 / 补产物`
                : `AI 节点「${curNode?.name}」已挂起（被打回/失败）`)
              : `该你处理了：「${curNode?.name}」`}</b>
          </div>
          {user?.role === 'PO' && <button className="btn" onClick={() => setEditingPrd(true)}>{prd ? '编辑 PRD' : '添加 PRD'}</button>}
          {heldAI && curIsMock && (
            <button className="btn" onClick={() => doAction('skip-ai')} disabled={submitting} title="AI 未真评估，跳过继续走流程（兜底产物保留供参考）">
              <Icon name="forward" size={16} /> 跳过继续
            </button>
          )}
          <button className="btn btn-primary" onClick={onConfirm} disabled={submitting || nodeAiBusy}>
            {submitting ? <Icon name="loader" size={16} className="spin" /> : null}
            {heldAI ? '重新执行该 AI 节点' : (nodeAiBusy ? 'AI 执行中…' : '确认，流转下一步')}
          </button>
          {!heldAI && !nodeAiBusy && <button className="btn btn-danger" onClick={() => setShowReturn(true)} disabled={submitting}>打回</button>}
        </div>
      )}

      {/* 研发节点专用：开发提交表单（分支 + 改动摘要 + 补充文档） */}
      {curNode?.role === 'RD' && <RdSubmitForm reqId={id} onSubmitted={load} />}

      <div className="split">
        <div>
          {/* 需求信息 */}
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <div className="section-title section-head">
              <span>需求信息</span>
              {canEditReq && (
                <button className="btn btn-sm btn-ghost" onClick={() => setShowEdit(true)}>
                  <Icon name="edit" size={16} /> 编辑
                </button>
              )}
            </div>
            <div className="grid3" style={{ fontSize: 13 }}>
              <div><span className="muted">客户：</span>{req.customer_name || '—'}</div>
              <div><span className="muted">紧急度：</span>{req.priority}</div>
              <div><span className="muted">目标版本：</span>{req.target_version || '待定'}</div>
              <div><span className="muted">需求发起人：</span>{req.csm_name}</div>
              <div><span className="muted">产品：</span>{req.po_name || '待指派'}</div>
              <div><span className="muted">研发/测试：</span>{req.rd_name || '待指派'} / {req.qa_name || '待指派'}</div>
              <div><span className="muted">创建时间：</span>{(req.created_at || '').replace('T', ' ').slice(0, 16) || '—'}</div>
              <div><span className="muted">当前等级：</span>{req.level || '未定级'}</div>
              <div><span className="muted">Jira：</span>{req.jira_url ? (
                <a href={req.jira_url} target="_blank" rel="noopener noreferrer" className="jira-link"
                  title={req.jira_url}>
                  <Icon name="link" size={16} /> {jiraLabel(req.jira_url)}
                </a>
              ) : '—'}</div>
            </div>
            {req.modules && req.modules.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <span className="muted" style={{ fontSize: 12 }}>关联业务模块：</span>
                <div className="chip-group" style={{ marginTop: 6 }}>
                  {/* v0.7：modules 项是 (业务模块, [code_module]) 的笛卡尔积；按 business_module_id 聚合展示 */}
                  {(() => {
                    const byBiz = new Map<number, { name: string; repos: any[] }>();
                    for (const m of req.modules) {
                      if (!byBiz.has(m.business_module_id)) byBiz.set(m.business_module_id, { name: m.business_name, repos: [] });
                      if (m.code_module_id) byBiz.get(m.business_module_id)!.repos.push(m);
                    }
                    return Array.from(byBiz.values()).map((bm, i) => {
                      const synced = bm.repos.filter((r) => r.sync_status === 'OK').length;
                      const ok = bm.repos.length > 0 && synced === bm.repos.length;
                      return (
                        <span key={i} className="chip on sm" title={bm.repos.length ? `挂载 ${bm.repos.length} 个代码仓库，${synced} 已同步` : '未挂载代码仓库'}>
                          {bm.name}
                          <span className={`chip-dot ${ok ? '' : 'off'}`} />
                        </span>
                      );
                    });
                  })()}
                </div>
              </div>
            )}
            <RichText html={req.description} className="md" style={{ marginTop: 14, padding: 14, background: 'var(--panel-2)', borderRadius: 10, border: '1px solid var(--border)' }} />

            {/* 产品指派研发/测试 */}
            {canAssign && <div id="req-assign-anchor"><ReqAssign req={req} onSaved={load} /></div>}
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
            <div className="card-pad">
              {showTestDone && (
                <div className="test-done-bar">
                  <Icon name="check" size={16} />
                  <span>测试完成，等待目标版本 {req.target_version || '待定'} 即可上线</span>
                </div>
              )}
              {renderContent(latest(tab))}
            </div>
          </div>
          </div>

          {/* 右侧栏：需求聊天工作室 sticky · 贯穿详情 */}
          <div style={{ height: 560, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <ReqChat reqId={id} />
          </div>

        </div>

      {/* AI 追问 · Agent 自主探索代码（独立显眼卡片，富文本渲染） */}
      <div className="card ai-chat-card" style={{ marginTop: 16, borderColor: 'var(--primary)' }}>
        <div className="chat-head" style={{ background: 'var(--primary-weak)' }}>
          <Icon name="clarify" size={20} />
          <b style={{ fontSize: 15 }}>和 AI 追问对话</b>
          <span className="chat-role">Agent</span>
          <span className="muted" style={{ fontSize: 12 }}>AI 会自主查询代码仓库，给你带文件路径与行号的回答</span>
        </div>
        <div className="chat-body" ref={aiBodyRef}>
          {aiTurns.length === 0 ? (
            <div className="chat-empty">
              开始对话后，AI 会自主 grep / read_file 探索代码仓库；你可以问：
              <div style={{ marginTop: 8, color: 'var(--text-2)' }}>· 职级相关的实体类是哪个？<br />· 为什么评估为这个等级？<br />· 现存代码中是否已有可复用的导入导出框架？</div>
            </div>
          ) : (
            <>
              {aiTurns.map((t, i) => {
                const isUser = Boolean(t.q);
                return (
                  <React.Fragment key={i}>
                    {isUser && (
                      <div className="chat-msg mine">
                        <div className="chat-meta">
                          <span className="chat-role">{t.who || '我'}</span>
                          {t.when && <span className="muted">{t.when.slice(5, 16)}</span>}
                        </div>
                        <div className="chat-bubble">{t.q}</div>
                      </div>
                    )}
                    {t.a && (
                      <div className="chat-msg">
                        <div className="chat-meta">
                          <span className="chat-role" style={{ color: 'var(--success-ink)', background: 'var(--success-wash)' }}>AI</span>
                          <span className="muted">已基于真实代码</span>
                        </div>
                        <div className="chat-bubble ai-rich">
                          <RichText html={aiReplyToHtml(t.a)} />
                        </div>
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
              {aiBusy && (
                <div className="chat-msg">
                  <div className="chat-meta">
                    <span className="chat-role" style={{ color: 'var(--success-ink)', background: 'var(--success-wash)' }}>AI</span>
                    <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Icon name="loader" size={16} className="spin" />
                      正在查询代码仓库…
                    </span>
                  </div>
                  <div className="chat-bubble ai-rich" style={{ opacity: 0.7 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-2)', fontSize: 14 }}>
                      <Icon name="loader" size={16} className="spin" />
                      <span>AI 正在自主探索代码，请稍候</span>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <div className="chat-input">
          <input className="input" value={aiQ} placeholder="问 AI：例如「职级实体类叫什么？」"
            onChange={(e) => setAiQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) askAi(); }}
            disabled={aiBusy} aria-label="向 AI 提问" />
          <button className="btn btn-primary" onClick={askAi} disabled={aiBusy || !aiQ.trim()}>
            {aiBusy ? <><Icon name="loader" size={16} className="spin" /> 思考中</> : '发送'}
          </button>
        </div>
      </div>

      {/* 流转记录 · 页面最底部（默认收起，不打扰主内容） */}
      <div className="card card-pad" style={{ marginTop: 24, opacity: 0.85 }}>
        <div className="section-title row" style={{ cursor: 'pointer', justifyContent: 'space-between' }} onClick={() => setShowTimeline((v) => !v)}>
          <span>流转记录（{timeline.length}）</span>
          <span className="muted">{showTimeline ? '▾ 收起' : '▸ 展开'}</span>
        </div>
        {showTimeline && (
          <div className="timeline" style={{ marginTop: 8 }}>
            {[...timeline].reverse().map((t) => (
              <div className="tl-item" key={t.id}>
                <div style={{ fontSize: 13 }}><b>{t.operator}</b> · {actionName(t.action)}</div>
                {t.detail && <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{t.detail}</div>}
                <div className="muted">{t.created_at}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 打回弹窗 */}
      {showReturn && (
        <div className="modal-mask" onClick={() => setShowReturn(false)}>
          <div className="modal card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-h">打回到上一节点</div>
            <div className="modal-b">
              <p style={{ marginBottom: 12, color: 'var(--text-2)', fontSize: 12.5 }}>
                打回后需求将回到上一个人员节点（人工节点），由对应负责人重新处理，不会打给 AI。
              </p>
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

      {/* PRD 编辑 */}
      {editingPrd && (
        <PrdEditor
          title={prd ? '编辑 PRD（保存为新版本）' : '添加 PRD 文档'}
          initial={prd?.content ?? ''}
          onClose={() => setEditingPrd(false)}
          onSave={savePrd}
        />
      )}

      {/* 需求编辑 */}
      {showEdit && <ReqEditModal req={req} onClose={() => setShowEdit(false)} onSaved={() => { setShowEdit(false); load(); }} />}
    </div>
  );
}

/** 研发节点提交表单：分支 + PR + 改动点摘要 + 补充文档多选 */
function RdSubmitForm({ reqId, onSubmitted }: { reqId: number; onSubmitted: () => void }) {
  const { user, toast } = useApp();
  const [sub, setSub] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [branchUrl, setBranchUrl] = useState('');
  const [prUrl, setPrUrl] = useState('');
  const [diffSummary, setDiffSummary] = useState('');
  const [extraDocs, setExtraDocs] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const loadSub = async () => {
    setLoading(true);
    try {
      const r = await api.get(`/api/requirements/${reqId}/rd-submission`);
      setSub(r);
      if (r) {
        setBranchUrl(r.branch_url || '');
        setPrUrl(r.pr_url || '');
        setDiffSummary(r.diff_summary || '');
        setExtraDocs(r.extra_docs || []);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };
  useEffect(() => { loadSub(); }, [reqId]);

  const isReadOnly = sub && !editing && (user?.role !== 'ADMIN');
  // 首次提交仅研发/管理员可填；已有提交后仅提交人/管理员可改，其余角色只读
  const canSubmitFirst = user?.role === 'RD' || user?.role === 'ADMIN';
  const canEdit = sub ? (user?.role === 'ADMIN' || sub.submitted_by === user?.name) : canSubmitFirst;
  // 任何人看都只读（除本人/ADMIN）
  const effectiveReadOnly = !canEdit || (sub && !editing);

  const submit = async () => {
    if (!branchUrl.trim()) return toast('请填写分支名或分支链接', 'error');
    if (!diffSummary.trim()) return toast('请填写改动点摘要（改了哪些文件/类/接口）', 'error');
    setSubmitting(true);
    try {
      await api.post(`/api/requirements/${reqId}/rd-submission`, {
        branch_url: branchUrl.trim(),
        pr_url: prUrl.trim() || null,
        diff_summary: diffSummary.trim(),
        extra_docs: extraDocs,
      });
      toast('开发提交已保存，可流转到下一步', 'ok');
      setEditing(false);
      await loadSub();
      onSubmitted();
    } catch (e: any) { toast(e.message || '提交失败', 'error'); }
    finally { setSubmitting(false); }
  };

  const DOC_OPTIONS = ['修改点说明', '前端联调文档', '数据迁移说明', '接口变更说明', '其他'];

  if (loading) return null;
  // 研发尚未提交时，非研发/管理员不渲染（避免看到可编辑的空表单）
  if (!sub && !canSubmitFirst) return null;
  return (
    <div className="card card-pad" style={{ marginBottom: 16, borderColor: 'var(--primary)' }}>
      <div className="section-title section-head" style={{ marginBottom: 12 }}>
        <Icon name="develop" size={20} />
        <span>开发提交（研发节点必填）</span>
        {sub && <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>已提交于 {sub.submitted_at} · by {sub.submitted_by}</span>}
        {sub && canEdit && !editing && (
          <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setEditing(true)}>
            <Icon name="edit" size={16} /> 重新编辑
          </button>
        )}
      </div>
      {!sub && (
        <div style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 12 }}>
          请填写本次开发的分支、改动点摘要，并勾选补充文档类型。提交后才能流转到测试节点。
        </div>
      )}
      <div className="form-row"><label>分支名 / 分支链接 *</label>
        <input className="input" value={branchUrl} onChange={(e) => setBranchUrl(e.target.value)} disabled={effectiveReadOnly}
          placeholder="如 feature/orSign-active-priority 或完整 git/SSH 链接" /></div>
      <div className="form-row"><label>PR 链接（可选）</label>
        <input className="input" value={prUrl} onChange={(e) => setPrUrl(e.target.value)} disabled={effectiveReadOnly}
          placeholder="如 https://github.com/xxx/pull/123" /></div>
      <div className="form-row"><label>改动点摘要 *（改了哪些文件 / 类 / 接口 / 逻辑）</label>
        <textarea className="input" rows={5} value={diffSummary} onChange={(e) => setDiffSummary(e.target.value)} disabled={effectiveReadOnly}
          placeholder={`例：\n- FenbeiFlowService.orSignCandidates() 新增「在职人员优先」过滤\n- ApprovalCandidateVO 加字段 employeeStatus\n- FlowRuleService 增加兜底分支（全部离职时转管理员）`} /></div>
      <div className="form-row"><label>补充文档（多选）</label>
        <div className="chip-group">
          {DOC_OPTIONS.map((d) => {
            const checked = extraDocs.includes(d);
            return (
              <label key={d} className="chip" style={{ cursor: effectiveReadOnly ? 'default' : 'pointer', opacity: effectiveReadOnly && !checked ? 0.45 : 1, background: checked ? 'var(--primary-weak)' : undefined, borderColor: checked ? 'var(--primary)' : undefined }}>
                <input type="checkbox" checked={checked} disabled={effectiveReadOnly}
                  onChange={(e) => setExtraDocs((arr) => e.target.checked ? [...arr, d] : arr.filter((x) => x !== d))} style={{ marginRight: 4 }} />
                {d}
              </label>
            );
          })}
        </div>
      </div>
      {!effectiveReadOnly && (
        <div className="row" style={{ marginTop: 8, gap: 8 }}>
          <button className="btn btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? <><Icon name="loader" size={16} className="spin" /> 提交中</> : (sub ? '保存修改' : '提交')}
          </button>
          {editing && <button className="btn" onClick={() => { setEditing(false); loadSub(); }}>取消</button>}
        </div>
      )}
    </div>
  );
}
