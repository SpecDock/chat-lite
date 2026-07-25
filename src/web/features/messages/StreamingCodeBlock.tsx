import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import type { ShikiStreamTokenizer } from '@shikijs/stream';
import { gsap } from 'gsap';
import {
  applyTokenRecall,
  extensionForLanguage,
  importIfShikiSupported,
  lightweightLanguage,
  shouldUseShiki,
} from './codeBlockHelpers';

type Props = {
  code: string;
  lang: string;
  blockIndex: number;
  tokenizerStreaming: boolean;
  actionsDisabled: boolean;
};

type DisplayToken = {
  content: string;
  offset: number;
  color?: string;
  fontStyle?: number;
};

type TokenSnapshot = {
  code: string;
  tokens: DisplayToken[];
  languageId: string;
  languageLabel: string;
};

type TokenController = {
  tokenizer: ShikiStreamTokenizer;
  previousCode: string;
  tokens: DisplayToken[];
  languageId: string;
  languageLabel: string;
  closed: boolean;
  failed: boolean;
  active: boolean;
  frame: number | null;
  queue: Promise<void>;
};

function tokenStyle(token: DisplayToken): CSSProperties {
  const fontStyle = token.fontStyle && token.fontStyle > 0 ? token.fontStyle : 0;
  return {
    color: token.color,
    fontStyle: fontStyle & 1 ? 'italic' : undefined,
    fontWeight: fontStyle & 2 ? 700 : undefined,
    textDecoration: fontStyle & 4 ? 'underline' : undefined,
  };
}

async function copyRawCode(code: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(code);
      return;
    } catch { /* use the legacy fallback below */ }
  }
  const textarea = document.createElement('textarea');
  textarea.value = code;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('copy command was rejected');
}

function StreamingCodeBlock({ code, lang, blockIndex, tokenizerStreaming, actionsDisabled }: Props) {
  const lightweight = lightweightLanguage(lang);
  const highlightable = lightweight.shouldAttemptHighlight && shouldUseShiki(code);
  const latestRef = useRef({ code, tokenizerStreaming });
  latestRef.current = { code, tokenizerStreaming };
  const generationRef = useRef(0);
  const controllerRef = useRef<TokenController | null>(null);
  const resolvedLanguageRef = useRef(lightweight.id);
  const [snapshot, setSnapshot] = useState<TokenSnapshot | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const copyIconRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const context = gsap.context(() => {
      gsap.fromTo(root,
        { autoAlpha: 0, y: 4 },
        { autoAlpha: 1, y: 0, duration: 0.22, ease: 'power1.out', clearProps: 'opacity,visibility,transform' },
      );
    }, root);

    return () => context.revert();
  }, []);

  useLayoutEffect(() => {
    const button = copyButtonRef.current;
    const icon = copyIconRef.current;
    if (!copied || !button || !icon || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const context = gsap.context(() => {
      const timeline = gsap.timeline();
      timeline
        .fromTo(button,
          { scale: 0.97 },
          { scale: 1, duration: 0.24, ease: 'power2.out', clearProps: 'transform' },
        )
        .fromTo(icon,
          { autoAlpha: 0, scale: 0.78 },
          { autoAlpha: 1, scale: 1, duration: 0.24, ease: 'power2.out', clearProps: 'opacity,visibility,transform' },
          0,
        );
    }, button);

    return () => context.revert();
  }, [copied]);

  useEffect(() => {
    const generation = ++generationRef.current;
    const previous = controllerRef.current;
    if (previous) {
      previous.active = false;
      previous.tokenizer.clear();
      if (previous.frame !== null) cancelAnimationFrame(previous.frame);
    }
    controllerRef.current = null;
    resolvedLanguageRef.current = lightweight.id;
    setSnapshot(null);
    if (!highlightable) return;
    if (typeof TransformStream === 'undefined' || typeof WebAssembly === 'undefined') return;

    let disposed = false;

    const scheduleSnapshot = (controller: TokenController) => {
      if (controller.frame !== null || !controller.active) return;
      controller.frame = requestAnimationFrame(() => {
        controller.frame = null;
        if (!controller.active || disposed || generationRef.current !== generation) return;
        setSnapshot({
          code: controller.previousCode,
          tokens: [...controller.tokens],
          languageId: controller.languageId,
          languageLabel: controller.languageLabel,
        });
      });
    };

    const failSoft = (controller: TokenController, error: unknown) => {
      if (!controller.active || controller.failed) return;
      controller.failed = true;
      controller.tokenizer.clear();
      console.warn('[chat-lite] Shiki highlighting disabled for code block', error);
      if (controller.frame !== null) cancelAnimationFrame(controller.frame);
      controller.frame = requestAnimationFrame(() => {
        controller.frame = null;
        if (controller.active && !disposed && generationRef.current === generation) setSnapshot(null);
      });
    };

    const enqueue = (controller: TokenController, nextCode: string, complete: boolean) => {
      controller.queue = controller.queue.then(async () => {
        if (!controller.active || controller.failed || generationRef.current !== generation) return;
        if (controller.closed && nextCode !== controller.previousCode) {
          controller.tokenizer.clear();
          controller.previousCode = '';
          controller.tokens = [];
          controller.closed = false;
        }

        let chunk = '';
        if (nextCode.startsWith(controller.previousCode)) chunk = nextCode.slice(controller.previousCode.length);
        else {
          controller.tokenizer.clear();
          controller.tokens = [];
          controller.previousCode = '';
          controller.closed = false;
          chunk = nextCode;
        }

        if (chunk) {
          const update = await controller.tokenizer.enqueue(chunk);
          if (!controller.active || generationRef.current !== generation) return;
          controller.tokens = applyTokenRecall(controller.tokens, update);
          controller.previousCode = nextCode;
          scheduleSnapshot(controller);
        } else if (!controller.previousCode && !nextCode) {
          scheduleSnapshot(controller);
        }

        if (complete && !controller.closed) {
          controller.tokenizer.close();
          controller.closed = true;
        }
      }).catch(error => failSoft(controller, error));
    };

    void importIfShikiSupported(
      { TransformStream, WebAssembly },
      () => Promise.all([import('@shikijs/stream'), import('./shikiHighlighter')]),
    ).then(async modules => {
      if (!modules || disposed || generationRef.current !== generation) return;
      const [streamModule, manager] = modules;
      const result = await manager.loadShikiLanguage(lang);
      if (!result || disposed || generationRef.current !== generation) return;
      resolvedLanguageRef.current = result.language.id;
      const controller: TokenController = {
        tokenizer: new streamModule.ShikiStreamTokenizer({
          highlighter: result.highlighter,
          lang: result.language.id,
          theme: manager.SHIKI_THEME_NAME,
        }),
        previousCode: '',
        tokens: [],
        languageId: result.language.id,
        languageLabel: result.language.label,
        closed: false,
        failed: false,
        active: true,
        frame: null,
        queue: Promise.resolve(),
      };
      controllerRef.current = controller;
      const latest = latestRef.current;
      enqueue(controller, latest.code, !latest.tokenizerStreaming);
    }).catch(error => {
      if (!disposed && generationRef.current === generation) {
        console.warn('[chat-lite] Shiki runtime load failed; using plain code', error);
      }
    });

    return () => {
      disposed = true;
      const controller = controllerRef.current;
      if (controller) {
        controller.active = false;
        controller.tokenizer.clear();
        if (controller.frame !== null) cancelAnimationFrame(controller.frame);
      }
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [highlightable, lang, lightweight.id]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || controller.failed) return;
    controller.queue = controller.queue.then(async () => {
      if (!controller.active || controller.failed) return;
      if (controller.closed && code !== controller.previousCode) {
        controller.tokenizer.clear();
        controller.previousCode = '';
        controller.tokens = [];
        controller.closed = false;
      }
      let chunk = '';
      if (code.startsWith(controller.previousCode)) chunk = code.slice(controller.previousCode.length);
      else {
        controller.tokenizer.clear();
        controller.tokens = [];
        controller.previousCode = '';
        controller.closed = false;
        chunk = code;
      }
      if (chunk) {
        const update = await controller.tokenizer.enqueue(chunk);
        if (!controller.active) return;
        controller.tokens = applyTokenRecall(controller.tokens, update);
        controller.previousCode = code;
        if (controller.frame === null) {
          controller.frame = requestAnimationFrame(() => {
            controller.frame = null;
            if (controller.active) {
              setSnapshot({
                code: controller.previousCode,
                tokens: [...controller.tokens],
                languageId: controller.languageId,
                languageLabel: controller.languageLabel,
              });
            }
          });
        }
      }
      if (!tokenizerStreaming && !controller.closed) {
        controller.tokenizer.close();
        controller.closed = true;
      }
    }).catch(error => {
      controller.failed = true;
      controller.tokenizer.clear();
      console.warn('[chat-lite] Shiki tokenization failed; using plain code', error);
      if (controller.active && controller.frame === null) {
        controller.frame = requestAnimationFrame(() => {
          controller.frame = null;
          if (controller.active) setSnapshot(null);
        });
      }
    });
  }, [code, tokenizerStreaming]);

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const copy = async () => {
    if (actionsDisabled) return;
    try {
      await copyRawCode(code);
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1800);
    } catch (error) {
      console.warn('[chat-lite] code copy failed', error);
    }
  };

  const download = () => {
    if (actionsDisabled) return;
    let url: string | undefined;
    let link: HTMLAnchorElement | undefined;
    try {
      url = URL.createObjectURL(new Blob([code], { type: 'text/plain;charset=utf-8' }));
      link = document.createElement('a');
      link.href = url;
      link.download = `code-${blockIndex + 1}.${extensionForLanguage(lang, resolvedLanguageRef.current)}`;
      document.body.appendChild(link);
      link.click();
    } catch (error) {
      console.warn('[chat-lite] code download failed', error);
    } finally {
      link?.remove();
      if (url) {
        const revokeUrl = url;
        window.setTimeout(() => URL.revokeObjectURL(revokeUrl), 30_000);
      }
    }
  };

  const canReuseSnapshot = Boolean(snapshot && code.startsWith(snapshot.code));
  const suffix = canReuseSnapshot && snapshot ? code.slice(snapshot.code.length) : code;
  const languageLabel = snapshot?.languageLabel || lightweight.label;

  return <section ref={rootRef} className={`streaming-code-block ${tokenizerStreaming ? 'is-streaming' : 'is-complete'}`}>
    <div className="code-block-toolbar">
      <span className="code-block-language">{languageLabel}</span>
      <div className="code-block-actions">
        <button
          ref={copyButtonRef}
          className={`code-block-action code-block-action--copy${copied ? ' is-copied' : ''}`}
          type="button"
          disabled={actionsDisabled}
          onClick={() => { void copy(); }}
          aria-label={copied ? '代码已复制' : '复制代码'}
          title="复制代码"
        >
          <span ref={copyIconRef} className="code-block-action-icon" aria-hidden="true">
            {copied ? <Check /> : <Copy />}
          </span>
          <span className="code-block-action-label" aria-live="polite">{copied ? '已复制' : '复制'}</span>
        </button>
        <button
          className="code-block-action code-block-action--download"
          type="button"
          disabled={actionsDisabled}
          onClick={download}
          aria-label="下载代码"
          title="下载代码"
        >
          <span className="code-block-action-icon" aria-hidden="true"><Download /></span>
          <span className="code-block-action-label">下载</span>
        </button>
      </div>
    </div>
    <div className="code-block-scroll">
      <pre><code>{canReuseSnapshot && snapshot
        ? <>{snapshot.tokens.map((token, index) => <span key={`${index}-${token.offset}`} style={tokenStyle(token)}>{token.content}</span>)}{suffix}</>
        : code}</code></pre>
    </div>
  </section>;
}

export default memo(StreamingCodeBlock);
