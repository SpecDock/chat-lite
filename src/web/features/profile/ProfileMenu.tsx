import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { LogOut, X } from 'lucide-react';
import type { UserDTO } from '../../../shared/types';
import { api } from '../../shared/api/client';
import UsageDialog, { type UsageKind } from './UsageDialog';

gsap.registerPlugin(useGSAP);

type Dialog = 'avatar' | 'password' | 'logout' | UsageKind | null;

const dialogTitles: Record<Exclude<Dialog, null>, string> = {
  avatar: '更改头像',
  password: '更改密码',
  token: 'Token统计',
  image: '生图统计',
  logout: '退出登录'
};

function isUsageDialog(dialog: Dialog): dialog is UsageKind {
  return dialog === 'token' || dialog === 'image';
}

export default function ProfileMenu({ user, onUserChange, onLogout }: { user: UserDTO; onUserChange: (user: UserDTO) => void; onLogout?: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarMsg, setAvatarMsg] = useState('');
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [passwordCode, setPasswordCode] = useState('');
  const [passwordCooldown, setPasswordCooldown] = useState(0);
  const [passwordCodeSending, setPasswordCodeSending] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [logoutMsg, setLogoutMsg] = useState('');
  const [logoutBusy, setLogoutBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const avatarButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const dialogReturnFocusRef = useRef<HTMLElement | null>(null);
  const menuId = useId();
  const dialogTitleId = useId();
  const initials = user.email.slice(0, 1).toUpperCase();
  const passwordMismatch = Boolean(newPassword && confirmPassword && newPassword !== confirmPassword);

  useEffect(() => {
    if (!open) return;

    const closeMenu = () => setOpen(false);
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeMenu();
      avatarButtonRef.current?.focus({ preventScroll: true });
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('resize', closeMenu);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('resize', closeMenu);
    };
  }, [open]);

  useEffect(() => {
    if (passwordCooldown <= 0) return;
    const timer = window.setTimeout(() => setPasswordCooldown(value => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [passwordCooldown]);

  useGSAP(() => {
    if (!open || !menuRef.current) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    gsap.fromTo(menuRef.current, { autoAlpha: 0, y: -6, scale: 0.98 }, {
      autoAlpha: 1,
      y: 0,
      scale: 1,
      duration: reduceMotion ? 0 : 0.18,
      ease: 'power2.out'
    });
  }, { scope: rootRef, dependencies: [open], revertOnUpdate: true });

  useGSAP(() => {
    if (!dialog || !dialogRef.current) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    gsap.fromTo(dialogRef.current, { autoAlpha: 0, y: 8, scale: 0.985 }, {
      autoAlpha: 1,
      y: 0,
      scale: 1,
      duration: reduceMotion ? 0 : 0.2,
      ease: 'power2.out'
    });
  }, { scope: dialogRef, dependencies: [dialog], revertOnUpdate: true });

  const closeDialog = () => { setDialog(null); setAvatarMsg(''); setPasswordMsg(''); setLogoutMsg(''); setLogoutBusy(false); setAvatarFile(null); setPasswordCode(''); setPasswordCooldown(0); setPasswordCodeSending(false); setNewPassword(''); setConfirmPassword(''); };
  const openDialog = (nextDialog: Exclude<Dialog, null>) => { dialogReturnFocusRef.current = avatarButtonRef.current; setOpen(false); setDialog(nextDialog); };

  useEffect(() => {
    if (!dialog) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeDialog();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const element = dialogReturnFocusRef.current;
      dialogReturnFocusRef.current = null;
      if (element?.isConnected) window.requestAnimationFrame(() => element.focus({ preventScroll: true }));
    };
  }, [dialog]);

  async function submitLogout() {
    if (logoutBusy) return;
    setLogoutMsg('');
    setLogoutBusy(true);
    try {
      if (onLogout) {
        await onLogout();
        closeDialog();
        return;
      }
      await api.logout();
      window.location.reload();
      closeDialog();
    } catch (error) {
      setLogoutMsg(error instanceof Error ? error.message : '退出登录失败');
    } finally {
      setLogoutBusy(false);
    }
  }

  async function submitAvatar(e: React.FormEvent) {
    e.preventDefault();
    setAvatarMsg('');
    if (!avatarFile) return setAvatarMsg('请选择头像图片');
    if (!avatarFile.type.startsWith('image/')) return setAvatarMsg('仅支持图片文件');
    if (avatarFile.size > 2 * 1024 * 1024) return setAvatarMsg('头像不能超过 2MB');
    setAvatarBusy(true);
    try {
      const result = await api.updateAvatar(avatarFile);
      onUserChange({ ...user, ...result.user });
      setAvatarMsg('修改成功');
      window.setTimeout(closeDialog, 650);
    } catch (error) {
      setAvatarMsg(error instanceof Error ? error.message : '头像上传失败');
    } finally {
      setAvatarBusy(false);
    }
  }

  async function sendPasswordCode() {
    if (passwordCodeSending || passwordCooldown > 0) return;
    setPasswordMsg('');
    setPasswordCodeSending(true);
    try {
      await api.sendPasswordChangeCode();
      setPasswordCooldown(60);
      setPasswordMsg('验证码已发送到当前绑定邮箱');
    } catch (error) {
      setPasswordMsg(error instanceof Error ? error.message : '验证码发送失败');
    } finally {
      setPasswordCodeSending(false);
    }
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordMsg('');
    if (!/^\d{6}$/.test(passwordCode.trim())) return setPasswordMsg('请输入 6 位邮箱验证码');
    if (passwordMismatch) return setPasswordMsg('两次新密码不一致');
    if (newPassword.length < 8) return setPasswordMsg('新密码至少 8 位');
    setPasswordBusy(true);
    try {
      await api.changePassword({ code: passwordCode.trim(), newPassword, confirmPassword });
      setPasswordMsg('修改成功');
      window.setTimeout(() => window.location.reload(), 650);
    } catch (error) {
      setPasswordMsg(error instanceof Error ? error.message : '修改失败');
    } finally {
      setPasswordBusy(false);
    }
  }

  return <div className="profile-root" ref={rootRef}>
    <button
      ref={avatarButtonRef}
      type="button"
      className="avatar-button"
      aria-label="用户菜单"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      onClick={() => setOpen(value => !value)}
    >
      {user.avatar_url ? <img src={user.avatar_url} alt="头像" /> : <span>{initials}</span>}
    </button>
    {open && <div className="profile-menu" id={menuId} ref={menuRef} role="menu" aria-label="用户菜单">
      <button type="button" role="menuitem" onClick={() => openDialog('avatar')}>更改头像</button>
      <button type="button" role="menuitem" onClick={() => openDialog('password')}>更改密码</button>
      <button type="button" role="menuitem" onClick={() => openDialog('token')}>token消耗</button>
      <button type="button" role="menuitem" onClick={() => openDialog('image')}>生图消耗</button>
      <button type="button" role="menuitem" onClick={() => openDialog('logout')}><LogOut size={16} aria-hidden="true" />退出</button>
    </div>}
    {dialog && createPortal(<div className="modal-backdrop" onPointerDown={event => { if (event.target === event.currentTarget && !(dialog === 'logout' && logoutBusy)) closeDialog(); }}>
      <section
        className={`profile-modal${isUsageDialog(dialog) ? ' usage-dialog' : ''}`}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogTitleId}
        onPointerDown={event => event.stopPropagation()}
      >
        <header>
          <strong id={dialogTitleId}>{dialogTitles[dialog]}</strong>
          <button type="button" className="icon-button" onClick={closeDialog} disabled={dialog === 'logout' && logoutBusy} aria-label={`关闭${dialogTitles[dialog]}`} title="关闭"><X size={19} /></button>
        </header>
        {dialog === 'avatar' ? <form onSubmit={submitAvatar}>
          <label className="avatar-drop">
            {avatarFile ? <span>{avatarFile.name}</span> : <span>选择 2MB 以下图片</span>}
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => setAvatarFile(e.target.files?.[0] || null)} />
          </label>
          {avatarMsg && <div className={avatarMsg === '修改成功' ? 'hint' : 'error'}>{avatarMsg}</div>}
          <button disabled={avatarBusy}>{avatarBusy ? '提交中' : '提交'}</button>
        </form> : dialog === 'password' ? <form onSubmit={submitPassword}>
          <p className="password-email-note">验证码将发送到 <strong>{user.email}</strong></p>
          <div className="password-code-row"><label className="auth-field"><span>邮箱验证码</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6 位验证码" value={passwordCode} onChange={e => setPasswordCode(e.target.value.replace(/\D/g, '').slice(0, 6))} /></label><button type="button" onClick={() => { void sendPasswordCode(); }} disabled={passwordCodeSending || passwordCooldown > 0}>{passwordCodeSending ? '发送中' : passwordCooldown > 0 ? `${passwordCooldown}s` : '发送验证码'}</button></div>
          <label className="auth-field"><span>新密码</span><input type="password" autoComplete="new-password" placeholder="密码至少 8 位" value={newPassword} onChange={e => setNewPassword(e.target.value)} /></label>
          <label className="auth-field"><span>确认新密码</span><input type="password" autoComplete="new-password" placeholder="再次输入新密码" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} /></label>
          {passwordMismatch && <div className="error">两次新密码不一致</div>}
          {passwordMsg && <div className={passwordMsg === '修改成功' ? 'hint' : 'error'}>{passwordMsg}</div>}
          <button disabled={passwordBusy || passwordCodeSending || passwordMismatch}>{passwordBusy ? '修改中' : '提交'}</button>
        </form> : dialog === 'logout' ? <div className="logout-confirm">
          <p>确定退出当前账号吗？你的会话工作区和文件会保留。</p>
          {logoutMsg && <div className="error" role="alert">{logoutMsg}</div>}
          <div className="logout-confirm__actions"><button type="button" className="secondary" onClick={closeDialog} disabled={logoutBusy}>取消</button><button type="button" className="danger-button" onClick={() => { void submitLogout(); }} disabled={logoutBusy}>{logoutBusy ? '退出中' : '确认退出'}</button></div>
        </div> : <UsageDialog kind={dialog} />}
      </section>
    </div>, document.body)}
  </div>;
}
