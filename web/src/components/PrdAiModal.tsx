/* AI 按产品意图生成 PRD 弹窗
 *
 * - 输入：产品意图（文字）+ 可选截图（原型/界面，uploadImageFile → POST /api/uploads）
 * - 后端 POST /api/requirements/:id/prd-generate 返回 Markdown 正文，不直接落库；
 *   onGenerated 回传给父组件预填进 PrdEditor，产品检查修改后保存为新版本
 * - 已有 PRD 时后端以其为底稿按意图修改；没有则全新生成
 */
import { useRef, useState } from 'react';
import { useApp } from '../App';
import { api } from '../api';
import { Icon } from './Icon';
import { readFileAsDataUrl, resolveUploadUrl } from '../lib/uploadImage';

interface PrdAiModalProps {
  reqId: number;
  /** 已有 PRD：文案与占位提示按「修改」呈现 */
  hasPrd: boolean;
  onClose: () => void;
  onGenerated: (content: string) => void;
}

export function PrdAiModal({ reqId, hasPrd, onClose, onGenerated }: PrdAiModalProps) {
  const { toast } = useApp();
  const [intent, setIntent] = useState('');
  const [images, setImages] = useState<{ raw: string; url: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const uploadImage = async (file: File) => {
    if (!file.type.startsWith('image/')) { toast('请上传图片文件', 'error'); return; }
    setUploading(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const res: any = await api.post('/api/uploads', { data: dataUrl });
      const raw = res?.url || res?.data?.url;
      if (!raw) throw new Error('图片上传失败');
      setImages((prev) => [...prev, { raw, url: resolveUploadUrl(raw) }]);
    } catch (e: any) { toast(e.message || '图片上传失败', 'error'); }
    finally { setUploading(false); }
  };

  const generate = async () => {
    if (!intent.trim() || generating) return;
    setGenerating(true);
    try {
      const r = await api.post(`/api/requirements/${reqId}/prd-generate`, {
        intent: intent.trim(),
        images: images.map((i) => i.raw),
      });
      onGenerated(String(r.content || ''));
    } catch (e: any) { toast(e.message || 'AI 生成失败', 'error'); }
    finally { setGenerating(false); }
  };

  return (
    <div className="modal-mask" onClick={generating ? undefined : onClose}>
      <div className="modal card prd-modal" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          <span><Icon name="ai" size={16} /> {hasPrd ? 'AI 修改 PRD' : 'AI 生成 PRD'}</span>
        </div>
        <div className="modal-b">
          <div className="prd-hint">
            <Icon name="ai" size={16} />
            <span>{hasPrd
              ? 'AI 会以当前 PRD 为底稿，按你填写的意图修改；未涉及的部分保持稳定'
              : '描述你希望 PRD 覆盖的内容，AI 会结合需求、评估报告与代码仓库生成完整 PRD'}</span>
          </div>
          <div className="form-row">
            <label>产品意图 *</label>
            <textarea className="input" rows={5} value={intent} autoFocus disabled={generating}
              onChange={(e) => setIntent(e.target.value)}
              placeholder={hasPrd
                ? '例：验收标准加上「导出数量上限 5000 条」；功能范围去掉消息通知相关内容'
                : '例：为借款单费用归属问题写 PRD：单据命名取费用归属人员姓名，按费用归属设置带出人员，未设置时给出明确提示'}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate(); }}
              onPaste={(e) => {
                const f = Array.from(e.clipboardData?.files || []).find((x) => x.type.startsWith('image/'));
                if (f) { e.preventDefault(); uploadImage(f); }
              }} />
          </div>
          <div className="form-row">
            <label>截图（可选，原型 / 界面 / 报错）</label>
            <input ref={fileRef} type="file" accept="image/*" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(f); e.target.value = ''; }} />
            {images.length > 0 && (
              <div className="ai-chat-imgs" style={{ marginBottom: 8 }}>
                {images.map((img, i) => (
                  <span key={i} className="ai-chat-img-wrap">
                    <img className="ai-chat-img" src={img.url} alt="意图截图" />
                    <button className="ai-chat-img-del" title="移除" onClick={() => setImages((p) => p.filter((_, k) => k !== i))} disabled={generating}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-sm" onClick={() => fileRef.current?.click()} disabled={generating || uploading}>
                <Icon name="image" size={16} />{uploading ? '上传中…' : '添加截图'}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>支持直接粘贴图片（Ctrl/Cmd + V）</span>
            </div>
          </div>
        </div>
        <div className="modal-f">
          <button className="btn" onClick={onClose} disabled={generating}>取消</button>
          <button className="btn btn-primary" onClick={generate} disabled={generating || !intent.trim()}>
            {generating
              ? <><Icon name="loader" size={16} className="spin" /> AI 生成中，约 1-3 分钟…</>
              : <><Icon name="ai" size={16} /> {hasPrd ? '按意图修改' : '生成 PRD'}</>}
          </button>
        </div>
      </div>
    </div>
  );
}
