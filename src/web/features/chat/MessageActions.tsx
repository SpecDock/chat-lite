import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Pencil, Trash2 } from 'lucide-react';
import { gsap } from 'gsap';

type Props = {
  text: string;
  isUser?: boolean;
  disabled?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
};

function reducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function MessageActions({ text, isUser, disabled, onEdit, onDelete }: Props) {
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const copyRef = useRef<HTMLButtonElement | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const node = rootRef.current;
    if (!node || reducedMotion()) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        '.message-action-btn',
        { autoAlpha: 0, y: 4 },
        { autoAlpha: 1, y: 0, duration: 0.28, ease: 'power2.out', stagger: 0.035, delay: 0.06 }
      );
    }, node);
    return () => ctx.revert();
  }, []);

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  function flashCopy() {
    setCopied(true);
    if (copyRef.current && !reducedMotion()) {
      const ctx = gsap.context(() => {
        gsap.fromTo(copyRef.current, { scale: 0.9 }, { scale: 1, duration: 0.2, ease: 'back.out(2)' });
      }, copyRef);
      window.setTimeout(() => ctx.revert(), 240);
    }
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, 1800);
  }

  async function handleCopy() {
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      flashCopy();
    } catch (error) {
      console.warn('[chat-lite] copy failed', error);
    }
  }

  return (
    <div className="message-actions" ref={rootRef} aria-label={isUser ? '用户消息操作' : '助手消息操作'}>
      <button
        ref={copyRef}
        type="button"
        className={`message-action-btn ${copied ? 'is-copied' : ''}`}
        onClick={handleCopy}
        aria-label={copied ? '已复制' : '复制消息'}
        title={copied ? '已复制' : '复制消息'}
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        <span>{copied ? '已复制' : '复制'}</span>
      </button>
      {isUser && <>
        <button type="button" className="message-action-btn" disabled={disabled} onClick={onEdit} aria-label="编辑消息" title="编辑消息">
          <Pencil size={14} aria-hidden="true" />
          <span>编辑</span>
        </button>
        <button type="button" className="message-action-btn danger" disabled={disabled} onClick={onDelete} aria-label="删除消息" title="删除消息">
          <Trash2 size={14} aria-hidden="true" />
          <span>删除</span>
        </button>
      </>}
    </div>
  );
}
