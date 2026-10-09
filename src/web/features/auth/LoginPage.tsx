import { useEffect, useState } from 'react';
import { api } from '../../shared/api/client';
import type { UserDTO } from '../../../shared/types';

export default function LoginPage({ onLogin, onRegister }: { onLogin: (u: UserDTO) => void; onRegister: () => void }) {
  const [mode, setMode] = useState<'login' | 'reset'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginMessage, setLoginMessage] = useState('');
  const [resetStep, setResetStep] = useState<'request' | 'complete'>('request');
  const [challenge, setChallenge] = useState<{ challengeId: string; expression: string } | null>(null);
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetMessage, setResetMessage] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown(value => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  useEffect(() => {
    if (mode !== 'reset' || challenge) return;
    let active = true;
    api.passwordCaptcha().then(result => {
      if (active) setChallenge(result);
    }).catch(error => {
      if (active) setResetMessage(error instanceof Error ? error.message : '验证码加载失败');
    });
    return () => { active = false; };
  }, [mode, challenge]);

  const refreshCaptcha = async () => {
    setChallenge(null);
    setCaptchaAnswer('');
    try {
      setChallenge(await api.passwordCaptcha());
    } catch (error) {
      setResetMessage(error instanceof Error ? error.message : '验证码加载失败');
    }
  };

  const openReset = () => {
    setMode('reset');
    setResetStep('request');
    setResetMessage('');
    setCooldown(0);
    setChallenge(null);
    setCaptchaAnswer('');
  };

  const returnToLogin = () => {
    setMode('login');
    setResetMessage('');
    setCode('');
    setNewPassword('');
    setConfirmPassword('');
  };

  const sendResetCode = async () => {
    if (busy || cooldown > 0) return;
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) return setResetMessage('请输入正确的邮箱');
    const answerText = captchaAnswer.trim();
    const answer = Number(answerText);
    if (!/^\d+$/.test(answerText) || !Number.isInteger(answer) || answer < 0 || answer > 99) return setResetMessage('验证码答案必须是 0 到 99 的整数');
    if (!challenge) return setResetMessage('算术验证码还未加载');
    setBusy(true);
    setResetMessage('');
    try {
      await api.sendPasswordResetCode({ email: normalizedEmail, challengeId: challenge.challengeId, captchaAnswer: answer });
      setEmail(normalizedEmail);
      setCooldown(60);
      setResetStep('complete');
      setResetMessage('验证码已发送，请检查邮箱');
    } catch (error) {
      setResetMessage(error instanceof Error ? error.message : '验证码发送失败');
      await refreshCaptcha();
    } finally {
      setBusy(false);
    }
  };

  const submitReset = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!/^\d{6}$/.test(code.trim())) return setResetMessage('请输入 6 位邮箱验证码');
    if (newPassword.length < 8) return setResetMessage('新密码至少 8 位');
    if (newPassword !== confirmPassword) return setResetMessage('两次新密码不一致');
    setBusy(true);
    setResetMessage('');
    try {
      await api.resetPassword({ email: email.trim().toLowerCase(), code: code.trim(), newPassword, confirmPassword });
      setPassword('');
      setLoginMessage('密码已重置，请使用新密码登录');
      returnToLogin();
    } catch (error) {
      setResetMessage(error instanceof Error ? error.message : '密码重置失败');
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'reset') return <main className="auth"><section className="auth-card"><h1>chat-lite</h1><div className="auth-heading"><strong>忘记密码</strong><span>通过绑定邮箱重置登录密码</span></div>
    {resetStep === 'request' ? <form onSubmit={event => { event.preventDefault(); void sendResetCode(); }}>
      <label className="auth-field"><span>邮箱</span><input autoFocus type="email" autoComplete="email" placeholder="邮箱" value={email} onChange={event => setEmail(event.target.value)} /></label>
      <div className="auth-code-row"><label className="auth-field"><span>算式：{challenge?.expression || '加载中...'}</span><input inputMode="numeric" pattern="[0-9]*" aria-label="算术验证码答案" placeholder="答案 0-99" value={captchaAnswer} onChange={event => setCaptchaAnswer(event.target.value.replace(/\D/g, '').slice(0, 2))} /></label><button type="submit" disabled={busy || cooldown > 0 || !challenge}>{busy ? '发送中' : cooldown > 0 ? `${cooldown}s` : '发送验证码'}</button></div>
      {resetMessage && <div className="error" role="alert">{resetMessage}</div>}
    </form> : <form onSubmit={submitReset}>
      <label className="auth-field"><span>邮箱验证码</span><input autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6 位验证码" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} /></label>
      <label className="auth-field"><span>新密码</span><input type="password" autoComplete="new-password" placeholder="密码至少 8 位" value={newPassword} onChange={event => setNewPassword(event.target.value)} /></label>
      <label className="auth-field"><span>确认新密码</span><input type="password" autoComplete="new-password" placeholder="再次输入新密码" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} /></label>
      {resetMessage && <div className={resetMessage === '验证码已发送，请检查邮箱' ? 'hint' : 'error'} role="alert">{resetMessage}</div>}
      <button disabled={busy}>{busy ? '重置中' : '重置密码'}</button>
    </form>}
    <button className="link" type="button" onClick={returnToLogin}>返回登录</button>
  </section></main>;

  return <main className="auth"><section className="auth-card"><h1>chat-lite</h1><form onSubmit={async event => { event.preventDefault(); setLoginMessage(''); setBusy(true); try { onLogin((await api.login(email, password)).user); } catch (error) { setLoginMessage(error instanceof Error ? error.message : '登录失败'); } finally { setBusy(false); } }}>
    <label className="auth-field"><span>邮箱</span><input autoFocus type="email" autoComplete="email" placeholder="邮箱" value={email} onChange={event => setEmail(event.target.value)} /></label>
    <label className="auth-field"><span>密码</span><input type="password" autoComplete="current-password" placeholder="密码" value={password} onChange={event => setPassword(event.target.value)} /></label>
    {loginMessage && <div className="hint" role="alert">{loginMessage}</div>}<button disabled={busy}>{busy ? '登录中' : '登录'}</button>
  </form><button className="link" type="button" onClick={openReset}>忘记密码</button><button className="link" type="button" onClick={onRegister}>注册</button></section></main>;
}
