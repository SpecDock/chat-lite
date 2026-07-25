import { Component, memo, useMemo, type ReactNode } from 'react';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import taskLists from 'markdown-it-task-lists';
import StreamingCodeBlock from './StreamingCodeBlock';
import { parseStreamingMarkdown } from './streamingMarkdownParser';
import { appendReferenceDefinitions, collectMarkdownReferenceDefinitions } from './markdownReferences';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: true,
});

md.use(taskLists, { enabled: false, label: true, labelAfter: true });

class MarkdownRenderBoundary extends Component<{ fallback: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(prevProps: { fallback: string }) {
    if (prevProps.fallback !== this.props.fallback && this.state.failed) this.setState({ failed: false });
  }

  componentDidCatch(error: unknown) {
    console.warn('[chat-lite] markdown render fallback', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="markdown-fallback"><pre>{this.props.fallback}</pre></div>;
  }
}

function renderMarkdown(content: string) {
  const html = md.render(content);
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel', 'class', 'disabled', 'checked'],
  });
}

function MarkdownRenderer({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  return <div className="streaming-markdown-block" dangerouslySetInnerHTML={{ __html: html }} />;
}

const MarkdownBlock = memo(function MarkdownBlock({ content, renderContent }: { content: string; renderContent: string }) {
  return <MarkdownRenderBoundary fallback={content}>
    <MarkdownRenderer content={renderContent} />
  </MarkdownRenderBoundary>;
});

export default function StreamingMarkdown({ content, streaming }: { content: string; streaming: boolean }) {
  const blocks = useMemo(() => parseStreamingMarkdown(content), [content]);
  const definitions = useMemo(() => collectMarkdownReferenceDefinitions(md, blocks), [blocks]);
  return <div className="streaming-markdown">
    {blocks.map(block => block.type === 'markdown'
      ? <MarkdownBlock
          key={block.key}
          content={block.content}
          renderContent={appendReferenceDefinitions(block.content, definitions)}
        />
      : <StreamingCodeBlock
          key={block.key}
          code={block.raw}
          lang={block.lang}
          blockIndex={block.blockIndex}
          tokenizerStreaming={streaming && !block.closed}
          actionsDisabled={streaming}
        />)}
  </div>;
}
