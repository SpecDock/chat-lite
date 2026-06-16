import { useEffect, useState } from 'react';
import type { UserDTO } from '../../shared/types';
import { api } from '../shared/api/client';
import LoginPage from '../features/auth/LoginPage';
import RegisterPage from '../features/auth/RegisterPage';
import ChatPage from '../features/chat/ChatPage';

export default function App() {
  const [user, setUser] = useState<UserDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [entry, setEntry] = useState<'resume' | 'login'>('resume');
  useEffect(() => { api.me().then(r => setUser(r.user)).catch(() => setUser(null)).finally(() => setLoading(false)); }, []);
  if (loading) return <div className="center">加载中...</div>;
  if (!user && mode === 'register') return <RegisterPage onRegistered={u => { setEntry('login'); setUser(u); }} onLogin={() => setMode('login')} />;
  if (!user) return <LoginPage onLogin={u => { setEntry('login'); setUser(u); }} onRegister={() => setMode('register')} />;
  return <ChatPage user={user} initialScroll={entry === 'login' ? 'bottom' : 'restore'} onLogout={async () => { await api.logout(); setEntry('resume'); setUser(null); }} />;
}
