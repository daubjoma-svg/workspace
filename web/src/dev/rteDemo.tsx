/* RTE 真实浏览器验证演示页（不依赖后端登录/数据，仅挂载 RichTextEditor 组件）
 * 入口：rte-demo.html（vite dev 多入口），playwright 脚本 web/scripts/rte-playwright.mjs 驱动。
 * 覆盖：PRD 富文本编辑（保存→回显）、需求描述（存量纯文本加载）、聊天（compact + 气泡渲染）、
 *       XSS 渲染安全（RichText 出口）。
 */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../design-system/design-tokens.css';
import '../styles.css';
import { RichTextEditor } from '../components/rich/RichTextEditor';
import { RichText } from '../components/RichText';

const STORAGE_KEY = 'rte-demo-prd';

/** 聊天气泡安全渲染：HTML → RichText（sanitize），纯文本 → 文本节点 */
function Bubble({ text }: { text: string }) {
  return <div className="chat-bubble demo-bubble"><RichText html={text} /></div>;
}

function App() {
  const [prd, setPrd] = useState<string>(() =>
    localStorage.getItem(STORAGE_KEY) ||
    '<h2>PRD 标题</h2><p>演示<strong>粗体</strong>、<em>斜体</em>与<a href="https://example.com">链接</a>。</p>',
  );
  const [saved, setSaved] = useState<string | null>(null);
  const [desc, setDesc] = useState('存量纯文本描述（无 HTML 标签）：客户希望在移动端完成日报提交与审批。');
  const [chatDraft, setChatDraft] = useState('');
  const [messages, setMessages] = useState<{ id: number; text: string }[]>([
    { id: 1, text: '这是存量纯文本消息，没有 HTML 标签。' },
    { id: 2, text: '<p>这是<strong>富文本</strong>消息，含<em>斜体</em>。</p>' },
  ]);

  const savePrd = () => {
    localStorage.setItem(STORAGE_KEY, prd);
    setSaved(prd);
  };
  const resetPrd = () => {
    localStorage.removeItem(STORAGE_KEY);
    setPrd('<h2>PRD 标题</h2><p>演示<strong>粗体</strong>、<em>斜体</em>与<a href="https://example.com">链接</a>。</p>');
  };
  const sendChat = () => {
    if (!chatDraft.trim()) return;
    setMessages((m) => [...m, { id: Date.now(), text: chatDraft }]);
    setChatDraft('');
  };

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', padding: '28px 20px 80px', fontFamily: 'var(--font-body)' }}>
      <h1 style={{ fontSize: 20, marginBottom: 6 }}>RTE 富文本编辑器验证台</h1>
      <p className="muted" style={{ fontSize: 13, marginBottom: 24 }}>用于真实浏览器验证：粗体 / 粘贴图片 / / 快捷命令 / 链接 / 保存回显 / 聊天气泡</p>

      {/* ① PRD 编辑（完整工具栏） */}
      <section className="card card-pad" style={{ marginBottom: 20 }}>
        <div className="section-title" style={{ marginBottom: 12 }}>① PRD 编辑（完整工具栏 · 保存→刷新回显）</div>
        <RichTextEditor value={prd} onChange={setPrd} placeholder="输入 PRD 内容…（行首 / 唤起快捷命令）" minRows={6} />
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" onClick={savePrd}>保存（写入 localStorage）</button>
          <button className="btn" onClick={resetPrd}>重置示例</button>
          <span className="muted" style={{ fontSize: 12 }}>{saved ? '已保存 ✓ 刷新页面验证回显' : ''}</span>
        </div>
        <div className="section-title" style={{ margin: '16px 0 8px' }}>PRD 渲染回显（RichText · sanitize 出口）</div>
        <div className="md md-render" style={{ border: '1px dashed var(--border)', padding: 12, borderRadius: 8 }}>
          <RichText html={prd} />
        </div>
      </section>

      {/* ② 需求描述（存量纯文本加载） */}
      <section className="card card-pad" style={{ marginBottom: 20 }}>
        <div className="section-title" style={{ marginBottom: 12 }}>② 需求描述（存量纯文本 → 富文本）</div>
        <RichTextEditor value={desc} onChange={setDesc} placeholder="业务场景 / 期望效果 / 边界条件…" minRows={3} />
        <div className="section-title" style={{ margin: '16px 0 8px' }}>描述渲染（纯文本→文本节点；HTML→sanitize）</div>
        <div className="md" style={{ border: '1px dashed var(--border)', padding: 12, borderRadius: 8 }}>
          <RichText html={desc} />
        </div>
      </section>

      {/* ③ 聊天（compact mini 版） */}
      <section className="card card-pad" style={{ marginBottom: 20 }}>
        <div className="section-title" style={{ marginBottom: 12 }}>③ 聊天（compact · Enter 发送 · 气泡富文本）</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
          {messages.map((m) => <Bubble key={m.id} text={m.text} />)}
        </div>
        <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}><RichTextEditor compact value={chatDraft} onChange={setChatDraft} onEnter={sendChat} placeholder="输入消息，Enter 发送…" minRows={1} /></div>
          <button className="btn btn-primary" onClick={sendChat} disabled={!chatDraft.trim()}>发送</button>
        </div>
      </section>

      {/* ④ XSS 渲染安全 */}
      <section className="card card-pad">
        <div className="section-title" style={{ marginBottom: 12 }}>④ XSS 渲染安全（RichText 出口必须剥离）</div>
        <Bubble text={'<img src=x onerror="window.__xss=1"><script>window.__xss=2<\/script><a href="javascript:window.__xss=3">恶意链接</a><strong>安全粗体</strong>'} />
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>预期：img 无 onerror、script 不执行、javascript: 链接被剥，仅保留安全内容。</div>
      </section>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
