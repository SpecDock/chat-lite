import StreamingMarkdown from './StreamingMarkdown';
import ExecutionBlock from './ExecutionBlock';
import { splitThinkBlocks } from './thinkBlocks';

export default function MarkdownMessage({ content, streaming, onImageClick }: { content: string; streaming: boolean; onImageClick?: (src: string, alt: string) => void }) {
  const { thinking, execution, answer, sawThinkTag, sawExecutionBlock } = splitThinkBlocks(content);
  if (!sawThinkTag && !sawExecutionBlock) return <div className="markdown"><StreamingMarkdown content={content} streaming={streaming} onImageClick={onImageClick} /></div>;
  const showThinking = Boolean(thinking.trim());
  return <div className="markdown">
    {showThinking && <details className="think-block" open={!answer.trim()}>
      <summary>思考过程</summary>
      <pre>{thinking}</pre>
    </details>}
    {execution && <ExecutionBlock block={execution} />}
    {answer && <StreamingMarkdown content={answer} streaming={streaming} onImageClick={onImageClick} />}
  </div>;
}
