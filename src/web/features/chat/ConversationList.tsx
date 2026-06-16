import type { ConversationDTO } from '../../../shared/types';

export default function ConversationList({ conversations, currentId, onSelect, onNew, onDelete }: { conversations: ConversationDTO[]; currentId?: string; onSelect: (id: string) => void; onNew: () => void; onDelete: (id: string) => void }) {
  return <aside className="convs"><button className="new-conv" onClick={onNew}>＋ 新会话</button><div className="conv-list">{conversations.map(c => <div className={`conv ${c.id === currentId ? 'active' : ''}`} key={c.id} onClick={() => onSelect(c.id)}><span>{c.title}</span><button aria-label="删除会话" onClick={e => { e.stopPropagation(); onDelete(c.id); }}>×</button></div>)}</div></aside>;
}
