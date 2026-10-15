import React, { useEffect, useRef, useState } from 'react';
import { api, Requirement, Artifact, TimelineItem, STATUS_NAME, AI_ACTIONS, assignRequirement } from '../api';
import { useApp } from '../App';
import { Icon } from '../components/Icon';
import { actionName, EvaluationView, NoteView, TestCaseView } from './ReqViews';
import { AiWarnBar } from '../components/AiWarnBar';
import { parseArtifactMeta } from '../lib/artifactMeta';
import { renderMarkdown } from '../lib/markdown';
import { PrdEditor } from '../components/PrdEditor';
import { PrdAiModal } from '../components/PrdAiModal';
import { ReqEditModal } from '../components/ReqEditModal';
import { AiRunningBar } from '../components/AiRunningBar';
import { ReqChat } from '../components/ReqChat';
import { ReqAssign } from '../components/ReqAssign';
import { RichText } from '../components/RichText';
import { isHtmlContent, sanitizeHtml } from '../lib/sanitize';
import { aiReplyToHtml } from '../lib/aiReply';
import { readFileAsDataUrl, resolveUploadUrl } from '../lib/uploadImage';
import { JiraCreateModal } from '../components/JiraCreateModal';
import { JiraSettingsModal } from '../components/JiraSettingsModal';

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

function isJiraUrl(value: string | null | undefined): boolean {
  return /^https?:\/\//i.test(String(value || ''));
}

/**
 * 研发提示词按角色拆分展示：前端优先看前端章节、后端优先后端章节，各隐藏对方章节；
 * ADMIN/PO 等看全量。按二级标题切分，保留需求汇总/是否需要前端开发/注意点等公共章节。
 */
function filterDevPrompt(md: string, role?: string): string {
  if (role !== 'FE' && role !== 'RD') return md;
  const parts = md.split(/\n(?=##\s)/);
  const head = parts[0] || '';
  const kept = parts.slice(1).filter((s) => {
    const isFront = /##[^\n]*前端改动点/.test(s);
    const isBack = /##[^\n]*后端改动点/.test(s);
    if (isFront && role !== 'FE') return false;
    if (isBack && role !== 'RD') return false;
    return true;
  });
  return [head.trim(), ...kept.map((s) => s.trim())].filter(Boolean).join('\n\n');
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
  /** AI 生成的 PRD 草稿：生成后预填进 PrdEditor，产品检查修改后保存为新版本（保存/关闭即清空） */
  const [prdDraft, setPrdDraft] = useState<string | null>(null);
  const [prdAiOpen, setPrdAiOpen] = useState(false);
  const [editingReport, setEditingReport] = useState(false);
  const [creatingJira, setCreatingJira] = useState(false);
  const [jiraSettings, setJiraSettings] = useState(false);
  /** 需求信息区「补充/修改 Jira 单号」内联编辑（管理员或需求产品负责人可用，任意节点可补，流转结束除外） */
  const [jiraEditing, setJiraEditing] = useState(false);
  const [jiraDraft, setJiraDraft] = useState('');
  const [jiraSaving, setJiraSaving] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  /** 「去澄清」：滚动定位到聊天工作室并短暂高亮，同时让 ReqChat 聚焦第一条未答澄清（直接引导，不弹窗） */
  const [clarifyFocus, setClarifyFocus] = useState(0);
  const [chatFlash, setChatFlash] = useState(false);
  const chatFlashTimer = useRef<number | undefined>(undefined);
  const goClarify = () => {
    setClarifyFocus((n) => n + 1);
    setChatFlash(true);
    window.clearTimeout(chatFlashTimer.current);
    chatFlashTimer.current = window.setTimeout(() => setChatFlash(false), 2600);
    document.getElementById('req-chat-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  useEffect(() => () => window.clearTimeout(chatFlashTimer.current), []);
  /** 流转记录默认收起（量大时占地方），点开折叠 */
  const [showTimeline, setShowTimeline] = useState(false);
  /** 和 AI 继续对话：就着当前 tab 的产物追问（历史落库 req_ai_chats，可回看） */
  const [aiOpen, setAiOpen] = useState(false);
  const [aiQ, setAiQ] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiTurns, setAiTurns] = useState<{ q: string; a: string; who: string; when?: string; images?: string[] }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  /** AI 追问：代码查询范围（勾选前端/服务端；两个都不勾 = 全部仓库）与随消息上传的截图 */
  const [aiScopes, setAiScopes] = useState<string[]>(['frontend', 'backend']);
  const [aiImages, setAiImages] = useState<{ raw: string; url: string }[]>([]);
  const [aiUploading, setAiUploading] = useState(false);
  const aiFileRef = useRef<HTMLInputElement>(null);
  const aiBodyRef = useRef<HTMLDivElement>(null);
  // 新消息追加后自动滚到底
  useEffect(() => {
    const el = aiBodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [aiTurns.length, aiBusy]);

  const loadAiChats = async () => {
    try {
      const rows = await api.get(`/api/requirements/${id}/ai-chats`);
      setAiTurns((rows || []).map((x: any) => {
        let images: string[] = [];
        try { images = Array.isArray(x.image_urls) ? x.image_urls : JSON.parse(x.image_urls || '[]'); } catch { /* 存量记录无图片 */ }
        return { q: x.question, a: x.reply, who: x.created_by, when: x.created_at, images };
      }));
    } catch { /* 历史拉取失败不阻断 */ }
  };
  useEffect(() => { loadAiChats(); }, [id]);

  const toggleAiScope = (s: string) => {
    setAiScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  /** 上传追问截图：上传成功后暂存，发送时随消息一起交给 AI 做视觉理解 */
  const uploadAiImage = async (file: File) => {
    if (!file.type.startsWith('image/')) { toast('请上传图片文件', 'error'); return; }
    setAiUploading(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const res: any = await api.post('/api/uploads', { data: dataUrl });
      const raw = res?.url || res?.data?.url;
      if (!raw) throw new Error('图片上传失败');
      setAiImages((prev) => [...prev, { raw, url: resolveUploadUrl(raw) }]);
    } catch (e: any) { toast(e.message || '图片上传失败', 'error'); }
    finally { setAiUploading(false); }
  };

  const askAi = async () => {
    if ((!aiQ.trim() && aiImages.length === 0) || aiBusy) return;
    const question = aiQ.trim();
    const imgs = aiImages;
    setAiQ('');
    setAiImages([]);
    setAiTurns((t) => [...t, { q: question, a: '', who: user?.name || '我', when: new Date().toISOString(), images: imgs.map((i) => i.raw) }]);
    setAiBusy(true);
    try {
      // AI 走 traecli 原生 Agent：把勾选的仓库挂进工作区自主检索，图片交给模型视觉理解
      const r = await api.post(`/api/requirements/${id}/ai-chat`, {
        message: question || '（请看截图并分析）',
        artifact_kind: tab,
        scopes: aiScopes,
        images: imgs.map((i) => i.raw),
      });
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
  // Jira 单号补充/修改：管理员或需求产品负责人，任意节点可改（流转结束除外），不受 PO 节点限制
  const canEditJira = (user?.role === 'ADMIN' || req.po_id === user?.id)
    && req.status !== 'DONE' && req.status !== 'CANCELLED';
  // PRD 的 AI 生成/修改：该需求的产品负责人或管理员（与后端 prd-generate 接口权限一致）
  const isPrdOwner = (user?.role === 'PO' && req.po_id === user?.id) || user?.role === 'ADMIN';
  // QA 人工节点已完成 → 测试产物区提示「等待目标版本即可上线」
  const qaDone = req.status === 'DONE' || nodes.some((n) => n.role === 'QA' && n.seq < req.current_seq);
  // 测试报告：需求测试负责人（QA）或管理员可写；已关闭的需求不再改，避免上线后报告被改写
  const canEditReport = (user?.role === 'ADMIN' || (user?.role === 'QA' && req.qa_id === user?.id))
    && req.status !== 'CANCELLED';
  // 用例执行结果由指定测试负责人维护；终态冻结，与后端 requireTestCaseOwner 保持一致。
  const canEditTestCases = (user?.role === 'ADMIN' || (user?.role === 'QA' && req.qa_id === user?.id))
    && req.status !== 'DONE' && req.status !== 'CANCELLED';

  const saveJiraUrl = async () => {
    const value = jiraDraft.trim();
    if (value && !isJiraUrl(value) && !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(value)) {
      toast('请填写完整链接或单号（如 PINGTAI-11952）'); return;
    }
    setJiraSaving(true);
    try {
      await assignRequirement(req.id, { jira_url: value || null });
      toast(value ? 'Jira 单号已保存' : 'Jira 单号已清空');
      setJiraEditing(false);
      load();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setJiraSaving(false); }
  };

  const savePrd = async (content: string) => {
    try { await api.post(`/api/requirements/${id}/artifacts`, { kind: 'PRD', content }); setEditingPrd(false); toast('PRD 已保存'); load(); }
    catch (e: any) { toast(e.message); }
  };

  const saveReport = async (content: string) => {
    try { await api.post(`/api/requirements/${id}/artifacts`, { kind: 'TEST_REPORT', content }); setEditingReport(false); toast('测试报告已保存'); load(); }
    catch (e: any) { toast(e.message); }
  };

  const copyPrd = async () => {
    if (!prd?.content) return;
    const holder = document.createElement('div');
    holder.innerHTML = prd.content;
    const text = isHtmlContent(prd.content) ? holder.innerText : prd.content;
    try {
      // 同时写入 HTML 与纯文本，飞书编辑器可保留标题/列表格式；不支持 ClipboardItem 时降级纯文本。
      if (isHtmlContent(prd.content) && (window as any).ClipboardItem && navigator.clipboard?.write) {
        const item = new (window as any).ClipboardItem({ 'text/html': new Blob([prd.content], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) });
        await navigator.clipboard.write([item]);
      } else await navigator.clipboard.writeText(text);
      toast('PRD 已复制，可直接粘贴到飞书');
    }
    catch { toast('复制失败，请在预览内容中手动复制', 'error'); }
  };

  /** 复制当前角色可见的研发提示词，保持与页面展示内容一致。 */
  const copyDevPrompt = async () => {
    const artifact = latest('DEV_PROMPT');
    if (!artifact?.content) return;
    let text = artifact.content;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.text === 'string') text = parsed.text;
    } catch { /* 历史 Markdown 直接使用原文 */ }
    try {
      await navigator.clipboard.writeText(filterDevPrompt(String(text), user?.role));
      toast('研发提示词已复制');
    } catch { toast('复制失败，请在提示词内容中手动复制', 'error'); }
  };

  const latest = (kind: string) => artifacts.find((a) => a.kind === kind);
  const evaluationArtifact = latest('EVALUATION');
  const renderContent = (a?: Artifact) => {
    if (!a) return <div className="empty">{tab === 'TEST_REPORT' && canEditReport ? '暂无测试报告，点上方「填写测试报告」开始编写' : '暂无内容'}</div>;
    const meta = parseArtifactMeta(a.meta);
    const warn = <AiWarnBar meta={meta} />;
    // PRD 产物：新版 HTML 富文本 → sanitizeHtml 白名单渲染；存量 Markdown/纯文本 → renderMarkdown（元素树天然免 XSS）
    if (a.kind === 'PRD') {
      const prdHtml = isHtmlContent(a.content) ? sanitizeHtml(a.content) : null;
      return <>{warn}<div className="md md-render">{prdHtml ? <div dangerouslySetInnerHTML={{ __html: prdHtml }} /> : renderMarkdown(a.content)}</div></>;
    }
    // 测试报告产物：与 PRD 同构的富文本（新版 HTML → 白名单渲染；存量 Markdown → renderMarkdown）
    if (a.kind === 'TEST_REPORT') {
      const html = isHtmlContent(a.content) ? sanitizeHtml(a.content) : null;
      return <>{warn}<div className="md md-render">{html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : renderMarkdown(a.content)}</div></>;
    }
    // DEV_PROMPT 产物：Markdown 文本（traecli 直接给 Markdown，不再是 JSON 结构）→ renderMarkdown 富文本渲染
    if (a.kind === 'DEV_PROMPT') {
      // 兼容历史 JSON 兜底产物 {text,_source:'fallback'}：剥离包装
      let text = a.content;
      try { const o = JSON.parse(text); if (o && typeof o.text === 'string') text = o.text; } catch { /* 保持原文（已经是 markdown） */ }
      const mine = user?.role === 'FE' ? '前端' : user?.role === 'RD' ? '后端' : null;
      return <>{warn}{mine && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          已按「{mine}」视角展示相关章节；如需完整提示词请联系产品/管理员查看。
        </div>
      )}<div className="md md-render">{renderMarkdown(filterDevPrompt(String(text), user?.role))}</div></>;
    }
    try {
      const obj = JSON.parse(a.content);
      if (a.kind === 'EVALUATION') return <>{warn}<EvaluationView data={obj} meta={meta} /></>;
      if (a.kind === 'TEST_CASE' && Array.isArray(obj)) return <>{warn}<TestCaseView cases={obj} reqId={id} artifact={a} canEdit={canEditTestCases} onSaved={load} /></>;
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
  const testReport = latest('TEST_REPORT');
  const testCase = latest('TEST_CASE');
  // QA 节点：用例执行结果必须全部填写才允许流转（后端 engine.confirm 同样硬校验兜底）
  const testCaseList = (() => {
    try { const o = JSON.parse(testCase?.content || '[]'); return Array.isArray(o) ? o : []; } catch { return []; }
  })();
  const pendingCases = testCaseList.filter((c: any) => !String(c?.result || '').trim()).length;
  const isQaNode = curNode?.node_type === 'HUMAN' && curNode?.role === 'QA';
  // 产品评审人工节点：无 PRD 产物时前端先拦确认流转（后端 400 为硬兜底）
  const needPrd = user?.role === 'PO' && curNode?.node_type === 'HUMAN' && curNode?.role === 'PO' && !prd;
  const onConfirm = () => {
    if (needPrd) { toast('请补充 PRD 文档后确认流转'); return; }
    // PO 节点 confirm 前端校验：必须先指派研发（后端/前端任一）+ QA（后端也会校验兜底，但前端拦截可滚动到指派区）
    if (isPoNode && (!req.rd_id && !req.fe_id || !req.qa_id)) {
      toast('请先指派研发（后端/前端任一）和测试负责人后再提交');
      // 滚动到指派区（ReqAssign 就在需求描述下方）
      const el = document.getElementById('req-assign-anchor');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    // 产品节点必须关联 Jira 单号（一键生成或手动填写并保存指派后回写）
    if (isPoNode && !req.jira_url) {
      toast('请先填写或一键生成 Jira 单号并保存后再提交');
      const el = document.getElementById('req-assign-anchor');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    // QA 节点：用例没执行完不允许进入下一步（避免「一条都没点」直接上线）
    if (isQaNode) {
      if (!testCaseList.length) {
        toast(testCase ? '当前用例是旧版纯文本，无法记录结果，请重新生成测试用例' : '请先生成测试用例后再流转');
        setTab('TEST_CASE'); return;
      }
      if (pendingCases > 0) { toast(`还有 ${pendingCases} 条测试用例未执行，请先填写结果`); setTab('TEST_CASE'); return; }
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
        {user?.role === 'PO' && <button className="btn btn-sm btn-ghost" onClick={() => setJiraSettings(true)} title="配置当前产品账号的 Jira"><Icon name="settings" size={16} /> Jira 设置</button>}
      </div>

      {/* AI 分析中：整页顶部进度提示（细条 + spinner，让用户立即感知系统在干活） */}
      {req.status === 'AI_RUNNING' && <div className="ai-progress-bar" role="status" aria-live="polite"><Icon name="loader" size={16} className="spin" /><span>AI 正在分析中，预计 5-15 秒…</span></div>}

      {/* 待澄清：AI 挂了问号等提单人补充；引导到右侧聊天工作室逐条回答 */}
      {req.status === 'CLARIFYING' && (
        <div className="card card-pad row" style={{ marginBottom: 16, borderColor: 'var(--warn, #d97706)', background: 'color-mix(in srgb, var(--warn, #d97706) 6%, var(--panel))' }}>
          <div className="row" style={{ gap: 8, marginRight: 'auto' }}>
            <Icon name="clarify" size={20} />
            <b>{req.csm_id === user?.id ? 'AI 需要你补充信息才能继续评估' : '等待提单人补充信息'}</b>
            <span className="muted">
              {req.csm_id === user?.id
                ? '请在右侧「需求聊天工作室」中，逐条回答带「澄清」标记的问题；全部回答后系统会自动重新评估，无需手动重新提交。'
                : '提单人回答全部澄清问题后，系统会自动重新评估。'}
            </span>
          </div>
          {(req.csm_id === user?.id || user?.role === 'ADMIN') && (
            <button className="btn btn-primary" onClick={goClarify}>
              <Icon name="clarify" size={16} /> 去聊天工作室澄清
            </button>
          )}
        </div>
      )}

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
              <div><span className="muted">后端/前端/测试：</span>{req.rd_name || '待指派'} / {req.fe_name || '待指派'} / {req.qa_name || '待指派'}</div>
              <div><span className="muted">创建时间：</span>{(req.created_at || '').replace('T', ' ').slice(0, 16) || '—'}</div>
              <div><span className="muted">当前等级：</span>{req.level || '未定级'}</div>
              <div>
                <span className="muted">Jira：</span>
                {jiraEditing ? (
                  <span className="row" style={{ display: 'inline-flex', gap: 6, verticalAlign: 'middle' }}>
                    <input className="input" style={{ width: 240 }} value={jiraDraft} autoFocus
                      onChange={(e) => setJiraDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveJiraUrl(); if (e.key === 'Escape') setJiraEditing(false); }}
                      placeholder="如 PINGTAI-11952 或完整链接" />
                    <button className="btn btn-sm btn-primary" onClick={saveJiraUrl} disabled={jiraSaving}>{jiraSaving ? '保存中…' : '保存'}</button>
                    <button className="btn btn-sm" onClick={() => setJiraEditing(false)} disabled={jiraSaving}>取消</button>
                  </span>
                ) : (<>
                  {req.jira_url ? (isJiraUrl(req.jira_url) ? (
                    <a href={req.jira_url} target="_blank" rel="noopener noreferrer" className="jira-link"
                      title={req.jira_url}>
                      <Icon name="link" size={16} /> {jiraLabel(req.jira_url)}
                    </a>
                  ) : <span className="tag tag-grey" title="Jira 单号">{req.jira_url}</span>) : '—'}
                  {canEditJira && <button className="btn btn-sm btn-ghost" style={{ marginLeft: 6 }}
                    onClick={() => { setJiraDraft(req.jira_url || ''); setJiraEditing(true); }}>
                    <Icon name="edit" size={16} /> {req.jira_url ? '修改' : '补充'}
                  </button>}
                </>)}
              </div>
            </div>
            {req.modules && req.modules.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <span className="muted" style={{ fontSize: 12 }}>关联业务模块：</span>
                <div className="chip-group" style={{ marginTop: 6 }}>
                  {/* v0.7：modules 项是 (业务模块, [code_module]) 的笛卡尔积；按 business_module_id 聚合展示 */}
                  {(() => {
                    const byBiz = new Map<number, { name: string; repos: any[] }>();
                    for (const m of req.modules) {
                      if (!byBiz.has(m.business_module_id)) byBiz.set(m.business_module_id, { name: `${m.business_name}（${m.business_type === 'FRONTEND' ? '前端' : '后端'}）`, repos: [] });
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
            {canAssign && <div id="req-assign-anchor"><ReqAssign req={req} onSaved={load}
              onGenerateJira={isPoNode && canEditJira && !req.jira_url ? () => setCreatingJira(true) : undefined} /></div>}
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
              {tab === 'PRD' && isPrdOwner && <div className="row" style={{ marginBottom: 12, gap: 8 }}>
                <button className="btn btn-sm" onClick={() => setPrdAiOpen(true)} title="填写产品意图（可附截图），AI 生成/修改 PRD，确认后保存为新版本">
                  <Icon name="ai" size={16} /> {prd ? 'AI 修改 PRD' : 'AI 生成 PRD'}
                </button>
                {prd && <button className="btn btn-sm" onClick={copyPrd}><Icon name="copy" size={16} /> 复制 PRD</button>}
                {!req.jira_url && prd && <button className="btn btn-sm btn-primary" onClick={() => setCreatingJira(true)}><Icon name="link" size={16} /> 一键生成 Jira</button>}
              </div>}
              {tab === 'DEV_PROMPT' && latest('DEV_PROMPT') && <div className="row" style={{ marginBottom: 12, gap: 8 }}>
                <button className="btn btn-sm" onClick={copyDevPrompt}><Icon name="copy" size={15} /> 复制研发提示词</button>
              </div>}
              {tab === 'TEST_REPORT' && (canEditReport || testReport) && <div className="row" style={{ marginBottom: 12, gap: 8 }}>
                {canEditReport && <button className="btn btn-sm btn-primary" onClick={() => setEditingReport(true)}>
                  <Icon name="edit" size={16} /> {testReport ? '编辑测试报告' : '填写测试报告'}
                </button>}
                {!canEditReport && <span className="muted" style={{ fontSize: 12 }}>仅需求测试负责人（{req.qa_id ? 'QA' : '待指派'}）或管理员可编辑</span>}
              </div>}
              {renderContent(latest(tab))}
            </div>
          </div>          </div>

          {/* 右侧栏：需求聊天工作室 sticky · 贯穿详情 */}
          <div id="req-chat-panel" className={chatFlash ? 'chat-panel-focus' : undefined} style={{ height: 560, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <ReqChat reqId={id} focusSignal={clarifyFocus} />
          </div>

        </div>

      {/* AI 追问 · Agent 自主探索代码（独立显眼卡片，富文本渲染） */}
      <div className="card ai-chat-card" style={{ marginTop: 16, borderColor: 'var(--primary)' }}>
        <div className="chat-head" style={{ background: 'var(--primary-weak)' }}>
          <Icon name="clarify" size={20} />
          <b style={{ fontSize: 15 }}>和 AI 追问对话</b>
          <span className="chat-role">Agent</span>
          <span className="muted" style={{ fontSize: 12 }}>首轮自动带入 AI 评估报告；后续追问与回答会保存为完整会话</span>
        </div>
        <div className="chat-body" ref={aiBodyRef}>
          {evaluationArtifact && (
            <div className="chat-msg">
              <div className="chat-meta">
                <span className="chat-role" style={{ color: 'var(--primary)', background: 'var(--primary-weak)' }}>首轮上下文</span>
                <span className="muted">AI 评估报告已自动带入本次及后续追问</span>
              </div>
              <div className="chat-bubble ai-rich">
                你可以直接追问上方评估中的风险、判断依据或影响范围；AI 会结合评估报告、已保存的追问记录和代码仓库继续分析。
              </div>
            </div>
          )}
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
                        {t.q && <div className="chat-bubble">{t.q}</div>}
                        {t.images && t.images.length > 0 && (
                          <div className="ai-chat-imgs">
                            {t.images.map((u, k) => (
                              <img key={k} className="ai-chat-img" src={resolveUploadUrl(u)} alt="提问截图" />
                            ))}
                          </div>
                        )}
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
        <div className="ai-chat-tools">
          <div className="ai-scope">
            <span className="muted" style={{ fontSize: 12 }}>查询范围</span>
            <label className="ai-scope-item">
              <input type="checkbox" checked={aiScopes.includes('frontend')} onChange={() => toggleAiScope('frontend')} disabled={aiBusy} />
              前端代码
            </label>
            <label className="ai-scope-item">
              <input type="checkbox" checked={aiScopes.includes('backend')} onChange={() => toggleAiScope('backend')} disabled={aiBusy} />
              服务端代码
            </label>
            <span className="muted" style={{ fontSize: 11 }}>
              {aiScopes.length === 0 || aiScopes.length === 2 ? '（全部仓库）' : '（仅勾选范围）'}
            </span>
          </div>
          {aiImages.length > 0 && (
            <div className="ai-chat-imgs">
              {aiImages.map((img, i) => (
                <span key={i} className="ai-chat-img-wrap">
                  <img className="ai-chat-img" src={img.url} alt="待发送截图" />
                  <button className="ai-chat-img-del" title="移除" onClick={() => setAiImages((p) => p.filter((_, k) => k !== i))} disabled={aiBusy}>×</button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="chat-input">
          <input ref={aiFileRef} type="file" accept="image/*" hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAiImage(f); e.target.value = ''; }} />
          <button className="btn btn-ghost" title="上传截图给 AI 看" onClick={() => aiFileRef.current?.click()} disabled={aiBusy || aiUploading}>
            <Icon name="image" size={16} />{aiUploading ? '上传中…' : '图片'}
          </button>
          <input className="input" value={aiQ} placeholder="问 AI：可粘贴截图，或问「自定义角色加人在前端哪里改、后端接口是哪个」"
            onChange={(e) => setAiQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) askAi(); }}
            onPaste={(e) => {
              const f = Array.from(e.clipboardData?.files || []).find((x) => x.type.startsWith('image/'));
              if (f) { e.preventDefault(); uploadAiImage(f); }
            }}
            disabled={aiBusy} aria-label="向 AI 提问" />
          <button className="btn btn-primary" onClick={askAi} disabled={aiBusy || (!aiQ.trim() && aiImages.length === 0)}>
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

      {/* PRD 编辑（AI 生成后带 prdDraft 预填，产品检查修改再保存为新版本） */}
      {editingPrd && (
        <PrdEditor
          title={prdDraft ? 'AI 生成的 PRD（可修改，保存为新版本）' : prd ? '编辑 PRD（保存为新版本）' : '添加 PRD 文档'}
          initial={prdDraft ?? prd?.content ?? ''}
          onClose={() => { setEditingPrd(false); setPrdDraft(null); }}
          onSave={(content) => { setPrdDraft(null); savePrd(content); }}
        />
      )}

      {/* AI 按产品意图生成 PRD（意图 + 截图 → 后端生成正文 → 预填编辑器） */}
      {prdAiOpen && (
        <PrdAiModal
          reqId={id}
          hasPrd={!!prd}
          onClose={() => setPrdAiOpen(false)}
          onGenerated={(content) => { setPrdAiOpen(false); setPrdDraft(content); setEditingPrd(true); }}
        />
      )}

      {/* 测试报告编辑 */}
      {editingReport && (
        <PrdEditor
          title={testReport ? '编辑测试报告（保存为新版本）' : '填写测试报告'}
          initial={testReport?.content ?? ''}
          placeholder={'建议包含：测试范围 · 用例执行结果(通过/失败数) · 遗留问题与风险 · 上线结论'}
          onClose={() => setEditingReport(false)}
          onSave={saveReport}
        />
      )}
      {creatingJira && <JiraCreateModal req={req} onClose={() => setCreatingJira(false)} onCreated={(url) => {
        // 创建接口已回写数据库，直接用返回链接同步两处回显，避免依赖下一次详情轮询。
        setReq((prev) => prev ? { ...prev, jira_url: url } : prev);
        setCreatingJira(false); load(); toast(`Jira 链接已回写：${url}`);
      }} />}
      {jiraSettings && <JiraSettingsModal onClose={() => setJiraSettings(false)} />}

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
  const canSubmitFirst = user?.role === 'RD' || user?.role === 'FE' || user?.role === 'ADMIN';
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
