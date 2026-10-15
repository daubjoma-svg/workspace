/* PRD 编辑弹窗（编辑 / 预览双模式，富文本）
 *
 * - 编辑态：RichTextEditor（Tiptap），工具栏含粗体/斜体/代码/标题/列表/链接/图片，
 *   粘贴图片自动上传（uploadImageFile → POST /api/uploads），失败降级 base64
 * - 预览态：新数据（HTML）→ sanitizeHtml 后渲染（XSS 红线）；存量 Markdown → renderMarkdown
 *   （React 元素树，文本自动转义，天然免 XSS）
 * - 保存：onSave(content) 回传 HTML（后端 content 字段 TEXT 不限制）
 * - 图标走 Icon 收口层（lucide），禁止 emoji
 */
import { useState } from 'react';
import { Icon } from './Icon';
import { RichTextEditor } from './rich/RichTextEditor';
import { RichText } from './RichText';
import { markdownToHtml, renderMarkdown } from '../lib/markdown';
import { isHtmlContent } from '../lib/sanitize';

interface PrdEditorProps {
  /** 初始内容（编辑已有 PRD 传入原内容；新增传空串） */
  initial: string;
  title?: string;
  /** 编辑器占位文案；不同产物（PRD / 测试报告）复用时区分提示 */
  placeholder?: string;
  onClose: () => void;
  onSave: (content: string) => void;
}

export function PrdEditor({ initial, title = 'PRD 文档', placeholder = '输入 PRD 内容…', onClose, onSave }: PrdEditorProps) {
  // AI 产物历史上以 Markdown 保存；进入 Tiptap 前转换为 HTML，避免源码符号和换行丢失。
  const [value, setValue] = useState(() => isHtmlContent(initial) ? initial : markdownToHtml(initial));
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal card prd-modal" style={{ width: 760 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          <span>{title}</span>
          <div className="seg prd-mode-seg" role="tablist" aria-label="PRD 编辑模式">
            <button type="button" role="tab" aria-selected={mode === 'edit'}
              className={`seg-tab ${mode === 'edit' ? 'on' : ''}`} onClick={() => setMode('edit')}>
              <Icon name="edit" size={16} /> 编辑
            </button>
            <button type="button" role="tab" aria-selected={mode === 'preview'}
              className={`seg-tab ${mode === 'preview' ? 'on' : ''}`} onClick={() => setMode('preview')}>
              <Icon name="preview" size={16} /> 预览
            </button>
          </div>
        </div>
        <div className="modal-b">
          <div className="prd-hint">
            <Icon name="image" size={16} />
            <span>支持标题、列表、粗体/斜体、代码块、链接；可直接粘贴图片（Ctrl/Cmd + V）自动上传</span>
          </div>
          {mode === 'edit' ? (
            <RichTextEditor value={value} onChange={setValue} placeholder={placeholder} minRows={12} />
          ) : isHtmlContent(value) ? (
            <RichText html={value} className="md md-render prd-preview" />
          ) : (
            <div className="md md-render prd-preview">{renderMarkdown(value)}</div>
          )}
        </div>
        <div className="modal-f">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={() => onSave(value)}>保存版本</button>
        </div>
      </div>
    </div>
  );
}
