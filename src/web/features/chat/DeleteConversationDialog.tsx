import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, TriangleAlert, X } from 'lucide-react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import type { ConversationDTO } from '../../../shared/types';

gsap.registerPlugin(useGSAP);

type Props = {
  open: boolean;
  conversation: ConversationDTO;
  trigger: HTMLButtonElement;
  streaming: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
};

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function DeleteConversationDialog({ open, conversation, trigger, streaming, onClose, onConfirm }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
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
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus({ preventScroll: true }));
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
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled])')]
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

  async function confirm() {
    if (streaming) return;
    setSubmitting(true);
    setError('');
    try {
      await onConfirm();
      closingRef.current = true;
      setClosing(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败，请重试');
      setSubmitting(false);
    }
  }

  return createPortal(
    <div className="conversation-dialog-overlay" ref={overlayRef} onMouseDown={event => {
      if (event.target === event.currentTarget) requestClose();
    }}>
      <section className="conversation-dialog delete-conversation-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="delete-conversation-title" aria-describedby="delete-conversation-description">
        <div className="delete-conversation-icon" aria-hidden="true"><TriangleAlert size={20} /></div>
        <div className="delete-conversation-copy">
          <h2 id="delete-conversation-title">删除“{conversation.title}”？</h2>
          <p id="delete-conversation-description">将删除该会话的消息、附件和RAG记录，此操作不可撤销。</p>
          {streaming && <p className="delete-conversation-streaming" role="status">请先停止生成</p>}
        </div>
        {error && <p className="conversation-dialog-error delete-conversation-error" role="alert">{error}</p>}
        <div className="conversation-dialog-actions delete-conversation-actions">
          <button ref={cancelRef} type="button" className="dialog-cancel" disabled={submitting || closing} onClick={requestClose}>
            <X size={16} aria-hidden="true" />
            <span>取消</span>
          </button>
          <button type="button" className="conversation-dialog-delete" disabled={streaming || submitting || closing} onClick={() => void confirm()}>
            <Trash2 size={16} aria-hidden="true" />
            <span>{submitting ? '删除中' : '删除会话'}</span>
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}
