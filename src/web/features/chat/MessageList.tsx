import { useEffect, useLayoutEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import type { MessageDTO } from '../../shared/types';
import MarkdownMessage from '../messages/MarkdownMessage';
import InlineMessageEditor from './InlineMessageEditor';
import MessageActions from './MessageActions';
import { splitUserMessage } from './messageContent';

function visibleContent(message: MessageDTO): string {
  if (message.role === 'assistant') {
    return String(message.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }
  return String(message.content || '');
}

function safeGetScroll(key: string) {
  try {
    const value = window.localStorage.getItem(key);
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

function safeSetScroll(key: string, value: number) {
  try { window.localStorage.setItem(key, String(Math.max(0, Math.round(value)))); } catch { /* ignore unavailable storage */ }
}

const EDGE_DISTANCE = 72;

function isNearBottom(node: HTMLElement, threshold = EDGE_DISTANCE) {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= threshold;
}

function isNearTop(node: HTMLElement, threshold = EDGE_DISTANCE) {
  return node.scrollTop <= threshold;
}

function canScroll(node: HTMLElement) {
  return node.scrollHeight - node.clientHeight > 1;
}

function messageOffset(root: HTMLElement, id: string) {
  const safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"');
  const node = root.querySelector<HTMLElement>(`[data-message-id="${safeId}"]`);
  return node ? node.offsetTop : null;
}

function describeMessageChange(previousIds: string[], nextIds: string[]) {
  if (previousIds.length === nextIds.length && previousIds.every((id, index) => id === nextIds[index])) return 'same' as const;
  if (previousIds.length === 0 || nextIds.length === 0) return 'replace' as const;
  const firstIndex = nextIds.indexOf(previousIds[0]);
  const lastIndex = nextIds.indexOf(previousIds[previousIds.length - 1]);
  if (firstIndex > 0 && lastIndex === nextIds.length - 1) {
    const suffix = nextIds.slice(firstIndex);
    if (suffix.length === previousIds.length && suffix.every((id, index) => id === previousIds[index])) return 'prepend' as const;
  }
  if (firstIndex === 0 && lastIndex >= 0 && lastIndex < nextIds.length - 1) {
    const prefix = nextIds.slice(0, previousIds.length);
    if (prefix.every((id, index) => id === previousIds[index])) return 'append' as const;
  }
  return 'replace' as const;
}

function hasScrollableAncestor(target: EventTarget | null, root: HTMLElement) {
  let node = target instanceof Element ? target : null;
  while (node && node !== root) {
    if (node instanceof HTMLElement) {
      const overflowY = window.getComputedStyle(node).overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') && node.scrollHeight > node.clientHeight + 1) return true;
    }
    node = node.parentElement;
  }
  return false;
}

gsap.registerPlugin(useGSAP);

type ScrollIntent = 'restore' | 'bottom' | 'follow';

type Props = {
  messages: MessageDTO[];
  conversationId?: string;
  storageKey: string;
  scrollIntent: ScrollIntent;
  editingMessageId?: string;
  actionsDisabled?: boolean;
  editorDisabled?: boolean;
  jumpMessageId?: string;
  jumpReady?: boolean;
  hasOlder?: boolean;
  hasNewer?: boolean;
  bottomNonce?: number;
  onLoadOlder?: () => void;
  onLoadNewer?: () => void;
  onJumpComplete?: (found: boolean) => void;
  onEdit: (message: MessageDTO) => void;
  onCancelEdit: () => void;
  onConfirmEdit: (message: MessageDTO, text: string) => void;
  onDelete: (message: MessageDTO) => void;
  onImageClick?: (src: string, alt: string) => void;
};

export default function MessageList({ messages, conversationId, storageKey, scrollIntent, editingMessageId, actionsDisabled, editorDisabled, jumpMessageId, jumpReady = true, hasOlder = false, hasNewer = false, bottomNonce = 0, onLoadOlder, onLoadNewer, onJumpComplete, onEdit, onCancelEdit, onConfirmEdit, onDelete, onImageClick }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastAnimatedId = useRef<string>('');
  const restoredConversationRef = useRef<string>('');
  const lastScrollSignature = useRef<string>('');
  const previousIntentRef = useRef<ScrollIntent>(scrollIntent);
  const autoFollowRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const edgeQuietUntilRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const seenBottomNonceRef = useRef(bottomNonce);
  const onJumpCompleteRef = useRef(onJumpComplete);
  const onLoadOlderRef = useRef(onLoadOlder);
  const onLoadNewerRef = useRef(onLoadNewer);
  const hasOlderRef = useRef(hasOlder);
  const hasNewerRef = useRef(hasNewer);
  const jumpMessageIdRef = useRef(jumpMessageId);
  const anchorRef = useRef({ conversationId: '', ids: [] as string[], offsetTop: 0, scrollHeight: 0, hasNewer: false });
  onJumpCompleteRef.current = onJumpComplete;
  onLoadOlderRef.current = onLoadOlder;
  onLoadNewerRef.current = onLoadNewer;
  hasOlderRef.current = hasOlder;
  hasNewerRef.current = hasNewer;
  jumpMessageIdRef.current = jumpMessageId;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !conversationId) return;

    const nextIds = messages.map(message => message.id);
    const anchor = anchorRef.current;
    const sameConversation = anchor.conversationId === conversationId;
    const change = sameConversation ? describeMessageChange(anchor.ids, nextIds) : 'replace';
    const enteredFollow = scrollIntent === 'follow' && previousIntentRef.current !== 'follow';
    const forceBottom = bottomNonce !== seenBottomNonceRef.current;
    previousIntentRef.current = scrollIntent;
    if (!sameConversation) autoFollowRef.current = scrollIntent !== 'restore';

    const latest = messages[messages.length - 1];
    const signature = `${conversationId}:${scrollIntent}:${messages.length}:${latest?.id || 'empty'}:${latest?.content?.length || 0}`;
    const remember = () => {
      const firstId = nextIds[0];
      anchorRef.current = {
        conversationId,
        ids: nextIds,
        offsetTop: firstId ? messageOffset(root, firstId) ?? 0 : 0,
        scrollHeight: root.scrollHeight,
        hasNewer,
      };
    };

    const pinToBottom = () => {
      seenBottomNonceRef.current = bottomNonce;
      programmaticScrollRef.current = true;
      edgeQuietUntilRef.current = performance.now() + 900;
      const previousBehavior = root.style.scrollBehavior;
      root.style.scrollBehavior = 'auto';
      root.scrollTop = root.scrollHeight;
      root.style.scrollBehavior = previousBehavior;
      lastScrollTopRef.current = root.scrollTop;
      autoFollowRef.current = true;
      safeSetScroll(storageKey, root.scrollTop);
      if (scrollIntent === 'bottom' || enteredFollow || forceBottom) restoredConversationRef.current = conversationId;
    };

    if (forceBottom) {
      pinToBottom();
      lastScrollSignature.current = signature;
      remember();
      const release = window.requestAnimationFrame(() => { programmaticScrollRef.current = false; });
      return () => {
        window.cancelAnimationFrame(release);
        programmaticScrollRef.current = false;
      };
    }

    if (sameConversation && change === 'prepend' && anchor.ids[0] && !jumpMessageId) {
      const nextOffset = messageOffset(root, anchor.ids[0]);
      const heightDelta = root.scrollHeight - anchor.scrollHeight;
      const offsetDelta = nextOffset === null ? heightDelta : nextOffset - anchor.offsetTop;
      const delta = offsetDelta !== 0 ? offsetDelta : heightDelta;
      if (delta !== 0) {
        programmaticScrollRef.current = true;
        edgeQuietUntilRef.current = performance.now() + 900;
        const previousBehavior = root.style.scrollBehavior;
        root.style.scrollBehavior = 'auto';
        root.scrollTop = lastScrollTopRef.current + delta;
        root.style.scrollBehavior = previousBehavior;
        lastScrollTopRef.current = root.scrollTop;
        safeSetScroll(storageKey, root.scrollTop);
      }
      lastScrollSignature.current = signature;
      remember();
      const release = window.requestAnimationFrame(() => { programmaticScrollRef.current = false; });
      return () => {
        window.cancelAnimationFrame(release);
        programmaticScrollRef.current = false;
      };
    }

    if (sameConversation && change === 'append' && anchor.hasNewer && !forceBottom && !jumpMessageId) {
      autoFollowRef.current = false;
      lastScrollSignature.current = signature;
      remember();
      return;
    }

    if (jumpMessageId) {
      remember();
      return;
    }

    if (!forceBottom && scrollIntent !== 'follow' && lastScrollSignature.current === signature) {
      remember();
      return;
    }
    lastScrollSignature.current = signature;

    let releaseFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      if (forceBottom || enteredFollow || ((scrollIntent === 'bottom' || scrollIntent === 'follow') && autoFollowRef.current)) {
        programmaticScrollRef.current = true;
        edgeQuietUntilRef.current = performance.now() + 900;
        root.scrollTop = root.scrollHeight;
        lastScrollTopRef.current = root.scrollTop;
        autoFollowRef.current = true;
        safeSetScroll(storageKey, root.scrollTop);
        if (scrollIntent === 'bottom' || enteredFollow || forceBottom) restoredConversationRef.current = conversationId;
        const firstId = nextIds[0];
        anchorRef.current.offsetTop = firstId ? messageOffset(root, firstId) ?? anchorRef.current.offsetTop : 0;
        releaseFrame = window.requestAnimationFrame(() => { programmaticScrollRef.current = false; });
        return;
      }
      if (scrollIntent === 'follow' || restoredConversationRef.current === conversationId) return;
      const saved = safeGetScroll(storageKey);
      if (typeof saved === 'number') {
        programmaticScrollRef.current = true;
        edgeQuietUntilRef.current = performance.now() + 900;
        root.scrollTop = Math.min(saved, Math.max(0, root.scrollHeight - root.clientHeight));
        lastScrollTopRef.current = root.scrollTop;
        releaseFrame = window.requestAnimationFrame(() => { programmaticScrollRef.current = false; });
      }
      autoFollowRef.current = isNearBottom(root);
      restoredConversationRef.current = conversationId;
    });
    remember();
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(releaseFrame);
      programmaticScrollRef.current = false;
    };
  }, [conversationId, messages, scrollIntent, storageKey, jumpMessageId, hasNewer, bottomNonce]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !conversationId) return;
    let frame = 0;
    const loadEdges = () => {
      if (programmaticScrollRef.current || jumpMessageIdRef.current || performance.now() < edgeQuietUntilRef.current) return;
      if (!canScroll(root)) return;
      if (isNearTop(root) && hasOlderRef.current) onLoadOlderRef.current?.();
      else if (isNearBottom(root) && hasNewerRef.current) onLoadNewerRef.current?.();
    };
    const save = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (!programmaticScrollRef.current) {
          const movedUp = root.scrollTop < lastScrollTopRef.current - 2;
          autoFollowRef.current = movedUp ? false : isNearBottom(root);
          loadEdges();
        }
        lastScrollTopRef.current = root.scrollTop;
        safeSetScroll(storageKey, root.scrollTop);
      });
    };
    const onWheel = (event: WheelEvent) => {
      if (programmaticScrollRef.current || jumpMessageIdRef.current || performance.now() < edgeQuietUntilRef.current || hasScrollableAncestor(event.target, root)) return;
      if (event.deltaY < 0 && isNearTop(root) && hasOlderRef.current) onLoadOlderRef.current?.();
      else if (event.deltaY > 0 && isNearBottom(root) && hasNewerRef.current) onLoadNewerRef.current?.();
    };
    let touchStartY = 0;
    const onTouchStart = (event: TouchEvent) => {
      touchStartY = event.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (programmaticScrollRef.current || jumpMessageIdRef.current || performance.now() < edgeQuietUntilRef.current || hasScrollableAncestor(event.target, root)) return;
      const y = event.touches[0]?.clientY ?? touchStartY;
      const delta = touchStartY - y;
      if (delta < -16 && isNearTop(root) && hasOlderRef.current) onLoadOlderRef.current?.();
      else if (delta > 16 && isNearBottom(root) && hasNewerRef.current) onLoadNewerRef.current?.();
    };
    lastScrollTopRef.current = root.scrollTop;
    root.addEventListener('scroll', save, { passive: true });
    root.addEventListener('wheel', onWheel, { passive: true });
    root.addEventListener('touchstart', onTouchStart, { passive: true });
    root.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', save);
    return () => {
      save();
      root.removeEventListener('scroll', save);
      root.removeEventListener('wheel', onWheel);
      root.removeEventListener('touchstart', onTouchStart);
      root.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', save);
      window.cancelAnimationFrame(frame);
    };
  }, [conversationId, storageKey, scrollIntent]);

  useGSAP(() => {
    const root = rootRef.current;
    if (!root || !conversationId || !jumpMessageId) return;
    if (!jumpReady) return;
    let disposed = false;
    let completed = false;
    const completeOnce = (found: boolean) => {
      if (disposed || completed) return;
      completed = true;
      onJumpCompleteRef.current?.(found);
    };
    const frame = window.requestAnimationFrame(() => {
      if (disposed) return;
      const safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(jumpMessageId) : jumpMessageId.replace(/"/g, '\\"');
      const messageNode = root.querySelector<HTMLElement>(`[data-message-id="${safeId}"]`);
      if (!messageNode) {
        completeOnce(false);
        return;
      }

      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      programmaticScrollRef.current = true;
      edgeQuietUntilRef.current = performance.now() + (reduce ? 50 : 900);
      autoFollowRef.current = false;
      messageNode.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      const bubble = messageNode.querySelector<HTMLElement>('.bubble');
      if (!bubble) {
        restoredConversationRef.current = conversationId;
        completeOnce(true);
        window.setTimeout(() => { programmaticScrollRef.current = false; }, reduce ? 0 : 400);
        return;
      }

      const complete = () => {
        if (disposed) return;
        gsap.set(bubble, { clearProps: 'boxShadow' });
        programmaticScrollRef.current = false;
        lastScrollTopRef.current = root.scrollTop;
        safeSetScroll(storageKey, root.scrollTop);
        restoredConversationRef.current = conversationId;
        completeOnce(true);
      };
      if (reduce) {
        gsap.set(bubble, { boxShadow: '0 0 0 4px rgba(204, 120, 92, 0.3)' });
        gsap.delayedCall(2, complete);
        return;
      }
      gsap.timeline()
        .to(bubble, { boxShadow: '0 0 0 4px rgba(204, 120, 92, 0.32)', duration: 0.2, ease: 'power2.out' })
        .to(bubble, { boxShadow: '0 0 0 0 rgba(204, 120, 92, 0)', duration: 0.25, ease: 'power2.in' }, '+=1.5')
        .call(complete);
    });
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      programmaticScrollRef.current = false;
    };
  }, { scope: rootRef, dependencies: [conversationId, jumpMessageId, jumpReady, storageKey], revertOnUpdate: true });

  useGSAP(() => {
    const latest = messages[messages.length - 1];
    if (!latest || latest.id === lastAnimatedId.current) return;
    lastAnimatedId.current = latest.id;
    const safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(latest.id) : latest.id.replace(/"/g, '\\"');
    const node = rootRef.current?.querySelector(`[data-message-id="${safeId}"] .bubble`);
    if (!node || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    gsap.fromTo(node, { autoAlpha: 0, y: 10, scale: 0.985 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.28, ease: 'power2.out' });
  }, { scope: rootRef, dependencies: [messages], revertOnUpdate: true });

  return (
    <div className="messages" ref={rootRef}>
      {messages.map(message => {
        const copyText = visibleContent(message);
        const isUser = message.role === 'user';
        const isEditing = isUser && editingMessageId === message.id;
        const showActions = (isUser || message.role === 'assistant') && message.status !== 'streaming' && (isUser || copyText.length > 0);
        const editable = isUser ? splitUserMessage(message) : undefined;
        return (
          <div className={`msg ${message.role} ${isEditing ? 'is-editing' : ''}`} data-message-id={message.id} key={message.id}>
            <div className="msg-row">
              <div className={`bubble ${isEditing ? 'inline-edit-bubble' : ''}`}>
                {isEditing && editable
                  ? <InlineMessageEditor initialText={editable.text} images={editable.images} disabled={editorDisabled} onCancel={onCancelEdit} onConfirm={text => onConfirmEdit(message, text)} />
                  : <MarkdownMessage content={message.content || (message.status === 'streaming' ? '...' : '')} streaming={message.status === 'streaming'} onImageClick={onImageClick} />}
              </div>
              {showActions && !isEditing && <MessageActions text={copyText} isUser={isUser} disabled={actionsDisabled} onEdit={() => onEdit(message)} onDelete={() => onDelete(message)} />}
            </div>
          </div>
        );
      })}
      <div />
    </div>
  );
}
