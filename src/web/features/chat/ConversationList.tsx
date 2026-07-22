import type { ConversationDTO } from '../../../shared/types';
import type { ConversationActivity } from './conversationActivity';

type Props = {
  conversations: ConversationDTO[];
  currentId?: string;
  statuses: Record<string, ConversationActivity>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
};

export default function ConversationList({ conversations, currentId, statuses, onSelect, onNew, onDelete }: Props) {
  return <aside className="convs"><button className="new-conv" onClick={onNew}>＋ 新会话</button><div className="conv-list">{conversations.map(c => {
    const activity = statuses[c.id];
    return <div className={`conv ${c.id === currentId ? 'active' : ''}`} data-status={activity?.status || 'idle'} key={c.id} onClick={() => onSelect(c.id)}>
      {activity?.status === 'streaming' && <span className="conv-status-spinner" role="status" aria-label="正在生成" />}
      {activity?.unread && activity.status === 'completed' && <span className="conv-status-dot" role="status" aria-label="生成完成，有未读消息" />}
      {activity?.unread && activity.status === 'error' && <span className="conv-status-dot error" role="status" aria-label="生成失败，有未读消息" />}
      <span className="conv-title">{c.title}</span>
      <button aria-label="删除会话" disabled={activity?.status === 'streaming'} onClick={e => { e.stopPropagation(); onDelete(c.id); }}>×</button>
    </div>;
  })}</div></aside>;
}
