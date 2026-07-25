import StreamingMarkdown from './StreamingMarkdown';
import { splitThinkBlocks } from './thinkBlocks';

export default function MarkdownMessage({ content, streaming }: { content: string; streaming: boolean }) {
  const { thinking, answer, sawThinkTag } = splitThinkBlocks(content);
  if (!sawThinkTag) return <div className="markdown"><StreamingMarkdown content={content} streaming={streaming} /></div>;
  const showThinking = Boolean(thinking.trim());
  return <div className="markdown">
    {showThinking && <details className="think-block" open={!answer.trim()}>
      <summary>思考过程</summary>
      <pre>{thinking}</pre>
    </details>}
    {answer && <StreamingMarkdown content={answer} streaming={streaming} />}
  </div>;
}
