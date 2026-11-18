import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { reasoningEffort } from '../../shared/api/client';
import { gsap } from 'gsap';
import { Check, ChevronDown, FolderOpen, X } from 'lucide-react';
import { FileTypeIcon } from '../messages/fileTypeIcon';
import type { AttachmentDTO } from '../../shared/types';
import { UPLOAD_DESCRIPTION } from '../../shared/upload-types';
import ImageUploader from './ImageUploader';

function reducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const effortOptions = ['low', 'high', 'max'] as const;

function EffortMeter({ level }: { level: number }) {
  return <span className="reasoning-effort__meter" aria-hidden="true">
    {[1, 2, 3].map(bar => <span key={bar} className={bar <= level ? 'is-active' : undefined} />)}
  </span>;
}

function ReasoningEffortSelect() {
  const [effort, setEffort] = useState(reasoningEffort);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selectedIndex = effortOptions.findIndex(option => option === effort);
  const close = () => { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); };
  const choose = (index: number) => {
    const next = effortOptions[index];
    setEffort(next);
    try { localStorage.setItem('chat-lite:reasoning-effort', next); } catch { /* ignore unavailable storage */ }
    close();
  };
  const show = (index = selectedIndex) => {
    setActiveIndex(index);
    setPosition(null);
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const place = () => {
      const rect = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
      const topEdge = (viewport?.offsetTop ?? 0) + 8;
      const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 16;
      const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 16;
      const width = Math.min(164, rightEdge - leftEdge);
      const height = menu.scrollHeight + 2;
      const above = Math.max(0, rect.top - topEdge - 8);
      const below = Math.max(0, bottomEdge - rect.bottom - 8);
      const upwards = above >= height || above >= below;
      const maxHeight = upwards ? above : below;
      setPosition({
        left: Math.max(leftEdge, Math.min(rect.right - width, rightEdge - width)),
        top: upwards ? rect.top - 8 - Math.min(height, maxHeight) : rect.bottom + 8,
        width,
        maxHeight,
      });
    };
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && !trigger.contains(event.target) && !menu.contains(event.target)) setOpen(false);
    };
    place();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    observer?.observe(trigger);
    if (trigger.parentElement) observer?.observe(trigger.parentElement);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const option = menu?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    if (!menu || !option) return;
    const top = option.offsetTop;
    const bottom = top + option.offsetHeight;
    if (top < menu.scrollTop) menu.scrollTop = top;
    else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
  }, [open, activeIndex]);

  return <>
    <button ref={triggerRef} type="button" className="reasoning-effort" role="combobox" aria-label={`Reasoning effort: ${effort}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
      onClick={() => open ? close() : show()}
      onKeyDown={event => {
        const { key } = event;
        if (key === 'Tab') { setOpen(false); return; }
        if (key === 'Escape') {
          if (open) { event.preventDefault(); event.stopPropagation(); close(); }
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (key === 'Enter' || key === ' ') { if (open) choose(activeIndex); else show(); return; }
        const index = key === 'Home' ? 0 : key === 'End' ? effortOptions.length - 1
          : open ? Math.max(0, Math.min(effortOptions.length - 1, activeIndex + (key === 'ArrowDown' ? 1 : -1))) : selectedIndex;
        if (open) setActiveIndex(index); else show(index);
      }}>
      <EffortMeter level={selectedIndex + 1} />
      <span>{effort}</span>
      <ChevronDown className="reasoning-effort__chevron" size={12} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={menuRef} id={listId} className="reasoning-effort-menu" role="listbox" aria-label="Reasoning effort"
      style={{ ...position, visibility: position ? 'visible' : 'hidden' }}>
      {effortOptions.map((option, index) => <div key={option} id={`${listId}-${index}`} role="option" aria-selected={effort === option} data-index={index}
        className={`reasoning-effort-option${activeIndex === index ? ' is-active' : ''}`}
        onPointerMove={() => setActiveIndex(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
        <EffortMeter level={index + 1} />
        <span>{option}</span>
        {effort === option && <Check size={15} strokeWidth={2} aria-hidden="true" />}
      </div>)}
    </div>, document.body)}
  </>;
}

export default function MessageInput({ disabled, sending, refillText, refillKey, pending, onSend, onCancel, onImage, onRemoveImage, onPreviewImage, conversationId, onWorkspace }: { disabled?: boolean; sending?: boolean; refillText?: string; refillKey?: number; pending: AttachmentDTO[]; onSend: (text: string) => void; onCancel?: () => void; onImage: (file: File) => void | Promise<void>; onRemoveImage: (id: string) => void; onPreviewImage: (src: string, alt: string) => void; conversationId?: string; onWorkspace?: () => void }) {
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
    if (!animate || reducedMotion() || Math.abs(currentHeight - targetHeight) < 0.5) {
      node.style.height = node.value ? `${targetHeight}px` : '';
      return;
    }

    node.style.height = `${currentHeight}px`;
    tweenRef.current = gsap.to(node, {
      height: targetHeight,
      duration: 0.18,
      ease: 'power1.out',
      overwrite: 'auto',
      onComplete: () => {
        tweenRef.current = null;
        if (!node.value) node.style.height = '';
      }
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
    Array.from(files).forEach(file => void onImage(file));
  };
  const submit = () => {
    if (sending) { onCancel?.(); return; }
    const v = text.trim();
    if (v || pending.length) { onSend(v); setText(''); }
  };
  return <form
    className={dragging ? 'composer chat-composer dragging' : 'composer chat-composer'}
    onSubmit={e => { e.preventDefault(); submit(); }}
    onPaste={e => {
      const files = Array.from(e.clipboardData.files);
      if (files.length) { e.preventDefault(); addFiles(files); }
    }}
    onDragOver={e => { e.preventDefault(); setDragging(true); }}
    onDragLeave={() => setDragging(false)}
    onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
  >
    {pending.length > 0 && <div className="pending-images">{pending.map(a => {
      const isImage = a.mime_type.startsWith('image/');
      if (isImage) return <div className="attach-thumb" key={a.id}>
        <img src={a.public_path} alt={a.original_name} draggable={false} onClick={() => onPreviewImage(a.public_path, a.original_name)} onDoubleClick={() => onPreviewImage(a.public_path, a.original_name)} />
        <button type="button" className="attach-thumb__remove" aria-label={`移除图片 ${a.original_name}`} title="移除" onClick={() => onRemoveImage(a.id)} onDoubleClick={event => event.stopPropagation()}><X size={12} /></button>
      </div>;
      return <button className="pending-file" type="button" key={a.id} aria-label={`移除文件 ${a.original_name}`} onClick={() => onRemoveImage(a.id)}>
        <FileTypeIcon name={a.original_name} size={28} />
        <small>{a.original_name}</small>
        <span>×</span>
      </button>;
    })}</div>}
    <div className="prompt-card">
      <textarea
        ref={textareaRef}
        className="prompt-card__field chat-prompt"
        rows={1}
        aria-label="输入消息"
        placeholder={`输入消息，或粘贴/拖入${UPLOAD_DESCRIPTION}`}
        value={text}
        disabled={disabled && !sending}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !sending) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
      />
      <div className="prompt-card__toolbar">
        <div className="chat-composer__tools">
          <ImageUploader onFile={onImage} />
          <button type="button" className="workspace-trigger" onClick={onWorkspace || (() => window.dispatchEvent(new Event('chat-lite-open-workspace')))}><FolderOpen size={16} aria-hidden="true" /><span>工作区</span></button>
        </div>
        <div className="chat-composer__actions">
          <ReasoningEffortSelect />
          <button className={sending ? 'send-button sending' : 'send-button'} type="submit" disabled={!sending && (disabled || !hasContent)} aria-label={sending ? '取消生成' : '发送消息'}>{sending ? <><span className="send-spinner" aria-hidden="true" />取消</> : '发送'}</button>
        </div>
      </div>
    </div>
  </form>;
}
