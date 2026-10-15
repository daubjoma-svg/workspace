/* 全局图片灯箱：内容区（Markdown / 聊天气泡 / 富文本展示）里的图片点击后放大查看。
 *
 * 用 document 事件委托而非逐个改造渲染组件：内容既有 React 元素（renderMarkdown）
 * 也有 dangerouslySetInnerHTML（sanitizeHtml 产物），委托能统一覆盖、无需侵入。
 * 编辑区（contenteditable）内的图片不参与，避免干扰选中/光标。
 */
import { useEffect, useState } from 'react';

const ZOOMABLE = '.md-render img, .md img, .chat-bubble img, .rich-text img';

export function ImageZoom() {
  const [src, setSrc] = useState('');

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof HTMLImageElement)) return;
      if (!t.closest(ZOOMABLE)) return;
      if (t.closest('[contenteditable="true"]')) return;
      e.preventDefault();
      setSrc(t.currentSrc || t.src);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSrc(''); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [src]);

  if (!src) return null;
  return (
    <div className="img-zoom-mask" onClick={() => setSrc('')} role="dialog" aria-modal="true">
      <img className="img-zoom-img" src={src} alt="图片预览" onClick={(e) => e.stopPropagation()} />
      <button className="img-zoom-close" onClick={() => setSrc('')} aria-label="关闭">×</button>
    </div>
  );
}
