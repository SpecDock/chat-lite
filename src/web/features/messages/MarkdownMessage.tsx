import { Component, type ReactNode, useMemo } from 'react';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import taskLists from 'markdown-it-task-lists';

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

function SafeMarkdown({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  return <MarkdownRenderBoundary fallback={content}>
    <div dangerouslySetInnerHTML={{ __html: html }} />
  </MarkdownRenderBoundary>;
}

function splitThinkBlocks(content: string) {
  const openTag = '<think>';
  const closeTag = '</think>';
  const thinking: string[] = [];
  const answer: string[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    const start = content.indexOf(openTag, cursor);
    if (start === -1) {
      answer.push(content.slice(cursor));
      break;
    }
    if (start > cursor) answer.push(content.slice(cursor, start));
    const bodyStart = start + openTag.length;
    const end = content.indexOf(closeTag, bodyStart);
    if (end === -1) {
      thinking.push(content.slice(bodyStart));
      cursor = content.length;
      break;
    }
    thinking.push(content.slice(bodyStart, end));
    cursor = end + closeTag.length;
  }

  return {
    thinking: thinking.map(part => part.trim()).filter(Boolean).join('\n\n'),
    answer: answer.join('').trim(),
  };
}

export default function MarkdownMessage({ content }: { content: string }) {
  const { thinking, answer } = splitThinkBlocks(content);
  if (!thinking) return <div className="markdown"><SafeMarkdown content={content} /></div>;
  return <div className="markdown">
    <details className="think-block" open={!answer}>
      <summary>思考过程</summary>
      <pre>{thinking || '正在思考...'}</pre>
    </details>
    {answer && <SafeMarkdown content={answer} />}
  </div>;
}
