import { useLayoutEffect, useRef } from 'react';
import { Code2, Terminal } from 'lucide-react';
import { gsap } from 'gsap';
import type { ExecutionBlock as ExecutionBlockData } from '../../../shared/execution-block';
import StreamingCodeBlock from './StreamingCodeBlock';

export default function ExecutionBlock({ block }: { block: ExecutionBlockData }) {
  const rootRef = useRef<HTMLDetailsElement>(null);

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

  return <details ref={rootRef} className="execution-block">
    <summary>
      <span className="execution-block__title"><Code2 size={15} aria-hidden="true" />代码执行</span>
      <span className="execution-block__language">{block.language || 'text'}</span>
    </summary>
    <div className="execution-block__body">
      <StreamingCodeBlock
        code={block.code}
        lang={block.language || 'text'}
        blockIndex={0}
        tokenizerStreaming={false}
        actionsDisabled={false}
      />
      <section className="execution-output" aria-label="代码输出">
        <div className="execution-output__heading"><Terminal size={14} aria-hidden="true" />输出</div>
        <StreamingCodeBlock
          code={block.output || '（无输出）'}
          lang="text"
          blockIndex={1}
          tokenizerStreaming={false}
          actionsDisabled={false}
        />
      </section>
    </div>
  </details>;
}
