/* 图标收口层 —— 全项目唯一图标出口
 *
 * 契约（SPEC-v1.0 §8 / DIRECTION.md §6，违反即 P0 退回）：
 *   1. 图标库锁定 lucide-react，业务代码不得直接 import lucide-react，必须走本文件。
 *   2. 尺寸仅 16 / 20 / 24 三档：16=行内与表格，20=按钮与导航，24=独立图标与空态。
 *   3. 描边统一 1.75，颜色继承 currentColor，禁止彩色图标。
 *   4. 严禁用 emoji 或其它符号字符充当功能图标。
 *   5. 无障碍：装饰性图标 aria-hidden；独立承载语义时必须传 label。
 *
 * 语义命名与 Lucide 组件名解耦：业务侧只认 IconName，换库时只改本文件的映射表。
 */
import type { LucideIcon } from 'lucide-react';
import {
  Activity, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Ban, Bell, BellRing, Bold, BookOpen, Building2, Check,
  ChevronDown, ChevronRight, ChevronUp, CircleCheckBig, CircleDot, CircleDotDashed, ClipboardList, Code,
  Copy, Cpu, Eye, EyeOff, FileText, FlaskConical, GitBranch, GitCommitHorizontal, GitMerge, Hammer,
  Heading2, ImagePlus, Inbox, Italic, Key, Layers, LayoutGrid, Link, List, ListOrdered, ListTodo, Loader2,
  LogOut, Megaphone, MessageSquare, Minus, PackageOpen, Pencil, PlayCircle, Plus, Redo2, RefreshCw, Repeat, Search,
  Send, Settings2, Table2, TriangleAlert, Undo2, Workflow, X,
} from 'lucide-react';

/** 全局描边宽度：16px 下比 2 细腻，比 1.5 清晰 */
export const ICON_STROKE_WIDTH = 1.75;

/** 语义名 → Lucide 组件。新增图标只在此登记，业务侧引用语义名。 */
const ICON_REGISTRY = {
  /* — 导航与视图 — */
  'board': LayoutGrid,
  'list': Table2,
  'flow': Workflow,
  'settings': Settings2,
  'logout': LogOut,

  /* — 需求域 — */
  'requirement': FileText,
  'prd': FileText,
  'customer': Building2,
  'total': Layers,
  'inbox': Inbox,
  'todo': ListTodo,
  'in-progress': CircleDotDashed,
  'active': Activity,
  'clarify': MessageSquare,
  'shipped': CircleCheckBig,
  'cancelled': Ban,
  'develop': Hammer,
  'test': FlaskConical,
  'retest': Repeat,
  'edit': Pencil,
  'preview': Eye,
  'image': ImagePlus,

  /* — 富文本编辑（RichTextEditor 工具栏 / 快捷命令） — */
  'bold': Bold,
  'italic': Italic,
  'code': Code,
  'heading': Heading2,
  'list-bullet': List,
  'list-ordered': ListOrdered,
  'link': Link,
  'undo': Undo2,
  'redo': Redo2,
  'refresh': RefreshCw,
  'minus': Minus,

  /* — 角色 — */
  'role-csm': Megaphone,
  'role-po': ClipboardList,
  'role-rd': Code,
  'role-qa': FlaskConical,
  'role-other': CircleDot,

  /* — AI：材质区分而非颜色区分，图标用 Cpu，禁止 Sparkles / 星星 / 机器人 — */
  'ai': Cpu,
  /* AI 运行中 loading 转圈（配合 .spin 动画） */
  'loader': Loader2,

  /* — 代码感知 — */
  'code-branch': GitBranch,
  'code-commit': GitCommitHorizontal,
  'code-merge': GitMerge,

  /* — 动作与状态 — */
  'check': Check,
  'close': X,
  'x': X,
  'plus': Plus,
  'search': Search,
  'send': Send,
  'play-circle': PlayCircle,
  'back': ArrowLeft,
  'next': ChevronRight,
  'forward': ArrowRight,
  'move-up': ArrowUp,
  'move-down': ArrowDown,
  'chevron-down': ChevronDown,
  'chevron-up': ChevronUp,
  'chevron-right': ChevronRight,
  'return': Undo2,
  'warning': TriangleAlert,
  'empty-box': PackageOpen,
  'bell': Bell,
  'bell-ring': BellRing,
  'copy': Copy,
  'key': Key,

  /* — 密文可见性（小眼睛切换明文/密文，P0-1 收口） — */
  'eye': Eye,
  'eye-off': EyeOff,

  /* — 文档与说明 — */
  'book-open': BookOpen,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICON_REGISTRY;
/** 仅此三档，禁止其它尺寸 */
export type IconSize = 16 | 20 | 24;

export interface IconProps {
  name: IconName;
  /** 16=行内/表格，20=按钮/导航，24=独立/空态。默认 16 */
  size?: IconSize;
  className?: string;
  /**
   * 图标独立承载语义时传（如纯图标按钮），会输出 role="img" + aria-label。
   * 不传 = 装饰性，输出 aria-hidden，由相邻文本承担语义。
   */
  label?: string;
}

export function Icon({ name, size = 16, className, label }: IconProps) {
  const Glyph = ICON_REGISTRY[name];
  return (
    <Glyph
      size={size}
      strokeWidth={ICON_STROKE_WIDTH}
      className={className}
      focusable="false"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    />
  );
}
