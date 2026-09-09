import { Icon } from './Icon';
import type { ArtifactMeta } from '../lib/artifactMeta';

/* 评估来源元信息条（AC-09）
 * 显示：这份评估是哪个模型出的（model · provider_type）+ 基于哪些代码（code_basis）。
 * code_basis 为 null / 空 → "本次评估未关联代码上下文"，不崩、不留空白。
 * meta 整列缺失（历史产物）→ 同样兜底。
 *
 * structured_level 这里**不再渲染**：降级/成功状态统一交给 AiWarnBar 顶部警示条提示
 * ——避免 sl='mock' 时直接显示「mock」字样造成误导（mock 是降级标记，不是能力分级；json_schema/json_object/prompt_only 才是）。
 */
export function EvalMetaBar({ meta }: { meta: ArtifactMeta | null }) {
  const modules = meta?.code_basis?.modules ?? [];

  return (
    <div className="eval-meta">
      <div className="em-row">
        <span className="em-key">模型</span>
        <span className="em-val em-model">{meta?.model || '未知模型'}</span>
        {meta?.provider_type && <span className="muted-note">· {meta.provider_type}</span>}
      </div>
      <div className="em-row">
        <span className="em-key">代码上下文</span>
        {modules.length === 0 ? (
          <span className="muted-note">本次评估未关联代码上下文</span>
        ) : (
          <span className="em-modules">
            {modules.map((m, i) => (
              <span key={i} className="code-mod">
                <Icon name="code-branch" size={16} className="ic" />
                <span className="em-val">{m.module_key}@{m.branch}</span>
                <span className="muted-note">·</span>
                <Icon name="code-commit" size={16} className="ic" />
                <span className="em-val em-model">{m.commit}</span>
                <span className="muted-note">· {m.file_count} 个文件</span>
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
