import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

/* ============================================================
   AiRunningBar — AI 节点运行中加载区块（需求详情页步骤条下方）
   纯展示组件：aiRunning / aiAction 由父组件传入，文案在此映射；
   已用时长在组件内计时（优先后端时间戳，缺省用本地首次观测时刻），
   不依赖后端新增字段。状态切换（AI_RUNNING → PENDING/…）时自动消失。
   无障碍：整区块 role=status，仅播报一次静态文案，计时数字 aria-hidden 避免每秒播报。
   ============================================================ */

const AI_PHASE: Record<string, string> = {
  PRECHECK: 'AI 正在检查需求完整性…', EVALUATE: 'AI 正在评估合理性…', PRD_GEN: 'AI 正在生成 PRD…',
  DEV_PROMPT: 'AI 正在生成研发提示词…', TEST_CASE: 'AI 正在编写测试用例…',
};

interface AiRunningBarProps {
  aiRunning: boolean;
  aiAction?: string;
  /** 后端时间戳（status_changed / touched_at / updated_at），可为空 */
  startAt?: string;
}

/** 兼容 "YYYY-MM-DD HH:MM:SS"（后端 localtime 格式）与 ISO 字符串 */
function parseTs(s?: string): number {
  if (!s) return NaN;
  const ts = Date.parse(s);
  if (Number.isFinite(ts)) return ts;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
}

export function AiRunningBar({ aiRunning, aiAction, startAt }: AiRunningBarProps) {
  const startRef = useRef<number | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!aiRunning) { startRef.current = null; return; }
    // 只取首次观测时刻，避免轮询中 startAt 变化把起点往后挪
    if (startRef.current === null) {
      const ts = parseTs(startAt);
      startRef.current = Number.isFinite(ts) ? ts : Date.now();
    }
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [aiRunning, startAt]);

  if (!aiRunning) return null;
  const phase = AI_PHASE[aiAction || ''] || 'AI 正在分析你的需求…';
  const elapsed = startRef.current ? Math.max(0, Math.floor((now - startRef.current) / 1000)) : 0;

  return (
    <div className="ai-running-block" role="status" aria-live="polite">
      <Icon name="loader" size={16} className="spin" />
      <div>
        <div className="ai-running-title">{phase}</div>
        <div className="muted" aria-hidden="true">已分析 {elapsed} 秒…</div>
      </div>
    </div>
  );
}
