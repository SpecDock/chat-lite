import { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';

type Props = {
  text: string;
  className?: string;
  ariaLabel?: string;
};

const ICON_COPY = (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" stroke="currentColor" strokeWidth="1.4" fill="none" />
    <path
      d="M3 11V4a1 1 0 0 1 1-1h7"
      stroke="currentColor"
      strokeWidth="1.4"
      fill="none"
      strokeLinecap="round"
    />
  </svg>
);

const ICON_CHECK = (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path
      d="M3.5 8.4l3 3L12.6 5"
      stroke="currentColor"
      strokeWidth="1.8"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default function MessageActions({ text, className, ariaLabel }: Props) {
  const [copied, setCopied] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const node = btnRef.current;
    if (!node) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        node,
        { autoAlpha: 0, y: 4 },
        { autoAlpha: 1, y: 0, duration: 0.28, ease: 'power2.out', delay: 0.08 }
      );
    }, node);
    return () => {
      ctx.revert();
    };
  }, []);

  function flashCopy() {
    setCopied(true);
    if (btnRef.current) {
      gsap.fromTo(
        btnRef.current,
        { scale: 0.88 },
        { scale: 1, duration: 0.22, ease: 'back.out(2.2)' }
      );
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
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      flashCopy();
    } catch (error) {
      console.warn('[chat-lite] copy failed', error);
    }
  }

  return (
    <button
      ref={btnRef}
      type="button"
      className={`copy-btn ${copied ? 'is-copied' : ''} ${className || ''}`.trim()}
      onClick={handleCopy}
      aria-label={ariaLabel || (copied ? '已复制' : '复制消息')}
      title={copied ? '已复制' : '复制消息'}
    >
      <span className="copy-btn-icon">{copied ? ICON_CHECK : ICON_COPY}</span>
      <span className="copy-btn-label">{copied ? '已复制' : '复制'}</span>
    </button>
  );
}