import React, { useEffect, useRef, useState } from 'react';
import { api, User, ReqMessage, ROLE_NAME, getReqMessages, postReqMessage, answerChatMessage, answerClarify } from '../api';
import { useApp } from '../App';
import { Icon } from './Icon';
import { RichTextEditor } from './rich/RichTextEditor';
import { RichText } from './RichText';
import { isEmptyHtml } from '../lib/sanitize';

/**
 * 需求聊天工作室（契约 v2）
 * - GET /api/requirements/:id/messages → 对话气泡（自己的右对齐，他人左对齐）
 * - POST /api/requirements/:id/messages { text } → 参与人发消息（后端以 kind='CHAT' 存储）
 * - 回复：kind='CHAT' → POST /requirements/:id/messages/:msgId/answer（任意参与人）
 *        kind='CLARIFY' → POST /clarifies/:id/answer（提单人 CSM + ADMIN，旧澄清兼容）
 * 样式走 .chat-* 命名空间（components.css），图标走 Icon 收口层，无 emoji。
 */
export function ReqChat({ reqId, readonly = false }: { reqId: number; readonly?: boolean }) {
  const { user, toast } = useApp();
  const [messages, setMessages] = useState<ReqMessage[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [draft, setDraft] = useState('');
  const [answering, setAnswering] = useState<Record<number, string>>({});
  const [sending, setSending] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(0);

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
    const ans = answering[m.id] || '';
    if (isEmptyHtml(ans)) return toast('请填写回答');
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
        <span className="muted">· 与 AI / 团队成员沟通需求细节，AI 的澄清问题也会出现在这里</span>
      </div>
      <div className="chat-body" ref={bodyRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">暂无消息，发一条消息开始沟通</div>
        ) : messages.map((m) => {
          const role = roleOf(m.asked_by);
          return (
            <div key={m.id} className={`chat-msg${isMine(m) ? ' mine' : ''}`}>
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
