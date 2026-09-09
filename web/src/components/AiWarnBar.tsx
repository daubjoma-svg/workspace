import { Icon } from './Icon';
import type { ArtifactMeta } from '../lib/artifactMeta';
import { classifyWarning } from '../lib/artifactMeta';

/* AI 产物警示条（AC-10）
 * 两种分支文案严格区分，绝不混成一句：
 *   - mock    → 假数据，不可作为排期依据
 *   - degraded→ 真模型但输出未通过结构校验，已用兜底结果，需人工复核
 * 语义色走 --warn（design-tokens 的警告语义色），禁止硬编码琥珀色值；图标走 Icon 收口层（lucide TriangleAlert）。
 */
export function AiWarnBar({ meta }: { meta: ArtifactMeta | null }) {
  const kind = classifyWarning(meta);
  if (!kind) return null;

  const text =
    kind === 'mock'
      ? '演示数据，不可作为排期依据'
      : '模型输出未通过结构校验，已使用兜底结果，请人工复核';

  return (
    <div className="ai-warn-bar" role="alert">
      <Icon name="warning" size={20} className="ic" />
      <div className="txt">
        <span>{text}</span>
        {kind === 'degraded' && meta?.degraded_reason && (
          <span className="reason">原因：{meta.degraded_reason}</span>
        )}
      </div>
    </div>
  );
}
