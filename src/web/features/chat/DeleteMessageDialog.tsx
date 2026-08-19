import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, X } from 'lucide-react';
import { gsap } from 'gsap';

type Props = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
};

function reducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function DeleteMessageDialog({ open, onClose, onConfirm }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    if (!backdrop || !dialog) return;
    if (reducedMotion()) {
      if (closing) onClose();
      else cancelRef.current?.focus();
      return;
    }
    const ctx = gsap.context(() => {
      if (closing) {
        gsap.to(dialog, { autoAlpha: 0, scale: 0.97, duration: 0.16, ease: 'power2.in' });
        gsap.to(backdrop, { autoAlpha: 0, duration: 0.18, ease: 'power1.in', onComplete: onClose });
      } else {
        gsap.fromTo(backdrop, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2, ease: 'power1.out' });
        gsap.fromTo(dialog, { autoAlpha: 0, scale: 0.96, y: 8 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.24, ease: 'power2.out', onComplete: () => cancelRef.current?.focus() });
      }
    }, backdrop);
    return () => ctx.revert();
  }, [closing, onClose, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) setClosing(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, submitting]);

  if (!open) return null;

  async function confirm() {
    setSubmitting(true);
    setError('');
    try {
      await onConfirm();
      if (reducedMotion()) onClose();
      else setClosing(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败，请重试');
      setSubmitting(false);
    }
  }

  return createPortal(
    <div className="delete-message-backdrop" ref={backdropRef} onMouseDown={event => {
      if (event.target === event.currentTarget && !submitting) setClosing(true);
    }}>
      <div className="delete-message-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="delete-message-title" aria-describedby="delete-message-description">
        <div className="delete-message-icon" aria-hidden="true"><Trash2 size={19} /></div>
        <div className="delete-message-copy">
          <h2 id="delete-message-title">删除这组问答？</h2>
          <p id="delete-message-description">将删除该用户消息、紧随的助手回答和关联图片。此操作不可恢复。</p>
        </div>
        {error && <p className="delete-message-error" role="alert">{error}</p>}
        <div className="delete-message-actions">
          <button ref={cancelRef} type="button" className="dialog-cancel" disabled={submitting || closing} onClick={() => setClosing(true)} aria-label="取消删除" title="取消删除">
            <X size={15} aria-hidden="true" />
            <span>取消</span>
          </button>
          <button type="button" className="dialog-delete" disabled={submitting || closing} onClick={() => void confirm()} aria-label="确认删除消息" title="确认删除消息">
            <Trash2 size={15} aria-hidden="true" />
            <span>{submitting ? '删除中' : '删除'}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
