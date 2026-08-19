import { useLayoutEffect, useRef, useState } from 'react';
import { Save, X } from 'lucide-react';
import { gsap } from 'gsap';
import type { MessageImage } from './messageContent';

type Props = {
  initialText: string;
  images: MessageImage[];
  disabled?: boolean;
  onCancel: () => void;
  onConfirm: (text: string) => void;
};

function reducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function InlineMessageEditor({ initialText, images, disabled, onCancel, onConfirm }: Props) {
  const [text, setText] = useState(initialText);
  const [closing, setClosing] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const finishRef = useRef<(() => void) | null>(null);
  const canConfirm = Boolean(text.trim() || images.length);

  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    if (reducedMotion()) {
      if (closing) finishRef.current?.();
      else textareaRef.current?.focus();
      return;
    }
    const ctx = gsap.context(() => {
      if (closing) {
        gsap.to(node, { height: 0, autoAlpha: 0, duration: 0.18, ease: 'power2.in', onComplete: () => finishRef.current?.() });
      } else {
        gsap.fromTo(node, { height: 0, autoAlpha: 0 }, { height: 'auto', autoAlpha: 1, duration: 0.24, ease: 'power2.out', onComplete: () => textareaRef.current?.focus() });
      }
    }, node);
    return () => ctx.revert();
  }, [closing]);

  function finish(action: () => void) {
    if (closing) return;
    finishRef.current = action;
    if (reducedMotion()) action();
    else setClosing(true);
  }

  return (
    <div className="inline-message-editor" ref={rootRef}>
      {images.length > 0 && <div className="inline-editor-images" aria-label="原消息图片">
        {images.map(image => <img key={image.src} src={image.src} alt={image.alt} />)}
      </div>}
      <textarea
        ref={textareaRef}
        rows={5}
        value={text}
        disabled={disabled || closing}
        aria-label="编辑消息内容"
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') finish(onCancel);
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && canConfirm && !disabled) finish(() => onConfirm(text.trim()));
        }}
      />
      <div className="inline-editor-actions">
        <button type="button" className="message-editor-btn cancel" disabled={disabled || closing} onClick={() => finish(onCancel)} aria-label="取消编辑" title="取消编辑">
          <X size={15} aria-hidden="true" />
          <span>取消</span>
        </button>
        <button type="button" className="message-editor-btn save" disabled={disabled || closing || !canConfirm} onClick={() => finish(() => onConfirm(text.trim()))} aria-label="确认编辑" title="确认编辑">
          <Save size={15} aria-hidden="true" />
          <span>确认</span>
        </button>
      </div>
    </div>
  );
}
