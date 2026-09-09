/* 富文本编辑器（RichTextEditor · .rte-* 命名空间）
 *
 * 基于 Tiptap（ProseMirror），替换 PRD 编辑 / 需求描述 / 聊天回复三处文本框。
 * 能力：
 * - 工具栏：粗体/斜体/行内代码/标题H2/有序无序列表/链接/图片/撤销重做（compact 仅保留精简组）
 * - 粘贴图片：clipboardData.files 检测 image/* → base64 → POST /api/uploads → setImage；
 *   上传失败降级插入 base64（避免粘贴内容丢失）
 * - `/` 快捷命令：行首输入 / 弹出悬浮菜单（标题/列表/代码块/图片/分割线），
 *   上下键选择 + Enter 确认 + Esc 关闭
 * - 链接：@tiptap/extension-link（openOnClick 点击跳转）
 * - value 为 HTML 字符串（getHTML() 输出），onChange 回传 HTML；空内容回传 ''
 *
 * 安全：存储的是 HTML，渲染层必须再过 lib/sanitize 的 sanitizeHtml（本组件不负责渲染）。
 * 图标走 Icon 收口层，无 emoji；样式全走语义 Token。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { uploadImageFile } from '../../lib/uploadImage';
import { Toolbar } from './Toolbar';
import { SlashMenu, filterSlashItems, type SlashAction } from './SlashMenu';

export interface RichTextEditorProps {
  /** HTML 字符串（Tiptap getHTML() 输出；老数据纯文本也可直接传入） */
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minRows?: number;
  /** 聊天 mini 版：精简工具栏 + 更小最小高度 */
  compact?: boolean;
  /** 聊天用：Enter 发送（Shift+Enter 换行）；不传则 Enter 正常换行 */
  onEnter?: () => void;
}

interface SlashState {
  open: boolean;
  pos: number;
  query: string;
  index: number;
  x: number;
  y: number;
}

const SLASH_CLOSED: SlashState = { open: false, pos: 0, query: '', index: 0, x: 0, y: 0 };

export function RichTextEditor({ value, onChange, placeholder = '', minRows = 3, compact, onEnter }: RichTextEditorProps) {
  const [slash, setSlash] = useState<SlashState>(SLASH_CLOSED);
  const [uploading, setUploading] = useState(false);

  const editorRef = useRef<Editor | null>(null);
  const onChangeRef = useRef(onChange);
  const onEnterRef = useRef(onEnter);
  const slashRef = useRef(slash);
  const boxRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  onChangeRef.current = onChange;
  onEnterRef.current = onEnter;
  useEffect(() => { slashRef.current = slash; }, [slash]);

  const closeSlash = () => setSlash((s) => (s.open ? { ...s, open: false } : s));

  const insertImage = async (file: File) => {
    const ed = editorRef.current;
    if (!ed) return;
    setUploading(true);
    try {
      const url = await uploadImageFile(file);
      ed.chain().focus().setImage({ src: url }).run();
    } catch {
      // 上传接口不可用 → 降级插入 base64，保证粘贴内容不丢失（sanitize 白名单放行图片 data:）
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('read'));
          reader.readAsDataURL(file);
        });
        ed.chain().focus().setImage({ src: dataUrl }).run();
      } catch { /* 读取失败则放弃插入 */ }
    } finally {
      setUploading(false);
    }
  };

  const runSlashCommand = (action: SlashAction) => {
    const ed = editorRef.current;
    const s = slashRef.current;
    if (!ed || !s.open) return;
    closeSlash();
    // 删除行首的 '/'（独立事务，确保选区稳定）
    ed.chain().focus().deleteRange({ from: s.pos - 1, to: s.pos }).run();
    // 单独应用命令：与工具栏一致使用 chain().focus().toggleXxx()，
    // 避免与 deleteRange 共享事务后 ProseMirror 选区上下文丢失导致命令 no-op
    switch (action) {
      case 'h2': ed.chain().focus().toggleHeading({ level: 2 }).run(); break;
      case 'ul': ed.chain().focus().toggleBulletList().run(); break;
      case 'ol': ed.chain().focus().toggleOrderedList().run(); break;
      case 'code': ed.chain().focus().toggleCodeBlock().run(); break;
      case 'image': fileRef.current?.click(); break;
      case 'hr': ed.chain().focus().setHorizontalRule().run(); break;
    }
  };

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({
        openOnClick: true,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      }),
      Image.configure({ allowBase64: true }),
    ],
    content: value,
    editorProps: {
      attributes: { class: 'rte-content', 'aria-label': placeholder || '富文本编辑器' },
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files || []);
        const img = files.find((f) => f.type.startsWith('image/'));
        if (!img) return false;
        event.preventDefault();
        insertImage(img);
        return true;
      },
      handleKeyDown: (view, event) => {
        const s = slashRef.current;
        if (s.open) {
          const items = filterSlashItems(s.query);
          if (event.key === 'ArrowDown') { event.preventDefault(); setSlash((p) => ({ ...p, index: items.length ? (p.index + 1) % items.length : 0 })); return true; }
          if (event.key === 'ArrowUp') { event.preventDefault(); setSlash((p) => ({ ...p, index: items.length ? (p.index - 1 + items.length) % items.length : 0 })); return true; }
          if (event.key === 'Enter') { event.preventDefault(); const it = items[s.index]; if (it) runSlashCommand(it.action); else closeSlash(); return true; }
          if (event.key === 'Escape') { closeSlash(); return true; }
          if (event.key === 'Backspace') {
            if (!s.query) { closeSlash(); return false; }
            setSlash((p) => ({ ...p, query: p.query.slice(0, -1) })); return true;
          }
          if (event.key === ' ') { closeSlash(); }
          return false;
        }
        if (onEnterRef.current && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          onEnterRef.current();
          return true;
        }
        return false;
      },
      handleTextInput: (view, from, to, text) => {
        const s = slashRef.current;
        if (s.open) {
          if (text === ' ') { closeSlash(); return false; }
          setSlash((p) => ({ ...p, query: p.query + text, index: 0 }));
          return false;
        }
        // 仅在「行首（可带空白）」输入 / 时唤起菜单，避免路径等正常斜杠误触
        if (text === '/') {
          const before = view.state.doc.textBetween(0, from, '\n');
          const prefix = before.slice(before.lastIndexOf('\n') + 1);
          if (/^\s*$/.test(prefix)) {
            const coords = view.coordsAtPos(from + 1);
            const rect = boxRef.current?.getBoundingClientRect();
            setSlash({
              open: true, pos: from + 1, query: '', index: 0,
              x: (coords?.left ?? 0) - (rect?.left ?? 0),
              y: (coords?.bottom ?? 0) - (rect?.top ?? 0),
            });
          }
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      onChangeRef.current(ed.isEmpty ? '' : ed.getHTML());
    },
  });

  editorRef.current = editor;

  // value 同步：外部（保存回显 / 聊天发送清空）变化时更新内容，但不回触发 onChange（避免死循环/光标跳变）
  useEffect(() => {
    const ed = editor;
    if (!ed) return;
    const html = ed.getHTML();
    if (value === html) return;
    ed.commands.setContent(value || '', { emitUpdate: false });
    ed.view.dom.classList.toggle('is-empty', ed.isEmpty);
  }, [value, editor]);

  // 占位符：空内容时显示 data-placeholder（is-empty 类 + CSS :before）
  useEffect(() => {
    const ed = editor;
    if (!ed) return;
    const dom = ed.view.dom as HTMLElement;
    dom.dataset.placeholder = placeholder;
    const sync = () => dom.classList.toggle('is-empty', ed.isEmpty);
    sync();
    ed.on('update', sync);
    return () => { ed.off('update', sync); };
  }, [editor, placeholder]);

  const items = useMemo(() => filterSlashItems(slash.query), [slash.query]);
  const minH = `${Math.max(minRows, 1) * 24 + 18}px`;

  return (
    <div
      ref={boxRef}
      className={`rte${compact ? ' rte-compact' : ''}`}
      style={{ '--rte-min-h': minH } as CSSProperties}
    >
      <Toolbar editor={editor} compact={compact} uploading={uploading} onImage={() => fileRef.current?.click()} />
      <EditorContent editor={editor} />
      {slash.open && (
        <SlashMenu
          x={slash.x}
          y={slash.y}
          items={items}
          index={Math.min(slash.index, Math.max(0, items.length - 1))}
          onSelect={runSlashCommand}
          onHover={(i) => setSlash((p) => ({ ...p, index: i }))}
        />
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) insertImage(f);
        }}
      />
    </div>
  );
}
