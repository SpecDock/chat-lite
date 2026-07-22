import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import type { AttachmentDTO } from '../../../shared/types';
import ImageUploader from './ImageUploader';

function reducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function MessageInput({ disabled, sending, refillText, refillKey, pending, onSend, onCancel, onImage, onRemoveImage }: { disabled?: boolean; sending?: boolean; refillText?: string; refillKey?: number; pending: AttachmentDTO[]; onSend: (text: string) => void; onCancel?: () => void; onImage: (file: File) => void | Promise<void>; onRemoveImage: (id: string) => void }) {
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const tweenRef = useRef<gsap.core.Tween | null>(null);
  const measuredRef = useRef(false);
  const hasContent = Boolean(text.trim() || pending.length);
  useEffect(() => {
    if (refillText !== undefined) setText(refillText);
  }, [refillText, refillKey]);
  const syncTextareaHeight = useCallback((animate: boolean) => {
    const node = textareaRef.current;
    if (!node) return;

    tweenRef.current?.kill();
    tweenRef.current = null;
    const currentHeight = node.getBoundingClientRect().height;
    const styles = window.getComputedStyle(node);
    const borderHeight = parseFloat(styles.borderTopWidth) + parseFloat(styles.borderBottomWidth);
    const minHeight = parseFloat(styles.minHeight) || 0;
    const maxHeightValue = parseFloat(styles.maxHeight);
    const maxHeight = Number.isFinite(maxHeightValue) ? maxHeightValue : Number.POSITIVE_INFINITY;

    node.style.height = 'auto';
    const naturalHeight = node.scrollHeight + borderHeight;
    const lowerBound = Math.min(minHeight, maxHeight);
    const targetHeight = Math.min(Math.max(naturalHeight, lowerBound), maxHeight);
    const overflowing = naturalHeight > maxHeight + 0.5;
    node.style.overflowY = overflowing ? 'auto' : 'hidden';
    if (!overflowing) node.scrollTop = 0;
    node.style.height = `${currentHeight}px`;

    if (!animate || reducedMotion() || Math.abs(currentHeight - targetHeight) < 0.5) {
      gsap.set(node, { height: targetHeight });
      return;
    }

    tweenRef.current = gsap.to(node, {
      height: targetHeight,
      duration: 0.18,
      ease: 'power1.out',
      overwrite: 'auto',
      onComplete: () => { tweenRef.current = null; }
    });
  }, []);

  useLayoutEffect(() => {
    syncTextareaHeight(measuredRef.current);
    measuredRef.current = true;
    return () => {
      tweenRef.current?.kill();
      tweenRef.current = null;
    };
  }, [syncTextareaHeight, text]);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    const container = node.closest('.chat') || node.parentElement || node;
    let frame = 0;
    const initialRect = container.getBoundingClientRect();
    let lastSize = { width: initialRect.width, height: initialRect.height };
    const scheduleViewportResize = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => syncTextareaHeight(false));
    };
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(entries => {
        const rect = entries[0]?.contentRect ?? container.getBoundingClientRect();
        if (Math.abs(rect.width - lastSize.width) < 0.5 && Math.abs(rect.height - lastSize.height) < 0.5) return;
        lastSize = { width: rect.width, height: rect.height };
        syncTextareaHeight(false);
      })
      : null;
    observer?.observe(container);
    window.addEventListener('resize', scheduleViewportResize);
    window.visualViewport?.addEventListener('resize', scheduleViewportResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', scheduleViewportResize);
      window.visualViewport?.removeEventListener('resize', scheduleViewportResize);
      window.cancelAnimationFrame(frame);
    };
  }, [syncTextareaHeight]);

  const addFiles = (files: FileList | File[]) => {
    Array.from(files).filter(file => file.type.startsWith('image/')).forEach(file => void onImage(file));
  };
  const submit = () => {
    if (sending) { onCancel?.(); return; }
    const v = text.trim();
    if (v || pending.length) { onSend(v); setText(''); }
  };
  return <form
    className={dragging ? 'composer dragging' : 'composer'}
    onSubmit={e => { e.preventDefault(); submit(); }}
    onPaste={e => {
      const files = Array.from(e.clipboardData.files).filter(file => file.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); addFiles(files); }
    }}
    onDragOver={e => { e.preventDefault(); setDragging(true); }}
    onDragLeave={() => setDragging(false)}
    onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
  >
    {pending.length > 0 && <div className="pending-images">{pending.map(a => <button type="button" key={a.id} aria-label="移除图片" onClick={() => onRemoveImage(a.id)}><img src={a.public_path} alt={a.original_name} /><span>×</span></button>)}</div>}
    <div className="input"><ImageUploader onFile={onImage} /><textarea ref={textareaRef} rows={1} placeholder="输入消息，或粘贴/拖入图片" value={text} disabled={disabled && !sending} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !sending) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} /><button className={sending ? 'send-button sending' : 'send-button'} type="submit" disabled={!sending && (disabled || !hasContent)} aria-label={sending ? '取消生成' : '发送消息'}>{sending ? <><span className="send-spinner" aria-hidden="true" />取消</> : '发送'}</button></div>
  </form>;
}
