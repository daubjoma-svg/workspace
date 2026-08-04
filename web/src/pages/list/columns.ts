import { Requirement } from '../../api';
import { IconName } from '../../components/Icon';

/**
 * 看板分组模型。
 *
 * 历史实现把勾选符号直接拼进分组 key（如 '已完成' 前缀），并用 key.startsWith 决定排序，
 * 导致「展示文案」与「业务标识」耦合：改一个图标就会改坏排序。
 * 这里拆成 key（稳定标识）/ label（展示）/ icon（图标）/ weight（排序权重）四段，
 * 排序只依赖 weight，渲染只依赖 label + icon。
 */
export interface ColumnDef {
  key: string;
  label: string;
  icon: IconName;
  /** 越小越靠前：0 = 流转中节点，1 = 终态（已完成 / 已取消） */
  weight: number;
}

export interface BoardColumn extends ColumnDef {
  items: Requirement[];
}

const TERMINAL: Record<string, ColumnDef> = {
  DONE: { key: 'status:DONE', label: '已完成', icon: 'shipped', weight: 1 },
  CANCELLED: { key: 'status:CANCELLED', label: '已取消', icon: 'cancelled', weight: 1 },
};

const RESOLVING: ColumnDef = {
  key: 'node:__resolving__', label: '节点解析中', icon: 'in-progress', weight: 0,
};

export function columnOf(r: Requirement, nodeName?: string): ColumnDef {
  const terminal = TERMINAL[r.status];
  if (terminal) return terminal;
  if (!nodeName || nodeName === '—') return RESOLVING;
  return { key: `node:${nodeName}`, label: nodeName, icon: 'flow', weight: 0 };
}

/** 按当前节点分组。同权重内保持需求原有顺序（Array.sort 在 ES2019+ 稳定）。 */
export function buildColumns(
  list: Requirement[],
  nodeNameOf: (r: Requirement) => string | undefined,
): BoardColumn[] {
  const grouped = new Map<string, BoardColumn>();
  list.forEach((r) => {
    const def = columnOf(r, nodeNameOf(r));
    let col = grouped.get(def.key);
    if (!col) { col = { ...def, items: [] }; grouped.set(def.key, col); }
    col.items.push(r);
  });
  return [...grouped.values()].sort((a, b) => a.weight - b.weight);
}
