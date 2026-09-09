import React, { useEffect, useState } from 'react';
import { api } from '../../api';

export default function Stats() {
  const [s, setS] = useState<any>(null);
  useEffect(() => { api.get('/api/admin/stats').then(setS); }, []);
  if (!s) return null;
  const statusName: Record<string, string> = {
    DRAFT: '草稿', SUBMITTED: '已提交', AI_RUNNING: 'AI 处理中', CLARIFYING: '待澄清',
    PENDING: '待处理', DONE: '已完成', CANCELLED: '已取消',
  };
  return (
    <div>
      <div className="topbar">
        <div>
          <div className="crumb">管理后台</div>
          <h1>数据总览</h1>
        </div>
      </div>
      <div className="grid3" style={{ marginBottom: 16 }}>
        {[['需求总数', s.requirements], ['成员数', s.users], ['完成数', s.byStatus.find((x: any) => x.status === 'DONE')?.n || 0]].map(([label, v]) => (
          <div className="card card-pad" key={label as string}>
            <div className="muted">{label}</div>
            <div style={{ fontSize: 28, fontWeight: 700, marginTop: 6, color: 'var(--primary)' }}>{v}</div>
          </div>
        ))}
      </div>
      <div className="grid2">
        <div className="card card-pad">
          <b>按状态分布</b>
          <table className="tbl" style={{ marginTop: 10 }}>
            <tbody>
              {s.byStatus.map((x: any) => (
                <tr key={x.status}><td>{statusName[x.status] || x.status}</td><td style={{ textAlign: 'right' }}>{x.n}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card card-pad">
          <b>按改动等级</b>
          <table className="tbl" style={{ marginTop: 10 }}>
            <tbody>
              {s.byLevel.length === 0 && <tr><td className="muted">暂无数据</td></tr>}
              {s.byLevel.map((x: any) => (
                <tr key={x.level}><td><span className="tag tag-blue">{x.level}</span></td><td style={{ textAlign: 'right' }}>{x.n}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
