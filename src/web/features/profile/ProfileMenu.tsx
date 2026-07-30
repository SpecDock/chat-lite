import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import type { UserDTO } from '../../../shared/types';
import { api } from '../../shared/api/client';
import UsageDialog, { type UsageKind } from './UsageDialog';

gsap.registerPlugin(useGSAP);

type Dialog = 'avatar' | 'password' | UsageKind | null;

const dialogTitles: Record<Exclude<Dialog, null>, string> = {
  avatar: '更改头像',
  password: '更改密码',
  token: 'Token统计',
  image: '生图统计'
};

function isUsageDialog(dialog: Dialog): dialog is UsageKind {
  return dialog === 'token' || dialog === 'image';
}

export default function ProfileMenu({ user, onUserChange }: { user: UserDTO; onUserChange: (user: UserDTO) => void }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarMsg, setAvatarMsg] = useState('');
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const avatarButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
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

  const closeDialog = () => { setDialog(null); setAvatarMsg(''); setPasswordMsg(''); setAvatarFile(null); setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); };
  const openDialog = (nextDialog: Exclude<Dialog, null>) => { setOpen(false); setDialog(nextDialog); };

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

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordMsg('');
    if (passwordMismatch) return setPasswordMsg('两次新密码不一致');
    if (newPassword.length < 8) return setPasswordMsg('新密码至少 8 位');
    setPasswordBusy(true);
    try {
      await api.changePassword({ currentPassword, newPassword, confirmPassword });
      setPasswordMsg('修改成功');
      window.setTimeout(closeDialog, 650);
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
    </div>}
    {dialog && createPortal(<div className="modal-backdrop" onPointerDown={closeDialog}>
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
          <button type="button" className="icon-button" onClick={closeDialog} aria-label={`关闭${dialogTitles[dialog]}`} title="关闭">×</button>
        </header>
        {dialog === 'avatar' ? <form onSubmit={submitAvatar}>
          <label className="avatar-drop">
            {avatarFile ? <span>{avatarFile.name}</span> : <span>选择 2MB 以下图片</span>}
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => setAvatarFile(e.target.files?.[0] || null)} />
          </label>
          {avatarMsg && <div className={avatarMsg === '修改成功' ? 'hint' : 'error'}>{avatarMsg}</div>}
          <button disabled={avatarBusy}>{avatarBusy ? '提交中' : '提交'}</button>
        </form> : dialog === 'password' ? <form onSubmit={submitPassword}>
          <input type="password" placeholder="新密码" value={newPassword} onChange={e => setNewPassword(e.target.value)} />
          <input type="password" placeholder="确认新密码" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} />
          {passwordMismatch && <div className="error">两次新密码不一致</div>}
          <input type="password" placeholder="原始密码" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} />
          {passwordMsg && <div className={passwordMsg === '修改成功' ? 'hint' : 'error'}>{passwordMsg}</div>}
          <button disabled={passwordBusy || passwordMismatch}>{passwordBusy ? '校验中' : '提交'}</button>
        </form> : <UsageDialog kind={dialog} />}
      </section>
    </div>, document.body)}
  </div>;
}
