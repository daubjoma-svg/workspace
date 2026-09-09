import React from 'react';
import Users from './admin/Users';
import Sop from './admin/Sop';
import AiProviders from './admin/AiProviders';
import Modules from './admin/Modules';
import Theme from './admin/Theme';
import Stats from './admin/Stats';
import Feishu from './admin/Feishu';

export type AdminTab = 'users' | 'sop' | 'ai' | 'modules' | 'theme' | 'stats' | 'feishu';

export const ADMIN_TABS: [AdminTab, string][] = [
  ['sop', 'SOP 编排'], ['modules', '模块管理'], ['users', '人员管理'],
  ['ai', 'AI 配置'], ['feishu', '飞书通知'], ['theme', '外观主题'], ['stats', '数据总览'],
];

export default function Admin({ tab }: { tab: AdminTab }) {
  return (
    <div>
      {tab === 'users' && <Users />}
      {tab === 'sop' && <Sop />}
      {tab === 'ai' && <AiProviders />}
      {tab === 'modules' && <Modules />}
      {tab === 'feishu' && <Feishu />}
      {tab === 'theme' && <Theme />}
      {tab === 'stats' && <Stats />}
    </div>
  );
}
