/* 富文本工具栏（Toolbar · .rte-* 命名空间）
 *
 * 纯展示：接收 Tiptap Editor 实例，根据当前选区状态渲染激活/禁用态。
 * - 完整模式：粗体/斜体/行内代码/标题H2/无序/有序/链接/图片/撤销/重做
 * - compact 模式（聊天 mini 版）：仅 粗体/斜体/行内代码/链接/图片
 * 图标走 Icon 收口层，无 emoji；链接弹 prompt 输入 URL。
 */
import type { Editor } from '@tiptap/react';
import type { IconName } from '../Icon';
import { Icon } from '../Icon';
import { ConfirmModal } from '../ConfirmModal';
import { useState } from 'react';

interface ToolbarProps {
  editor: Editor | null;
  compact?: boolean;
  uploading?: boolean;
  onImage: () => void;
}

function ToolButton({ editor, active, disabled, onClick, icon, label }: {
  editor: Editor; active: boolean; disabled?: boolean; onClick: () => void; icon: IconName; label: string;
}) {
  return (
    <button
      type="button"
      className={`rte-btn${active ? ' active' : ''}`}
      disabled={disabled}
      // preventDefault on mousedown 避免按钮抢焦点导致编辑器选区塌缩为光标，
      // 选中文字后再点工具栏，粗体/斜体/链接等 mark 才能正确应用到选区。
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      <Icon name={icon} size={16} />
    </button>
  );
}

export function Toolbar({ editor, compact, uploading, onImage }: ToolbarProps) {
  /** 链接输入弹窗：null=关闭；字符串=默认值 */
  const [linkDlg, setLinkDlg] = useState<string | null>(null);
  if (!editor) return null;

  const openLink = () => {
    const prev = (editor.getAttributes('link').href as string) || '';
    setLinkDlg(prev);
  };
  const applyLink = (input?: string) => {
    setLinkDlg(null);
    const href = (input || '').trim();
    if (!href) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor
      .chain().focus().extendMarkRange('link')
      .setLink({ href: /^https?:\/\//i.test(href) ? href : `https://${href}` })
      .run();
  };

  return (
    <div className="rte-toolbar" role="toolbar" aria-label="富文本工具栏">
      <ToolButton editor={editor} active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} icon="bold" label="粗体" />
      <ToolButton editor={editor} active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} icon="italic" label="斜体" />
      <ToolButton editor={editor} active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()} icon="code" label="行内代码" />
      {!compact && (
        <>
          <span className="rte-sep" aria-hidden="true" />
          <ToolButton editor={editor} active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} icon="heading" label="标题 H2" />
          <ToolButton editor={editor} active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} icon="list-bullet" label="无序列表" />
          <ToolButton editor={editor} active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} icon="list-ordered" label="有序列表" />
          <span className="rte-sep" aria-hidden="true" />
        </>
      )}
      <ToolButton editor={editor} active={editor.isActive('link')} onClick={openLink} icon="link" label="插入链接" />
      <ToolButton editor={editor} active={false} disabled={uploading} onClick={onImage} icon="image" label={uploading ? '上传中…' : '插入图片'} />
      {!compact && (
        <>
          <span className="rte-sep" aria-hidden="true" />
          <ToolButton editor={editor} active={false} disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()} icon="undo" label="撤销" />
          <ToolButton editor={editor} active={false} disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()} icon="redo" label="重做" />
        </>
      )}
      {/* 链接输入统一弹窗（替代 window.prompt） */}
      {linkDlg !== null && (
        <ConfirmModal
          title="插入链接"
          inputPlaceholder="https://…"
          inputDefault={linkDlg || 'https://'}
          confirmText="确定"
          onCancel={() => setLinkDlg(null)}
          onConfirm={(input) => applyLink(input)}
        />
      )}
    </div>
  );
}
