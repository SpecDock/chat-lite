import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Search, X } from 'lucide-react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import type { SearchMessageResultDTO } from '../../../shared/types';
import { api } from '../../shared/api/client';

const SEARCH_DEBOUNCE_MS = 250;

gsap.registerPlugin(useGSAP);

type HighlightPart = {
  text: string;
  highlighted: boolean;
};

type Props = {
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onSelect: (result: SearchMessageResultDTO) => void;
};

function reducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function splitHighlightParts(text: string, query: string): HighlightPart[] {
  const needle = query.trim();
  if (!needle) return [{ text, highlighted: false }];

  const parts: HighlightPart[] = [];
  const escapedNeedle = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(escapedNeedle, 'giu');
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), highlighted: false });
    parts.push({ text: text.slice(start, end), highlighted: true });
    cursor = end;
  }

  if (cursor < text.length) parts.push({ text: text.slice(cursor), highlighted: false });
  return parts.length ? parts : [{ text, highlighted: false }];
}

function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  return splitHighlightParts(text, query).map((part, index) => (
    <Fragment key={`${index}:${part.text}`}>
      {part.highlighted ? <mark>{part.text}</mark> : part.text}
    </Fragment>
  ));
}

function formatSearchTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export default function ConversationSearch({ open, triggerRef, onClose, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchMessageResultDTO[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);
  const [initialBatch, setInitialBatch] = useState(0);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const queryRef = useRef('');
  const requestRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(new Set<string>());
  const requestGenerationRef = useRef(0);
  const pendingSelectionRef = useRef<SearchMessageResultDTO | null>(null);
  const onCloseRef = useRef(onClose);
  const onSelectRef = useRef(onSelect);
  onCloseRef.current = onClose;
  onSelectRef.current = onSelect;

  const finishClose = useCallback(() => {
    requestGenerationRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    inFlightRef.current.clear();
    queryRef.current = '';
    setQuery('');
    setClosing(false);
    const selected = pendingSelectionRef.current;
    pendingSelectionRef.current = null;
    if (selected) onSelectRef.current(selected);
    else onCloseRef.current();
  }, []);

  const startClosing = useCallback((selection?: SearchMessageResultDTO) => {
    pendingSelectionRef.current = selection || null;
    requestGenerationRef.current += 1;
    requestRef.current?.abort();
    if (reducedMotion()) finishClose();
    else setClosing(true);
  }, [finishClose]);

  const requestPage = useCallback(async (normalizedQuery: string, offset: number, append: boolean, generation: number) => {
    if (!normalizedQuery || queryRef.current !== normalizedQuery || requestGenerationRef.current !== generation) return;
    const requestKey = `${normalizedQuery}:${offset}:${generation}`;
    if (inFlightRef.current.has(requestKey)) return;

    const controller = new AbortController();
    requestRef.current = controller;
    inFlightRef.current.add(requestKey);
    if (append) setLoadingMore(true);
    else setStatus('loading');
    setError('');

    try {
      const response = await api.searchMessages(normalizedQuery, offset, controller.signal);
      if (controller.signal.aborted || queryRef.current !== normalizedQuery || requestGenerationRef.current !== generation) return;
      setResults(currentResults => {
        if (!append) return response.items;
        const known = new Set(currentResults.map(result => result.messageId));
        const additions = response.items.filter(result => {
          if (known.has(result.messageId)) return false;
          known.add(result.messageId);
          return true;
        });
        return [...currentResults, ...additions];
      });
      setNextOffset(response.nextOffset ?? null);
      setHasMore(response.hasMore);
      setStatus('success');
      if (!append) setInitialBatch(batch => batch + 1);
    } catch (cause) {
      if (controller.signal.aborted || (cause instanceof Error && cause.name === 'AbortError')) return;
      if (queryRef.current !== normalizedQuery || requestGenerationRef.current !== generation) return;
      setError(cause instanceof Error ? cause.message : '搜索失败，请稍后重试');
      setStatus('error');
    } finally {
      inFlightRef.current.delete(requestKey);
      if (requestRef.current === controller) requestRef.current = null;
      if (append && requestGenerationRef.current === generation) setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    requestGenerationRef.current += 1;
    setQuery('');
    setResults([]);
    setNextOffset(null);
    setHasMore(false);
    setStatus('idle');
    setLoadingMore(false);
    setError('');
    setClosing(false);
    pendingSelectionRef.current = null;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const normalizedQuery = query.trim();
    queryRef.current = normalizedQuery;
    const generation = ++requestGenerationRef.current;
    requestRef.current?.abort();
    requestRef.current = null;
    inFlightRef.current.clear();
    setResults([]);
    setNextOffset(null);
    setHasMore(false);
    setLoadingMore(false);
    setError('');
    setStatus('idle');
    if (!normalizedQuery) return;

    const timer = window.setTimeout(() => {
      void requestPage(normalizedQuery, 0, false, generation);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      requestRef.current?.abort();
    };
  }, [open, query, requestPage]);

  useEffect(() => {
    if (!open || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const rootStyle = document.documentElement.style;
    const previousHeight = rootStyle.getPropertyValue('--conversation-search-viewport-height');
    const previousOffsetTop = rootStyle.getPropertyValue('--conversation-search-viewport-offset-top');
    let frame = 0;
    const syncViewportHeight = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        rootStyle.setProperty('--conversation-search-viewport-height', `${Math.round(viewport.height)}px`);
        rootStyle.setProperty('--conversation-search-viewport-offset-top', `${Math.round(viewport.offsetTop)}px`);
      });
    };
    syncViewportHeight();
    viewport.addEventListener('resize', syncViewportHeight);
    viewport.addEventListener('scroll', syncViewportHeight);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', syncViewportHeight);
      viewport.removeEventListener('scroll', syncViewportHeight);
      if (previousHeight) rootStyle.setProperty('--conversation-search-viewport-height', previousHeight);
      else rootStyle.removeProperty('--conversation-search-viewport-height');
      if (previousOffsetTop) rootStyle.setProperty('--conversation-search-viewport-offset-top', previousOffsetTop);
      else rootStyle.removeProperty('--conversation-search-viewport-offset-top');
    };
  }, [open]);

  useGSAP(() => {
    if (!open) return;
    const backdrop = backdropRef.current;
    const panel = panelRef.current;
    if (!backdrop || !panel) return;
    const reduce = reducedMotion();
    const mobile = window.matchMedia('(max-width: 799px)').matches;

    if (reduce) {
      gsap.set([backdrop, panel], { autoAlpha: closing ? 0 : 1, clearProps: closing ? undefined : 'transform' });
      if (closing) finishClose();
      return;
    }

    if (closing) {
      gsap.to(panel, {
        autoAlpha: 0,
        x: mobile ? 12 : 0,
        y: mobile ? 0 : 6,
        scale: mobile ? 1 : 0.985,
        duration: 0.18,
        ease: 'power2.in',
      });
      gsap.to(backdrop, { autoAlpha: 0, duration: 0.2, ease: 'power1.in', onComplete: finishClose });
    } else {
      gsap.fromTo(backdrop, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2, ease: 'power1.out' });
      gsap.fromTo(panel, {
        autoAlpha: 0,
        x: mobile ? 14 : 0,
        y: mobile ? 0 : 8,
        scale: mobile ? 1 : 0.975,
      }, {
        autoAlpha: 1,
        x: 0,
        y: 0,
        scale: 1,
        duration: 0.24,
        ease: 'power2.out',
      });
    }
  }, { scope: backdropRef, dependencies: [closing, finishClose, open], revertOnUpdate: true });

  useLayoutEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    inputRef.current?.focus();
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
    };
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        startClosing();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('input, button:not([disabled])')]
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
  }, [open, startClosing]);

  useGSAP(() => {
    if (!initialBatch || reducedMotion()) return;
    const nodes = resultsRef.current?.querySelectorAll('.conversation-search-result');
    if (!nodes?.length) return;
    gsap.fromTo(nodes, { autoAlpha: 0, y: 6 }, {
      autoAlpha: 1,
      y: 0,
      duration: 0.2,
      stagger: 0.025,
      ease: 'power2.out',
    });
  }, { scope: resultsRef, dependencies: [initialBatch], revertOnUpdate: true });

  if (!open) return null;

  const normalizedQuery = query.trim();
  const liveText = !normalizedQuery
    ? ''
    : status === 'loading'
      ? '正在搜索'
      : status === 'error'
        ? '搜索失败'
        : status === 'success' && results.length === 0
          ? '没有找到相关消息'
          : status === 'success'
            ? `找到 ${results.length} 条消息`
            : '';

  const loadMore = () => {
    if (!normalizedQuery || !hasMore || nextOffset === null || loadingMore || status === 'loading') return;
    void requestPage(normalizedQuery, nextOffset, true, requestGenerationRef.current);
  };

  const changeQuery = (value: string) => {
    queryRef.current = value.trim();
    requestGenerationRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    setResults([]);
    setNextOffset(null);
    setHasMore(false);
    setLoadingMore(false);
    setError('');
    setStatus('idle');
    setQuery(value);
  };

  return createPortal(
    <div className="conversation-search-overlay" ref={backdropRef} onMouseDown={event => {
      if (event.target === event.currentTarget && window.matchMedia('(min-width: 800px)').matches) startClosing();
    }}>
      <section className="conversation-search" ref={panelRef} role="dialog" aria-modal="true" aria-label="搜索消息">
        <header className="conversation-search-header">
          <label className="conversation-search-field">
            <Search size={19} aria-hidden="true" />
            <span className="sr-only">搜索消息</span>
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={event => changeQuery(event.target.value)}
              placeholder="搜索消息"
              autoComplete="off"
              enterKeyHint="search"
            />
          </label>
          <button type="button" className="conversation-search-close" onClick={() => startClosing()} aria-label="关闭搜索" title="关闭搜索">
            <X size={20} aria-hidden="true" />
          </button>
          <button type="button" className="conversation-search-cancel" onClick={() => startClosing()}>取消</button>
        </header>

        <div
          className="conversation-search-results"
          ref={resultsRef}
          aria-busy={status === 'loading' || loadingMore}
          onScroll={event => {
            const node = event.currentTarget;
            if (node.scrollHeight - node.scrollTop - node.clientHeight <= 160) loadMore();
          }}
        >
          {status === 'loading' && results.length === 0 && <div className="conversation-search-state">正在搜索...</div>}
          {status === 'error' && results.length === 0 && <div className="conversation-search-state is-error">{error || '搜索失败，请稍后重试'}</div>}
          {status === 'success' && results.length === 0 && <div className="conversation-search-state">没有找到相关消息</div>}
          {results.length > 0 && <div className="conversation-search-list">
            {results.map(result => (
              <button
                type="button"
                className="conversation-search-result"
                key={result.messageId}
                onClick={() => startClosing(result)}
              >
                <span className="conversation-search-result-head">
                  <strong>{result.conversationTitle}</strong>
                  <time dateTime={result.createdAt}>{formatSearchTime(result.createdAt)}</time>
                </span>
                <span className="conversation-search-result-body">
                  <span className={`conversation-search-role is-${result.role}`}>{result.role === 'user' ? '你' : 'AI'}</span>
                  <span className="conversation-search-snippet"><HighlightedSnippet text={result.snippet} query={normalizedQuery} /></span>
                </span>
              </button>
            ))}
          </div>}
          {results.length > 0 && (loadingMore || status === 'error') && (
            <div className={`conversation-search-page-state${status === 'error' ? ' is-error' : ''}`}>
              {status === 'error' ? (error || '加载更多结果失败') : '正在加载更多结果...'}
            </div>
          )}
        </div>
        <div className="sr-only" aria-live="polite" aria-atomic="true">{liveText}</div>
      </section>
    </div>,
    document.body
  );
}
