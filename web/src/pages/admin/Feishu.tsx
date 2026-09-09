import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { useApp } from '../../App';
import { Icon } from '../../components/Icon';
import { SecretInput } from '../../components/SecretInput';

/* 使用说明（纯文字区块，编号即步骤顺序） */
const USAGE_STEPS = [
  '在飞书开放平台创建企业自建应用',
  '开启 im:message 发送权限',
  '将 app_id / app_secret 填到此处',
  '每位用户在「注册 / 用户信息」中填写自己的飞书 user_id 或邮箱',
  '流程流转到该用户负责节点时自动推送',
];

interface FeishuSettings {
  app_id: string;
  configured: boolean;
}

export default function Feishu() {
  const { toast } = useApp();
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [configured, setConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [target, setTarget] = useState('');
  const [testing, setTesting] = useState(false);

  /* 进入页面预填 app_id；configured 展示「已配置」徽标（app_secret 永不回显） */
  useEffect(() => {
    api.get('/api/admin/settings/feishu')
      .then((s: FeishuSettings) => { setAppId(s.app_id || ''); setConfigured(!!s.configured); })
      .catch(() => { /* 拉取失败不阻断配置页 */ });
  }, []);

  const save = async () => {
    // 保存前校验：app_id 与 app_secret 至少填一个（app_secret 留空 = 保留原值）
    if (!appId.trim() && !appSecret.trim()) return toast('请至少填写 app_id 或 app_secret');
    setSaving(true);
    try {
      await api.put('/api/admin/settings/feishu', { app_id: appId.trim(), app_secret: appSecret });
      setConfigured(true);
      toast('飞书配置已保存');
    } catch (e: any) { toast(e.message); }
    finally { setSaving(false); }
  };

  const testSend = async () => {
    if (!target.trim()) return toast('请填写接收测试消息的飞书 user_id 或邮箱');
    setTesting(true);
    try {
      await api.post('/api/admin/settings/feishu/test', { target: target.trim() });
      toast('测试消息已发送，请查收飞书');
    } catch (e: any) { toast(e.message); }
    finally { setTesting(false); }
  };

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="crumb">管理后台</div>
          <h1>飞书通知</h1>
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="section-head">
          <b className="rc-inline"><Icon name="settings" size={16} /> 应用配置</b>
          {configured
            ? <span className="tag tag-green"><Icon name="check" size={16} /> 已配置</span>
            : <span className="tag tag-grey">未配置</span>}
        </div>
        <div className="form-row" style={{ marginTop: 14 }}>
          <label>App ID</label>
          <input className="input" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="飞书开放平台中的应用 App ID" autoComplete="off" />
        </div>
        <div className="form-row">
          <label>App Secret</label>
          <SecretInput
            value={appSecret}
            onChange={setAppSecret}
            hasStored={configured}
            onReveal={async () => { const r = await api.get('/api/admin/settings/feishu/secret'); return r.app_secret || ''; }}
            placeholder={configured ? '已保存，留空表示保留原值' : '填写应用 App Secret'}
          />
          <div className="hint">密钥加密存储，留空保存将保留原值；点「小眼睛」可临时查看已存明文</div>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存配置'}</button>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <b className="rc-inline"><Icon name="send" size={16} /> 测试发送</b>
        <div className="form-row" style={{ marginTop: 14 }}>
          <label>接收人（你的飞书 user_id 或邮箱）</label>
          <input className="input" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="如 ou_xxx 或 name@company.com" autoComplete="off" />
        </div>
        <button className="btn" onClick={testSend} disabled={testing}>{testing ? '发送中…' : '发送测试消息'}</button>
      </div>

      <div className="card card-pad">
        <b className="rc-inline"><Icon name="book-open" size={16} /> 使用说明</b>
        <ol className="feishu-guide" style={{ marginTop: 12 }}>
          {USAGE_STEPS.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      </div>
    </div>
  );
}
