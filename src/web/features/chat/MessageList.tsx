import { useEffect, useLayoutEffect, useRef } from 'react';
import { gsap } from 'gsap';
import type { MessageDTO } from '../../../shared/types';
import MarkdownMessage from '../messages/MarkdownMessage';

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

type ScrollIntent = 'restore' | 'bottom' | 'follow';

export default function MessageList({ messages, conversationId, storageKey, scrollIntent }: { messages: MessageDTO[]; conversationId?: string; storageKey: string; scrollIntent: ScrollIntent }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const lastAnimatedId = useRef<string>('');
  const restoredConversationRef = useRef<string>('');
  const lastScrollSignature = useRef<string>('');
  const previousIntentRef = useRef<ScrollIntent>(scrollIntent);
  const autoFollowRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const lastScrollTopRef = useRef(0);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !conversationId) return;
    if (scrollIntent === 'restore' && messages.length === 0) return;

    const latest = messages[messages.length - 1];
    const signature = `${conversationId}:${scrollIntent}:${messages.length}:${latest?.id || 'empty'}:${latest?.content?.length || 0}`;
    if (scrollIntent !== 'follow' && lastScrollSignature.current === signature) return;
    lastScrollSignature.current = signature;
    const enteredFollow = scrollIntent === 'follow' && previousIntentRef.current !== 'follow';
    previousIntentRef.current = scrollIntent;

    window.requestAnimationFrame(() => {
      if (scrollIntent === 'bottom' || enteredFollow || (scrollIntent === 'follow' && autoFollowRef.current)) {
        programmaticScrollRef.current = true;
        root.scrollTop = root.scrollHeight;
        lastScrollTopRef.current = root.scrollTop;
        autoFollowRef.current = true;
        safeSetScroll(storageKey, root.scrollTop);
        if (scrollIntent === 'bottom' || enteredFollow) restoredConversationRef.current = conversationId;
        window.requestAnimationFrame(() => { programmaticScrollRef.current = false; });
        return;
      }

      if (scrollIntent === 'follow') return;

      if (restoredConversationRef.current === conversationId) return;
      const saved = safeGetScroll(storageKey);
      if (typeof saved === 'number') {
        programmaticScrollRef.current = true;
        root.scrollTop = Math.min(saved, Math.max(0, root.scrollHeight - root.clientHeight));
        lastScrollTopRef.current = root.scrollTop;
        window.requestAnimationFrame(() => { programmaticScrollRef.current = false; });
      }
      autoFollowRef.current = isNearBottom(root);
      restoredConversationRef.current = conversationId;
    });
  }, [conversationId, messages, scrollIntent, storageKey]);

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

  useEffect(() => {
    const latest = messages[messages.length - 1];
    if (!latest || latest.id === lastAnimatedId.current) return;
    lastAnimatedId.current = latest.id;
    const safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(latest.id) : latest.id.replace(/"/g, '\\"');
    const node = rootRef.current?.querySelector(`[data-message-id="${safeId}"] .bubble`);
    if (!node) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(node, { autoAlpha: 0, y: 10, scale: 0.985 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.28, ease: 'power2.out' });
    }, rootRef);
    return () => ctx.revert();
  }, [messages]);

  return <div className="messages" ref={rootRef}>{messages.map(m => <div className={`msg ${m.role}`} data-message-id={m.id} key={m.id}><div className="bubble"><MarkdownMessage content={m.content || (m.status === 'streaming' ? '...' : '')} /></div></div>)}<div ref={endRef} /></div>;
}
