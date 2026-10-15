import React, { useEffect, useRef, useState } from 'react';
import { api, User, ReqMessage, ROLE_NAME, getReqMessages, postReqMessage, answerChatMessage, answerClarify } from '../api';
import { useApp } from '../App';
import { Icon } from './Icon';
import { RichTextEditor } from './rich/RichTextEditor';
import { RichText } from './RichText';

/**
 * 需求聊天工作室（契约 v2）
 * - GET /api/requirements/:id/messages → 对话气泡（自己的右对齐，他人左对齐）
 * - POST /api/requirements/:id/messages { text } → 参与人发消息（后端以 kind='CHAT' 存储）
 * - 回复：kind='CHAT' → POST /requirements/:id/messages/:msgId/answer（任意参与人）
 *        kind='CLARIFY' → POST /clarifies/:id/answer（提单人 CSM + ADMIN，旧澄清兼容）
 * 样式走 .chat-* 命名空间（components.css），图标走 Icon 收口层，无 emoji。
 */
export function ReqChat({ reqId, readonly = false, focusSignal = 0 }: { reqId: number; readonly?: boolean; focusSignal?: number }) {
  const { user, toast } = useApp();
  const [messages, setMessages] = useState<ReqMessage[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [draft, setDraft] = useState('');
  const [answering, setAnswering] = useState<Record<number, string>>({});
  const [sending, setSending] = useState(false);
  /** 被「去澄清」命中、正在闪烁高亮的澄清消息 id */
  const [flashId, setFlashId] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(0);
  const msgRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const answerRefs = useRef<Record<number, HTMLTextAreaElement | null>>({});
  const messagesRef = useRef<ReqMessage[]>([]);
  const handledSignal = useRef(0);
  const flashTimer = useRef<number | undefined>(undefined);

  const load = async () => {
    try { setMessages(await getReqMessages(reqId)); } catch { /* 消息拉取失败不阻断页面 */ }
  };
  useEffect(() => {
    api.get('/api/users').then(setUsers).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [reqId]);

  // 自动滚底：仅当「有新消息」且「已在底部或最后一条是自己发的」时滚动，
  // 避免 3s 轮询打扰正在上翻阅读/填写回答的用户
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const isNew = messages.length > prevCount.current;
    prevCount.current = messages.length;
    if (!isNew) return;
    const last = messages[messages.length - 1];
    const lastMine = !!last && last.asked_by === user?.name;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (lastMine || atBottom) el.scrollTop = el.scrollHeight;
  }, [messages, user?.name]);

  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // 「去澄清」定位：滚动到第一条未回答的澄清问题，闪烁高亮并聚焦回答框；消息尚未拉到时等下一轮轮询补齐再定位
  useEffect(() => {
    if (!focusSignal || handledSignal.current === focusSignal) return;
    const target = messagesRef.current.find((m) => m.kind === 'CLARIFY' && !m.answer);
    if (!target) return;
    handledSignal.current = focusSignal;
    setFlashId(target.id);
    msgRefs.current[target.id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    answerRefs.current[target.id]?.focus({ preventScroll: true });
    // 轮询会持续更新 messages（effect 重跑），计时器存 ref 而非靠 effect cleanup，避免被提前清掉
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashId(null), 2600);
  }, [focusSignal, messages]);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  const roleOf = (name: string) => {
    const u = users.find((x) => x.name === name);
    return u ? ROLE_NAME[u.role] : '';
  };
  const isMine = (m: ReqMessage) => m.asked_by === user?.name;
  // CLARIFY 澄清仅提单人(CSM)/管理员可答（后端 requireClarifyOwner）；CHAT 消息任意参与人可回复
  const canAnswer = (m: ReqMessage) => {
    if (isMine(m) || m.status === 'ANSWERED') return false;
    if (m.kind === 'CLARIFY') return user?.role === 'CSM' || user?.role === 'ADMIN';
    return m.kind === 'CHAT';
  };
  // 待回答的澄清条数：头部常驻提示，配合「去澄清」把用户视线带到工作室
  const pendingClarifies = messages.filter((m) => m.kind === 'CLARIFY' && !m.answer).length;

  const send = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    try {
      await postReqMessage(reqId, draft);
      setDraft('');
      await load();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setSending(false); }
  };

  const submitAnswer = async (m: ReqMessage) => {
    const ans = (answering[m.id] || '').trim();
    if (!ans) return toast('请填写回答');
    try {
      if (m.kind === 'CLARIFY') await answerClarify(m.id, ans);
      else await answerChatMessage(reqId, m.id, ans);
      setAnswering((a) => ({ ...a, [m.id]: '' }));
      await load();
      toast('回答已提交');
    } catch (e: any) { toast(e.message, 'error'); }
  };

  return (
    <div className="card chat">
      <div className="chat-head">
        <Icon name="clarify" size={20} />
        <b>需求聊天工作室</b>
        {pendingClarifies > 0 && <span className="chat-pending">待回答 {pendingClarifies} 条澄清</span>}
        <span className="muted">· 与 AI / 团队成员沟通需求细节；AI 的澄清问题请在其下方输入框逐条回答，全部回答后会自动重新评估</span>
      </div>
      <div className="chat-body" ref={bodyRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">暂无消息，发一条消息开始沟通</div>
        ) : messages.map((m) => {
          const role = roleOf(m.asked_by);
          return (
            <div
              key={m.id}
              ref={(el) => { msgRefs.current[m.id] = el; }}
              className={`chat-msg${isMine(m) ? ' mine' : ''}${flashId === m.id ? ' clarify-flash' : ''}`}
            >
              <div className="chat-meta">
                <b>{m.asked_by}</b>
                {role && <span className="chat-role">{role}</span>}
                {m.kind === 'CLARIFY' && <span className="chat-kind">澄清</span>}
                <span className="muted">{m.created_at}</span>
              </div>
              <div className="chat-bubble"><RichText html={m.question} /></div>
              {m.answer && (
                <div className="chat-answer">
                  <span className="muted">回答：</span><RichText html={m.answer} />
                </div>
              )}
              {canAnswer(m) && (
                <div className="chat-answer-box">
                  <textarea
                    ref={(el) => { answerRefs.current[m.id] = el; }}
                    className="input"
                    rows={2}
                    value={answering[m.id] || ''}
                    onChange={(e) => setAnswering((a) => ({ ...a, [m.id]: e.target.value }))}
                    placeholder={m.kind === 'CLARIFY' ? '在此逐条补充说明，提交后 AI 会自动重新评估' : '输入回复，点击提交发送'}
                    aria-label="回复消息"
                  />
                  <button className="btn btn-sm btn-primary" onClick={() => submitAnswer(m)}>提交回答</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!readonly && (
      <div className="chat-input">
        <input
          className="input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          placeholder="输入消息，Enter 发送"
          disabled={sending}
          aria-label="发送消息"
          style={{ flex: 1, minWidth: 0 }}
        />
      </div>
      )}
    </div>
  );
}
