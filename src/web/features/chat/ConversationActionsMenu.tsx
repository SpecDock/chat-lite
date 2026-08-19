import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Ellipsis, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import type { ConversationDTO } from '../../../shared/types';
import type { ConversationActivity } from './conversationActivity';

gsap.registerPlugin(useGSAP);

type Direction = 'up' | 'down';

type RectSnapshot = {
  top: number;
  left: number;
  width: number;
  height: number;
};

type Placement = {
  top: number;
  left: number;
  mobile: boolean;
  direction: Direction;
  rowRect: RectSnapshot;
};

type Props = {
  id: string;
  conversation: ConversationDTO;
  activity?: ConversationActivity;
  trigger: HTMLButtonElement;
  row: HTMLDivElement;
  pinDisabled: boolean;
  onClose: () => void;
  onPin: () => void;
  onRename: () => void;
  onDelete: () => void;
};

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function snapshot(rect: DOMRect): RectSnapshot {
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function calculatePlacement(trigger: HTMLElement, row: HTMLElement, menuHeight = 152, menuWidth = 196): Placement {
  const mobile = window.matchMedia('(max-width: 799px)').matches;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight;
  const triggerRect = trigger.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const margin = mobile ? 12 : 8;
  const gap = mobile ? 7 : 6;

  if (mobile) {
    const spaceBelow = viewportHeight - rowRect.bottom - margin - gap;
    const direction: Direction = spaceBelow >= menuHeight ? 'down' : 'up';
    const preferredTop = direction === 'down'
      ? rowRect.bottom + gap
      : rowRect.top - gap - menuHeight;
    return {
      top: Math.max(margin, Math.min(preferredTop, viewportHeight - margin - menuHeight)),
      left: margin,
      mobile,
      direction,
      rowRect: snapshot(rowRect),
    };
  }

  const spaceBelow = viewportHeight - triggerRect.top - margin;
  const direction: Direction = spaceBelow >= menuHeight ? 'down' : 'up';
  const preferredTop = direction === 'down'
    ? triggerRect.top
    : triggerRect.bottom - menuHeight;
  const rightwardLeft = triggerRect.right + gap;
  const preferredLeft = rightwardLeft + menuWidth <= viewportWidth - margin
    ? rightwardLeft
    : triggerRect.left - gap - menuWidth;

  return {
    top: Math.max(margin, Math.min(preferredTop, viewportHeight - margin - menuHeight)),
    left: Math.max(margin, Math.min(preferredLeft, viewportWidth - margin - menuWidth)),
    mobile,
    direction,
    rowRect: snapshot(rowRect),
  };
}

export function ConversationSummary({ conversation, activity, decorative = false }: {
  conversation: ConversationDTO;
  activity?: ConversationActivity;
  decorative?: boolean;
}) {
  return <>
    {activity?.status === 'streaming' && <span className="conv-status-spinner" role={decorative ? undefined : 'status'} aria-label={decorative ? undefined : '正在生成'} aria-hidden={decorative || undefined} />}
    {activity?.unread && activity.status === 'completed' && <span className="conv-status-dot" role={decorative ? undefined : 'status'} aria-label={decorative ? undefined : '生成完成，有未读消息'} aria-hidden={decorative || undefined} />}
    {activity?.unread && activity.status === 'error' && <span className="conv-status-dot error" role={decorative ? undefined : 'status'} aria-label={decorative ? undefined : '生成失败，有未读消息'} aria-hidden={decorative || undefined} />}
    <span className="conv-title-group">
      {conversation.pinned_at && <>
        <Pin className="conv-pin" size={13} strokeWidth={1.8} aria-hidden="true" />
        {!decorative && <span className="sr-only">已置顶</span>}
      </>}
      <span className="conv-title" title={conversation.title}>{conversation.title}</span>
    </span>
  </>;
}

export default function ConversationActionsMenu({
  id,
  conversation,
  activity,
  trigger,
  row,
  pinDisabled,
  onClose,
  onPin,
  onRename,
  onDelete,
}: Props) {
  const [closing, setClosing] = useState(false);
  const [placement, setPlacement] = useState(() => calculatePlacement(trigger, row));
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const focusRowRef = useRef<HTMLDivElement | null>(null);
  const closingRef = useRef(false);
  const pendingCloseRef = useRef<{ restoreFocus: boolean; afterClose?: () => void }>({ restoreFocus: true });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const finishClose = useCallback(() => {
    const pending = pendingCloseRef.current;
    onCloseRef.current();
    pending.afterClose?.();
    if (pending.restoreFocus) {
      window.requestAnimationFrame(() => {
        if (trigger.isConnected) trigger.focus({ preventScroll: true });
      });
    }
  }, [trigger]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    setPlacement(calculatePlacement(trigger, row, menu.offsetHeight, menu.offsetWidth));
    const frame = window.requestAnimationFrame(() => {
      const firstItem = menu.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
      firstItem?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [row, trigger]);

  const { contextSafe } = useGSAP(() => {
    const menu = menuRef.current;
    const scrim = scrimRef.current;
    const focusRow = focusRowRef.current;
    if (!menu || !scrim) return;
    const reduce = reducedMotion();
    const targets = focusRow ? [scrim, focusRow, menu] : [scrim, menu];
    gsap.killTweensOf(targets);

    if (closing) {
      gsap.to(menu, {
        autoAlpha: 0,
        scale: 0.98,
        y: placement.direction === 'down' ? -3 : 3,
        duration: reduce ? 0 : 0.12,
        ease: 'power2.in',
        overwrite: true,
      });
      if (focusRow) gsap.to(focusRow, { autoAlpha: 0, scale: 0.995, duration: reduce ? 0 : 0.1, ease: 'power1.in', overwrite: true });
      gsap.to(scrim, { autoAlpha: 0, duration: reduce ? 0 : 0.12, ease: 'power1.in', overwrite: true, onComplete: finishClose });
    } else {
      gsap.fromTo(scrim, { autoAlpha: 0 }, { autoAlpha: 1, duration: reduce ? 0 : 0.16, ease: 'power1.out', overwrite: true });
      if (focusRow) {
        gsap.fromTo(focusRow, { autoAlpha: 0, scale: 0.992 }, {
          autoAlpha: 1,
          scale: 1,
          duration: reduce ? 0 : 0.18,
          ease: 'power2.out',
          overwrite: true,
        });
      }
      gsap.fromTo(menu, {
        autoAlpha: 0,
        scale: 0.97,
        y: placement.direction === 'down' ? -6 : 6,
      }, {
        autoAlpha: 1,
        scale: 1,
        y: 0,
        duration: reduce ? 0 : 0.18,
        ease: 'power2.out',
        overwrite: true,
      });
    }

    return () => gsap.killTweensOf(targets);
  }, { scope: overlayRef, dependencies: [closing, finishClose, placement.direction], revertOnUpdate: true });

  const requestClose = contextSafe((restoreFocus = true, afterClose?: () => void) => {
    if (closingRef.current) return;
    closingRef.current = true;
    pendingCloseRef.current = { restoreFocus, afterClose };
    setClosing(true);
  });

  useEffect(() => {
    const closeForLayoutChange = () => requestClose();
    const list = row.closest('.conv-list');
    window.addEventListener('resize', closeForLayoutChange);
    window.addEventListener('orientationchange', closeForLayoutChange);
    list?.addEventListener('scroll', closeForLayoutChange, { passive: true });
    return () => {
      window.removeEventListener('resize', closeForLayoutChange);
      window.removeEventListener('orientationchange', closeForLayoutChange);
      list?.removeEventListener('scroll', closeForLayoutChange);
    };
  }, [requestClose, row]);

  const focusItem = (current: HTMLElement | null, offset: number) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])];
    if (!items.length) return;
    const currentIndex = current ? items.indexOf(current as HTMLButtonElement) : -1;
    const nextIndex = currentIndex < 0
      ? (offset < 0 ? items.length - 1 : 0)
      : (currentIndex + offset + items.length) % items.length;
    items[nextIndex].focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      requestClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusItem(document.activeElement as HTMLElement | null, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])];
      (event.key === 'Home' ? items[0] : items[items.length - 1])?.focus();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      focusItem(document.activeElement as HTMLElement | null, event.shiftKey ? -1 : 1);
    }
  };

  const pinned = Boolean(conversation.pinned_at);

  return createPortal(
    <div className={`conversation-actions-overlay${placement.mobile ? ' is-mobile' : ''}`} ref={overlayRef}>
      <div className="conversation-actions-scrim" ref={scrimRef} onMouseDown={() => requestClose()} />
      {placement.mobile && <div
        className="conversation-actions-focus conv"
        ref={focusRowRef}
        aria-hidden="true"
        style={{
          top: placement.rowRect.top,
          left: placement.rowRect.left,
          width: placement.rowRect.width,
          height: placement.rowRect.height,
        }}
      >
        <ConversationSummary conversation={conversation} activity={activity} decorative />
        <span className="conversation-menu-copy-trigger"><Ellipsis size={19} aria-hidden="true" /></span>
      </div>}
      <div
        id={id}
        className={`conversation-actions-menu${placement.mobile ? ' is-mobile' : ''}`}
        ref={menuRef}
        role="menu"
        aria-label={`${conversation.title}的会话操作`}
        data-direction={placement.direction}
        onKeyDown={handleKeyDown}
        style={{
          top: placement.top,
          ...(placement.mobile ? {} : { left: placement.left }),
          transformOrigin: placement.direction === 'down' ? 'top left' : 'bottom left',
        }}
      >
        <button type="button" role="menuitem" disabled={pinDisabled || closing} onClick={() => {
          requestClose();
          onPin();
        }}>
          {pinned ? <PinOff size={17} aria-hidden="true" /> : <Pin size={17} aria-hidden="true" />}
          <span>{pinned ? '取消置顶' : '置顶'}</span>
        </button>
        <button type="button" role="menuitem" disabled={closing} onClick={() => requestClose(false, onRename)}>
          <Pencil size={17} aria-hidden="true" />
          <span>重命名</span>
        </button>
        <button type="button" role="menuitem" className="danger" disabled={closing} onClick={() => requestClose(false, onDelete)}>
          <Trash2 size={17} aria-hidden="true" />
          <span>删除</span>
        </button>
      </div>
    </div>,
    document.body
  );
}
