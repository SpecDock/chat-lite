import { useEffect, useState } from 'react';
import type { UserDTO } from '../../../shared/types';
import { api } from '../../shared/api/client';

export default function RegisterPage({ onRegistered, onLogin }: { onRegistered: (user: UserDTO) => void; onLogin: () => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [code, setCode] = useState(''); const [inviteCode, setInvite] = useState(''); const [msg, setMsg] = useState(''); const [cooldown, setCooldown] = useState(0); const [sending, setSending] = useState(false);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown(v => Math.max(0, v - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  const sendCode = async () => {
    if (sending || cooldown > 0) return;
    setMsg('');
    setSending(true);
    try {
      await api.sendCode(email, inviteCode);
      setCooldown(60);
      setMsg('验证码已发送');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '发送失败');
    } finally {
      setSending(false);
    }
  };
  return <main className="auth"><section className="auth-card"><h1>chat-lite</h1><form onSubmit={async e => { e.preventDefault(); setMsg(''); try { const r = await api.register({ email, password, code, inviteCode }); onRegistered(r.user); } catch (e) { setMsg(e instanceof Error ? e.message : '注册失败'); } }}>
    <input type="email" placeholder="邮箱" value={email} onChange={e => setEmail(e.target.value)} />
    <input placeholder="邀请码" value={inviteCode} onChange={e => setInvite(e.target.value)} />
    <div className="row"><input placeholder="验证码" value={code} onChange={e => setCode(e.target.value)} /><button type="button" disabled={sending || cooldown > 0} onClick={sendCode}>{sending ? '发送中' : cooldown > 0 ? `${cooldown}s` : '发送'}</button></div>
    <input type="password" placeholder="密码至少 8 位" value={password} onChange={e => setPassword(e.target.value)} />
    {msg && <div className="hint">{msg}</div>}<button>注册</button>
  </form><button className="link" onClick={onLogin}>登录</button></section></main>;
}
