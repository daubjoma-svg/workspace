import React from 'react';

interface State { error: Error | null; }

export class ErrorBoundary extends React.Component<{ children: React.ReactNode; fallback?: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode; fallback?: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 透传到 console，让 DevTools 能看到原始堆栈
    console.error('[ErrorBoundary] 渲染错误:', error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{ padding: 24, margin: 16, background: 'var(--panel-2)', border: '1px solid var(--danger)', borderRadius: 10 }}>
          <h3 style={{ color: 'var(--danger)', marginTop: 0 }}>页面渲染出错</h3>
          <p style={{ color: 'var(--text-2)', fontSize: 13 }}>已阻止白屏，请刷新页面或回到列表。如果反复出现，把以下错误截图给管理员：</p>
          <pre style={{ background: 'var(--panel)', padding: 12, borderRadius: 6, fontSize: 12, overflow: 'auto', maxHeight: 240 }}>
{String(this.state.error?.stack || this.state.error?.message || this.state.error)}
            </pre>
          <button className="btn btn-primary" onClick={this.reset} style={{ marginTop: 10 }}>重试</button>
        </div>
      );
    }
    return this.props.children;
  }
}