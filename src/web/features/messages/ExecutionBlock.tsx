import { useLayoutEffect, useRef } from 'react';
import { ChevronDown, Code2, FileCode2, Terminal } from 'lucide-react';
import { gsap } from 'gsap';
import type { ExecutionBlock as ExecutionBlockData } from '../../shared/execution-block';
import type { ExecutionCardDTO } from '../../shared/types';
import StreamingCodeBlock from './StreamingCodeBlock';

function executionStatus(card: ExecutionCardDTO) {
  const statuses: Record<string, { label: string; tone: string }> = {
    succeeded: { label: '执行成功', tone: 'success' },
    failed: { label: '执行失败', tone: 'error' },
    timeout: { label: '执行超时', tone: 'error' },
    cancelled: { label: '已取消', tone: 'neutral' },
    interrupted: { label: '执行中断', tone: 'error' },
    oom: { label: '内存不足', tone: 'error' },
    running: { label: '执行中', tone: 'neutral' },
  };
  return statuses[card.status] || { label: `状态：${card.status}`, tone: 'neutral' };
}

function sourceLanguage(path: string) {
  const extension = path.split('.').pop()?.toLowerCase() || '';
  const languages: Record<string, string> = {
    sh: 'bash', bash: 'bash', py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'tsx', jsx: 'jsx', json: 'json', html: 'html', css: 'css',
    sql: 'sql', go: 'go', rs: 'rust', java: 'java', yaml: 'yaml', yml: 'yaml', md: 'markdown',
  };
  return languages[extension] || 'text';
}

function durationLabel(durationMs: number) {
  return durationMs < 1000 ? `${Math.round(durationMs)} ms` : `${(durationMs / 1000).toFixed(1)} s`;
}

export default function ExecutionBlock({ blocks = [], card }: { blocks?: ExecutionBlockData[]; card?: ExecutionCardDTO }) {
  const rootRef = useRef<HTMLElement>(null);

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

  if (card) {
    const status = executionStatus(card);
    const hasInfrastructureError = Boolean(card.infrastructureError);
    const tone = hasInfrastructureError || card.oomKilled || (card.exitCode !== null && card.exitCode !== 0) ? 'error' : status.tone;
    const statusLabel = card.status === 'succeeded' && tone === 'error' ? '执行异常' : status.label;
    const showOutput = card.showStdout || card.showStderr;
    return <article ref={rootRef} className={`execution-block execution-block--${tone}`} aria-label="沙箱执行记录">
      <details className="execution-block__disclosure">
      <summary className="execution-block__header">
        <span className="execution-block__title"><Terminal size={15} aria-hidden="true" />沙箱执行<span className="execution-block__language">bash</span></span>
        <span className="execution-block__summary-status">
          {card.truncated && <span className="execution-block__summary-notice">输出已截断</span>}
          <span className={`execution-block__status execution-block__status--${tone}`}>{statusLabel}</span>
          <ChevronDown size={14} className="execution-block__chevron" aria-hidden="true" />
        </span>
      </summary>
      <div className="execution-block__meta">
        <span className="execution-block__provenance">服务端记录</span>
        {statusLabel !== status.label && <span>服务端状态：{status.label}</span>}
        <span>{durationLabel(card.durationMs)}</span>
        <span>退出码 {card.exitCode === null ? '—' : card.exitCode}</span>
        <span className="execution-block__id" title={card.executionId}>记录 {card.executionId}</span>
      </div>
      {card.oomKilled && card.status !== 'oom' && <p className="execution-block__notice execution-block__notice--error">进程因内存不足终止</p>}
      {hasInfrastructureError && <p className="execution-block__notice execution-block__notice--error">执行环境异常：{card.infrastructureError}</p>}
      {card.truncated && <p className="execution-block__notice">输出已截断，仅展示保留的部分。</p>}
      <div className="execution-block__body">
        {card.showCode && card.code !== undefined && <details className="execution-section">
          <summary><span><Code2 size={14} aria-hidden="true" />命令</span><ChevronDown size={14} className="execution-section__chevron" aria-hidden="true" /></summary>
          <StreamingCodeBlock code={card.code} lang="bash" blockIndex={0} tokenizerStreaming={false} actionsDisabled={false} />
        </details>}
        {card.showCode && card.sourceSnapshots?.map((source, index) => <details className="execution-section" key={`${source.path}:${index}`}>
          <summary><span><FileCode2 size={14} aria-hidden="true" /><span className="execution-section__path" title={source.path}>{source.path}</span></span><ChevronDown size={14} className="execution-section__chevron" aria-hidden="true" /></summary>
          <div className="execution-section__caption">执行时的源文件快照</div>
          <StreamingCodeBlock code={source.content} lang={sourceLanguage(source.path)} blockIndex={index + 1} tokenizerStreaming={false} actionsDisabled={false} />
        </details>)}
        {showOutput && <details className="execution-section execution-output" open>
          <summary><span><Terminal size={14} aria-hidden="true" />{card.showStdout && card.showStderr ? '输出' : card.showStderr ? '错误输出' : '标准输出'}</span><ChevronDown size={14} className="execution-section__chevron" aria-hidden="true" /></summary>
          <StreamingCodeBlock code={card.output || '（无输出）'} lang="text" blockIndex={(card.sourceSnapshots?.length || 0) + 1} tokenizerStreaming={false} actionsDisabled={false} />
        </details>}
        {!card.showCode && !showOutput && <p className="execution-block__hidden">此记录仅展示执行状态，命令和输出未公开。</p>}
      </div>
      </details>
    </article>;
  }

  const language = blocks.find(block => block.language)?.language || 'text';
  return <article ref={rootRef} className="execution-block execution-block--legacy" aria-label="未验证的历史执行内容">
    <details className="execution-block__disclosure">
    <summary className="execution-block__header">
      <span className="execution-block__title"><Code2 size={15} aria-hidden="true" />历史执行内容<span className="execution-block__language">{language}</span></span>
      <span className="execution-block__summary-status">
        <span className="execution-block__status">未验证</span>
        <ChevronDown size={14} className="execution-block__chevron" aria-hidden="true" />
      </span>
    </summary>
    <p className="execution-block__notice">来自消息正文，无法验证是否真实执行。</p>
    <details className="execution-section execution-block__legacy-details">
      <summary><span>展开历史内容<span className="execution-block__language">{language}</span></span><ChevronDown size={14} className="execution-section__chevron" aria-hidden="true" /></summary>
      <div className="execution-block__body">
      {blocks.map((block, index) => <section className="execution-attempt" key={`${index}:${block.code.length}:${block.output.length}`}>
        {blocks.length > 1 && <div className="execution-attempt__label">第 {index + 1} 次</div>}
        <StreamingCodeBlock
          code={block.code}
          lang={block.language || 'text'}
          blockIndex={index * 2}
          tokenizerStreaming={false}
          actionsDisabled={false}
        />
        <section className="execution-output" aria-label="代码输出">
          <div className="execution-output__heading"><Terminal size={14} aria-hidden="true" />输出</div>
          <StreamingCodeBlock
            code={block.output || '（无输出）'}
            lang="text"
            blockIndex={index * 2 + 1}
            tokenizerStreaming={false}
            actionsDisabled={false}
          />
        </section>
      </section>)}
      </div>
    </details>
    </details>
  </article>;
}
