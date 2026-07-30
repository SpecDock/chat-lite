import { useCallback, useState, type RefObject } from 'react';
import { Ellipsis, Search } from 'lucide-react';
import type { ConversationDTO } from '../../../shared/types';
import type { ConversationActivity } from './conversationActivity';
import ConversationActionsMenu, { ConversationSummary } from './ConversationActionsMenu';

type Props = {
  conversations: ConversationDTO[];
  currentId?: string;
  statuses: Record<string, ConversationActivity>;
  searchTriggerRef: RefObject<HTMLButtonElement | null>;
  onSearch: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onPin: (id: string, pinned: boolean) => Promise<void>;
  onRename: (conversation: ConversationDTO, trigger: HTMLButtonElement) => void;
  onDelete: (conversation: ConversationDTO, trigger: HTMLButtonElement) => void;
};

type MenuTarget = {
  conversation: ConversationDTO;
  trigger: HTMLButtonElement;
  row: HTMLDivElement;
};

export default function ConversationList({ conversations, currentId, statuses, searchTriggerRef, onSearch, onSelect, onNew, onPin, onRename, onDelete }: Props) {
  const [menuTarget, setMenuTarget] = useState<MenuTarget>();
  const [pinningIds, setPinningIds] = useState<Set<string>>(() => new Set());
  const closeMenu = useCallback(() => setMenuTarget(undefined), []);

  const pinConversation = (conversation: ConversationDTO) => {
    if (pinningIds.has(conversation.id)) return;
    setPinningIds(ids => new Set(ids).add(conversation.id));
    void onPin(conversation.id, !conversation.pinned_at)
      .catch(() => undefined)
      .finally(() => setPinningIds(ids => {
        const next = new Set(ids);
        next.delete(conversation.id);
        return next;
      }));
  };

  const activeMenuConversation = menuTarget
    ? conversations.find(conversation => conversation.id === menuTarget.conversation.id) || menuTarget.conversation
    : undefined;

  return <aside className="convs"><div className="conv-actions">
    <button ref={searchTriggerRef} type="button" className="conversation-search-trigger" onClick={onSearch}>
      <Search size={17} aria-hidden="true" />
      <span>搜索消息</span>
    </button>
    <button className="new-conv" onClick={onNew}>＋ 新会话</button>
  </div><div className="conv-list">{conversations.map(c => {
    const activity = statuses[c.id];
    const menuOpen = menuTarget?.conversation.id === c.id;
    const menuId = `conversation-actions-${c.id}`;
    return <div className={`conv${c.id === currentId ? ' active' : ''}${menuOpen ? ' menu-open' : ''}`} data-status={activity?.status || 'idle'} key={c.id} onClick={() => onSelect(c.id)}>
      <ConversationSummary conversation={c} activity={activity} />
      <button
        type="button"
        className="conversation-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuId}
        aria-label={`打开“${c.title}”的会话操作`}
        title="会话操作"
        onClick={event => {
          event.stopPropagation();
          const row = event.currentTarget.closest<HTMLDivElement>('.conv');
          if (!row) return;
          setMenuTarget({ conversation: c, trigger: event.currentTarget, row });
        }}
      >
        <Ellipsis size={19} aria-hidden="true" />
      </button>
    </div>;
  })}</div>
    {menuTarget && activeMenuConversation && <ConversationActionsMenu
      id={`conversation-actions-${activeMenuConversation.id}`}
      conversation={activeMenuConversation}
      activity={statuses[activeMenuConversation.id]}
      trigger={menuTarget.trigger}
      row={menuTarget.row}
      pinDisabled={pinningIds.has(activeMenuConversation.id)}
      onClose={closeMenu}
      onPin={() => pinConversation(activeMenuConversation)}
      onRename={() => onRename(activeMenuConversation, menuTarget.trigger)}
      onDelete={() => onDelete(activeMenuConversation, menuTarget.trigger)}
    />}
  </aside>;
}
