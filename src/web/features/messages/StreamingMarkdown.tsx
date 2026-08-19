import { Component, memo, useMemo, type MouseEvent, type ReactNode } from 'react';
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

function MarkdownRenderer({ content, onImageClick }: { content: string; onImageClick?: (src: string, alt: string) => void }) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const image = event.target instanceof HTMLImageElement ? event.target : null;
    if (image?.src && onImageClick) onImageClick(image.src, image.alt || '图片预览');
  };
  return <div className="streaming-markdown-block" onClick={handleClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

const MarkdownBlock = memo(function MarkdownBlock({ content, renderContent, onImageClick }: { content: string; renderContent: string; onImageClick?: (src: string, alt: string) => void }) {
  return <MarkdownRenderBoundary fallback={content}>
    <MarkdownRenderer content={renderContent} onImageClick={onImageClick} />
  </MarkdownRenderBoundary>;
});

export default function StreamingMarkdown({ content, streaming, onImageClick }: { content: string; streaming: boolean; onImageClick?: (src: string, alt: string) => void }) {
  const blocks = useMemo(() => parseStreamingMarkdown(content), [content]);
  const definitions = useMemo(() => collectMarkdownReferenceDefinitions(md, blocks), [blocks]);
  return <div className="streaming-markdown">
    {blocks.map(block => block.type === 'markdown'
      ? <MarkdownBlock
          key={block.key}
          content={block.content}
          renderContent={appendReferenceDefinitions(block.content, definitions)}
          onImageClick={onImageClick}
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
