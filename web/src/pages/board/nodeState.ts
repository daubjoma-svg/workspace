import { useEffect, useState } from 'react';
import { api, Requirement, SopNode } from '../../api';

export interface NodeSnapshot {
  /** 当前所处节点名；无法判定时为 '—' */
  node: string;
  nodes: SopNode[];
}

const UNKNOWN: NodeSnapshot = { node: '—', nodes: [] };

/**
 * 缓存键必须包含 current_seq 与 status。
 * 只用 id 做键会导致需求流转后仍命中旧快照，节点名与步骤条静默停留在上一节点。
 */
const snapshotKey = (r: Requirement) => `${r.id}:${r.current_seq}:${r.status}`;
const CACHE = new Map<string, NodeSnapshot>();

async function fetchSnapshot(r: Requirement): Promise<NodeSnapshot> {
  const key = snapshotKey(r);
  const hit = CACHE.get(key);
  if (hit) return hit;
  try {
    const detail = await api.get(`/api/requirements/${r.id}`);
    const nodes: SopNode[] = detail.nodes_view || detail.nodes || [];
    const current = nodes.find((n) => n.state === 'current');
    const node = current?.name
      || (detail.status === 'DONE' ? '已完成' : detail.status === 'CANCELLED' ? '已取消' : '—');
    const snapshot: NodeSnapshot = { node, nodes };
    CACHE.set(key, snapshot);
    return snapshot;
  } catch {
    // 单条失败不污染缓存，也不阻断整批渲染
    return UNKNOWN;
  }
}

/** 批量解析需求当前节点。返回 requirementId → 节点快照。 */
export function useNodeNames(list: Requirement[]) {
  const [map, setMap] = useState<Record<number, NodeSnapshot>>({});
  const signature = list.map(snapshotKey).join(',');

  useEffect(() => {
    let alive = true;
    (async () => {
      const entries = await Promise.all(
        list.map(async (r) => [r.id, await fetchSnapshot(r)] as const),
      );
      if (alive) setMap(Object.fromEntries(entries));
    })();
    return () => { alive = false; };
    // signature 覆盖 id/seq/status 三要素，列表内容未变时不重复请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return map;
}

/** 详情接口回 Clarify[]，列表接口回 number —— 统一成计数 */
export function openCount(r: Requirement): number {
  if (typeof r.open_clarifies === 'number') return r.open_clarifies;
  if (Array.isArray(r.open_clarifies)) return r.open_clarifies.length;
  return 0;
}
