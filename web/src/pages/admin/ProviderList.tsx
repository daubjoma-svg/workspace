import React from 'react';
import { Icon } from '../../components/Icon';
import { Provider } from './ProviderModal';

/** 上次测试时间 → 紧凑显示：MM-DD HH:mm，跨年补年份前缀（ISO 串本地化） */
const fmtTime = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}-` : '';
  return `${y}${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

interface ProviderListProps {
  list: Provider[];
  testingId: number | null;
  /** 行内已展开查看的明文 Key（key=provider id，值=明文；未展开 = undefined） */
  keyMap: Record<number, string>;
  onEdit: (p: Provider) => void;
  onToggle: (p: Provider) => void;
  onTest: (p: Provider) => void;
  onDelete: (p: Provider) => void;
  onViewKey: (p: Provider) => void;
}

/** Provider 列表：编辑 / 测试 / 启用·禁用 / 删除 / 行内查看 Key */
export default function ProviderList({
  list, testingId, keyMap,
  onEdit, onToggle, onTest, onDelete, onViewKey,
}: ProviderListProps) {
  const copyKey = async (plain: string) => {
    try { await navigator.clipboard.writeText(plain); } catch { /* 剪贴板不可用时静默 */ }
  };

  return (
    <div className="card tbl-wrap">
      <table className="tbl">
        <thead><tr><th>名称</th><th>类型</th><th>Base URL</th><th>Model</th><th>API Key</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          {list.map((p) => (
            <tr key={p.id}>
              <td>
                {p.name}
                {(p.last_tested_at || p.last_test_error) && (
                  <div className="ptm">
                    {p.last_test_error && <div className="ptm-error">{p.last_test_error}</div>}
                    {p.last_tested_at && <div className="ptm-time">上次测试 {fmtTime(p.last_tested_at)}</div>}
                  </div>
                )}
              </td>
              <td className="muted">{p.type}</td>
              <td className="muted">{p.base_url || '—'}</td>
              <td className="muted">{p.model || '—'}</td>
              <td>
                {p.api_key_set ? (
                  <span className="row" style={{ gap: 6 }}>
                    <span className="tag tag-green">已配置</span>
                    <button className="btn btn-sm btn-icon" onClick={() => onViewKey(p)}
                      aria-label={keyMap[p.id] !== undefined ? '收起 Key' : '查看 Key'}>
                      <Icon name={keyMap[p.id] !== undefined ? 'eye-off' : 'eye'} size={16} />
                    </button>
                  </span>
                ) : <span className="tag tag-grey">未配置</span>}
                {keyMap[p.id] !== undefined && (
                  <div className="ptm">
                    <div className="ptm-reply" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <code className="mono">{keyMap[p.id] || '（未配置）'}</code>
                      {keyMap[p.id] && (
                        <button className="btn btn-sm" onClick={() => copyKey(keyMap[p.id])}>
                          <Icon name="copy" size={16} /> 复制
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </td>
              <td>{p.enabled ? <span className="tag tag-green">启用中</span> : <span className="tag tag-grey">停用</span>}</td>
              <td className="row" style={{ alignItems: 'flex-start' }}>
                <button className="btn btn-sm" onClick={() => onEdit(p)}>编辑</button>
                <button className="btn btn-sm" disabled={testingId != null} onClick={() => onTest(p)}>
                  <Icon name="play-circle" size={16} />
                  {testingId === p.id ? '测试中…' : '测试'}
                </button>
                {p.enabled
                  ? <button className="btn btn-sm" onClick={() => onToggle(p)}>禁用</button>
                  : <button className="btn btn-sm btn-primary" onClick={() => onToggle(p)}>启用</button>}
                <button className="btn btn-sm btn-danger" onClick={() => onDelete(p)}>删除</button>
              </td>
            </tr>
          ))}
          {list.length === 0 && (
            <tr><td colSpan={7} className="empty" style={{ padding: '40px 10px' }}>尚未配置 AI Provider，点右上角「添加 AI Provider」接入 LLM</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
