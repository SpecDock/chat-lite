import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from 'lucide-react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import type { ConversationDTO } from '../../../shared/types';

gsap.registerPlugin(useGSAP);

type Props = {
  open: boolean;
  conversation: ConversationDTO;
  trigger: HTMLButtonElement;
  onClose: () => void;
  onConfirm: (title: string) => Promise<void>;
};

function normalizeTitle(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function RenameConversationDialog({ open, conversation, trigger, onClose, onConfirm }: Props) {
  const [title, setTitle] = useState(conversation.title);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [closing, setClosing] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const finishClose = useCallback(() => {
    onCloseRef.current();
    window.requestAnimationFrame(() => {
      if (trigger.isConnected) trigger.focus({ preventScroll: true });
    });
  }, [trigger]);

  const { contextSafe } = useGSAP(() => {
    if (!open) return;
    const overlay = overlayRef.current;
    const dialog = dialogRef.current;
    if (!overlay || !dialog) return;
    const reduce = reducedMotion();
    gsap.killTweensOf([overlay, dialog]);

    if (closing) {
      gsap.to(dialog, { autoAlpha: 0, scale: 0.975, y: 4, duration: reduce ? 0 : 0.14, ease: 'power2.in', overwrite: true });
      gsap.to(overlay, { autoAlpha: 0, duration: reduce ? 0 : 0.15, ease: 'power1.in', overwrite: true, onComplete: finishClose });
    } else {
      gsap.fromTo(overlay, { autoAlpha: 0 }, { autoAlpha: 1, duration: reduce ? 0 : 0.18, ease: 'power1.out', overwrite: true });
      gsap.fromTo(dialog, { autoAlpha: 0, scale: 0.96, y: 8 }, {
        autoAlpha: 1,
        scale: 1,
        y: 0,
        duration: reduce ? 0 : 0.22,
        ease: 'power2.out',
        overwrite: true,
      });
    }

    return () => gsap.killTweensOf([overlay, dialog]);
  }, { scope: overlayRef, dependencies: [closing, finishClose, open], revertOnUpdate: true });

  const requestClose = contextSafe(() => {
    if (submitting || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
  });

  useLayoutEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled])')]
        .filter(node => node.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, requestClose]);

  if (!open) return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const normalized = normalizeTitle(title);
    if (!normalized) {
      setError('会话名称不能为空');
      inputRef.current?.focus();
      return;
    }
    if (normalized.length > 40) {
      setError('会话名称不能超过 40 个字符');
      inputRef.current?.focus();
      return;
    }

    setTitle(normalized);
    setError('');
    setSubmitting(true);
    try {
      await onConfirm(normalized);
      closingRef.current = true;
      setClosing(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重命名失败，请重试');
      setSubmitting(false);
    }
  }

  const titleErrorId = error ? 'rename-conversation-error' : undefined;

  return createPortal(
    <div className="conversation-dialog-overlay" ref={overlayRef} onMouseDown={event => {
      if (event.target === event.currentTarget) requestClose();
    }}>
      <section className="conversation-dialog rename-conversation-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="rename-conversation-title">
        <header className="conversation-dialog-header">
          <h2 id="rename-conversation-title">重命名会话</h2>
          <button type="button" className="conversation-dialog-close" disabled={submitting || closing} onClick={requestClose} aria-label="关闭重命名弹窗" title="关闭">
            <X size={19} aria-hidden="true" />
          </button>
        </header>
        <form onSubmit={submit} aria-busy={submitting}>
          <label className="conversation-dialog-field" htmlFor="rename-conversation-input">
            <span>会话名称</span>
            <input
              id="rename-conversation-input"
              ref={inputRef}
              value={title}
              disabled={submitting || closing}
              aria-invalid={Boolean(error)}
              aria-describedby={titleErrorId}
              autoComplete="off"
              onChange={event => {
                setTitle(event.target.value);
                if (error) setError('');
              }}
            />
          </label>
          {error && <p className="conversation-dialog-error" id="rename-conversation-error" role="alert">{error}</p>}
          <div className="conversation-dialog-actions">
            <button type="button" className="dialog-cancel" disabled={submitting || closing} onClick={requestClose}>取消</button>
            <button type="submit" className="conversation-dialog-confirm" disabled={submitting || closing}>
              <Check size={16} aria-hidden="true" />
              <span>{submitting ? '保存中' : '确认'}</span>
            </button>
          </div>
        </form>
      </section>
    </div>,
    document.body
  );
}
