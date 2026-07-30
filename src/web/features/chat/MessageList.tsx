import { useEffect, useLayoutEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import type { MessageDTO } from '../../../shared/types';
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

function isNearBottom(node: HTMLElement, threshold = 72) {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= threshold;
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
  onJumpComplete?: (found: boolean) => void;
  onEdit: (message: MessageDTO) => void;
  onCancelEdit: () => void;
  onConfirmEdit: (message: MessageDTO, text: string) => void;
  onDelete: (message: MessageDTO) => void;
};

export default function MessageList({ messages, conversationId, storageKey, scrollIntent, editingMessageId, actionsDisabled, editorDisabled, jumpMessageId, jumpReady = true, onJumpComplete, onEdit, onCancelEdit, onConfirmEdit, onDelete }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastAnimatedId = useRef<string>('');
  const restoredConversationRef = useRef<string>('');
  const lastScrollSignature = useRef<string>('');
  const previousIntentRef = useRef<ScrollIntent>(scrollIntent);
  const autoFollowRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const onJumpCompleteRef = useRef(onJumpComplete);
  onJumpCompleteRef.current = onJumpComplete;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !conversationId) return;
    if (jumpMessageId) return;
    if (scrollIntent === 'restore' && messages.length === 0) return;

    const latest = messages[messages.length - 1];
    const signature = `${conversationId}:${scrollIntent}:${messages.length}:${latest?.id || 'empty'}:${latest?.content?.length || 0}`;
    if (scrollIntent !== 'follow' && lastScrollSignature.current === signature) return;
    lastScrollSignature.current = signature;
    const enteredFollow = scrollIntent === 'follow' && previousIntentRef.current !== 'follow';
    previousIntentRef.current = scrollIntent;

    let releaseFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      if (scrollIntent === 'bottom' || enteredFollow || (scrollIntent === 'follow' && autoFollowRef.current)) {
        programmaticScrollRef.current = true;
        root.scrollTop = root.scrollHeight;
        lastScrollTopRef.current = root.scrollTop;
        autoFollowRef.current = true;
        safeSetScroll(storageKey, root.scrollTop);
        if (scrollIntent === 'bottom' || enteredFollow) restoredConversationRef.current = conversationId;
        releaseFrame = window.requestAnimationFrame(() => { programmaticScrollRef.current = false; });
        return;
      }
      if (scrollIntent === 'follow' || restoredConversationRef.current === conversationId) return;
      const saved = safeGetScroll(storageKey);
      if (typeof saved === 'number') {
        programmaticScrollRef.current = true;
        root.scrollTop = Math.min(saved, Math.max(0, root.scrollHeight - root.clientHeight));
        lastScrollTopRef.current = root.scrollTop;
        releaseFrame = window.requestAnimationFrame(() => { programmaticScrollRef.current = false; });
      }
      autoFollowRef.current = isNearBottom(root);
      restoredConversationRef.current = conversationId;
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(releaseFrame);
      programmaticScrollRef.current = false;
    };
  }, [conversationId, messages, scrollIntent, storageKey, jumpMessageId]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !conversationId) return;
    let frame = 0;
    const save = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (scrollIntent === 'follow' && !programmaticScrollRef.current) {
          const movedUp = root.scrollTop < lastScrollTopRef.current - 2;
          autoFollowRef.current = movedUp ? false : isNearBottom(root);
        }
        lastScrollTopRef.current = root.scrollTop;
        safeSetScroll(storageKey, root.scrollTop);
      });
    };
    lastScrollTopRef.current = root.scrollTop;
    root.addEventListener('scroll', save, { passive: true });
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', save);
    return () => {
      save();
      root.removeEventListener('scroll', save);
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
      autoFollowRef.current = false;
      messageNode.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      const bubble = messageNode.querySelector<HTMLElement>('.bubble');
      if (!bubble) {
        programmaticScrollRef.current = false;
        restoredConversationRef.current = conversationId;
        completeOnce(true);
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
                  : <MarkdownMessage content={message.content || (message.status === 'streaming' ? '...' : '')} streaming={message.status === 'streaming'} />}
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
