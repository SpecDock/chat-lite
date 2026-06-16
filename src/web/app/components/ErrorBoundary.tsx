import { Component, type ErrorInfo, type ReactNode } from 'react';

export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : '页面渲染失败' };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[chat-lite] render error', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <div className="center error-screen">
      <h1>chat-lite</h1>
      <p>页面加载失败，请刷新重试。</p>
      <small>{this.state.error}</small>
      <button onClick={() => window.location.reload()}>刷新页面</button>
      <button className="secondary" onClick={() => { try { window.localStorage.clear(); } catch { /* ignore */ } window.location.reload(); }}>清理本机缓存并刷新</button>
    </div>;
  }
}
