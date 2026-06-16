import { useState } from 'react';
import { api } from '../../shared/api/client';
import type { UserDTO } from '../../../shared/types';

export default function LoginPage({ onLogin, onRegister }: { onLogin: (u: UserDTO) => void; onRegister: () => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [err, setErr] = useState('');
  return <main className="auth"><section className="auth-card"><h1>chat-lite</h1><form onSubmit={async e => { e.preventDefault(); setErr(''); try { onLogin((await api.login(email, password)).user); } catch (e) { setErr(e instanceof Error ? e.message : '登录失败'); } }}>
    <input autoFocus type="email" placeholder="邮箱" value={email} onChange={e => setEmail(e.target.value)} />
    <input type="password" placeholder="密码" value={password} onChange={e => setPassword(e.target.value)} />
    {err && <div className="error">{err}</div>}<button>登录</button>
  </form><button className="link" onClick={onRegister}>注册</button></section></main>;
}
