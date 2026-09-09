/* artifact.meta 契约解析层
 *
 * 来源：后端 runAI 的 meta 落进 artifact.meta 列（JSON 字符串）。
 * 契约已与后端（贝洛奇）锁死，字段名严禁自行改动。
 * 历史产物的 meta 可能不存在，code_basis 可能为 null —— 全部按兜底处理。
 */

export interface CodeModule {
  module_key: string;
  branch: string;
  commit: string;
  file_count: number;
}

export interface CodeBasis {
  modules: CodeModule[];
}

export interface ArtifactMeta {
  provider_id: number;
  provider_type: string;
  model: string;
  structured_level: 'json_schema' | 'json_object' | 'prompt_only' | string;
  status: 'OK' | 'DEGRADED' | string;
  degraded_reason: string | null;
  latency_ms: number;
  attempt: number;
  is_mock: boolean;
  code_basis: CodeBasis | null;
}

/** 安全解析 artifact.meta（JSON 字符串）。字段缺失/非法 JSON/整列不存在 → 返回 null。 */
export function parseArtifactMeta(raw: string | null | undefined): ArtifactMeta | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    return obj as ArtifactMeta;
  } catch {
    return null;
  }
}

export type WarnKind = 'mock' | 'degraded' | null;

/** 是否触发警示条：mock（假数据）优先；否则 DEGRADED（真模型但未通过结构校验）。两者皆非 → null。 */
export function classifyWarning(meta: ArtifactMeta | null): WarnKind {
  if (!meta) return null;
  if (meta.is_mock === true) return 'mock';
  if (meta.status === 'DEGRADED') return 'degraded';
  return null;
}
