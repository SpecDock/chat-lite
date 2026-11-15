import StreamingMarkdown from './StreamingMarkdown';
import ExecutionBlock from './ExecutionBlock';
import { splitThinkBlocks } from './thinkBlocks';
import type { ExecutionCardDTO } from '../../shared/types';
import { isExecutionCard } from '../../shared/execution-block';

export default function MarkdownMessage({ content, streaming, executionCards, onImageClick }: { content: string; streaming: boolean; executionCards?: ExecutionCardDTO[]; onImageClick?: (src: string, alt: string) => void }) {
  const { thinking, executions, answer, sawThinkTag, sawExecutionBlock } = splitThinkBlocks(content);
  const cards = Array.isArray(executionCards) ? executionCards.filter(isExecutionCard) : [];
  if (!sawThinkTag && !sawExecutionBlock && !cards.length) return <div className="markdown"><StreamingMarkdown content={content} streaming={streaming} onImageClick={onImageClick} /></div>;
  const showThinking = Boolean(thinking.trim());
  return <div className="markdown">
    {showThinking && <details className="think-block" open={!answer.trim()}>
      <summary>思考过程</summary>
      <pre>{thinking}</pre>
    </details>}
    {executions.length > 0 && <ExecutionBlock blocks={executions} />}
    {cards.map(card => <ExecutionBlock key={card.executionId} card={card} />)}
    {answer && <StreamingMarkdown content={answer} streaming={streaming} onImageClick={onImageClick} />}
  </div>;
}
