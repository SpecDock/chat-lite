import type { MessageSearchItemDTO, MessageStatus, Role } from '../../../shared/types.js';
import { all, db, row } from '../../core/db.js';
import { isModelVisibleMessage, stripThinkBlocks } from '../chat/message-visibility.js';

const PAGE_SIZE = 30;
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(\s*(?:<[^>]*>|(?:\\.|[^)])*)\s*\)/g;

type SourceMessage = {
  id: string;
  user_id: string;
  conversation_id: string;
  role: Role;
  content: string;
  status: MessageStatus;
  created_at: string;
};

type SearchRow = {
  rowid: number;
  message_id: string;
  conversation_id: string;
  conversation_title: string;
  role: 'user' | 'assistant';
  search_text: string;
  created_at: string;
};

export function cleanMessageSearchText(content: string) {
  return stripThinkBlocks(content).replace(MARKDOWN_IMAGE_RE, '$1').trim();
}

function deleteSearchDocument(messageId: string) {
  db.prepare('DELETE FROM message_search_documents WHERE message_id=?').run(messageId);
}

function writeSearchDocument(message: SourceMessage) {
  if (!isModelVisibleMessage(message)) {
    deleteSearchDocument(message.id);
    return;
  }
  db.prepare(`INSERT INTO message_search_documents
      (message_id,user_id,conversation_id,role,search_text,created_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(message_id) DO UPDATE SET
        user_id=excluded.user_id,
        conversation_id=excluded.conversation_id,
        role=excluded.role,
        search_text=excluded.search_text,
        created_at=excluded.created_at`
  ).run(
    message.id,
    message.user_id,
    message.conversation_id,
    message.role,
    cleanMessageSearchText(message.content),
    message.created_at
  );
}

export function syncMessageSearchDocument(messageId: string) {
  const message = row<SourceMessage>(
    'SELECT id,user_id,conversation_id,role,content,status,created_at FROM messages WHERE id=?',
    messageId
  );
  if (!message) {
    deleteSearchDocument(messageId);
    return;
  }
  writeSearchDocument(message);
}

export function initializeMessageSearch() {
  const initialize = db.transaction(() => {
    const indexed = all<SourceMessage & { message_id: string | null }>(`SELECT
        d.message_id,
        m.id,
        m.user_id,
        m.conversation_id,
        m.role,
        m.content,
        m.status,
        m.created_at
      FROM message_search_documents d
      LEFT JOIN messages m ON m.id=d.message_id`);
    for (const message of indexed) {
      if (!message.id || !isModelVisibleMessage(message)) deleteSearchDocument(message.message_id!);
    }

    const missing = all<SourceMessage>(`SELECT
        m.id,m.user_id,m.conversation_id,m.role,m.content,m.status,m.created_at
      FROM messages m
      LEFT JOIN message_search_documents d ON d.message_id=m.id
      WHERE d.message_id IS NULL`);
    for (const message of missing) {
      if (isModelVisibleMessage(message)) writeSearchDocument(message);
    }
  });
  initialize();
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, '\\$&');
}

function ftsPhrase(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function plainText(value: string) {
  return value
    .replace(MARKDOWN_IMAGE_RE, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '')
    .replace(/```[^\n]*\n?|`/g, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function makeSnippet(searchText: string, query: string) {
  const text = plainText(searchText);
  const matchIndex = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const characters = Array.from(text);
  const matchCharacter = matchIndex < 0 ? 0 : Array.from(text.slice(0, matchIndex)).length;
  let start = Math.max(0, matchCharacter - 60);
  let end = Math.min(characters.length, start + 160);
  if (end === characters.length) start = Math.max(0, end - 160);
  return `${start > 0 ? '...' : ''}${characters.slice(start, end).join('')}${end < characters.length ? '...' : ''}`;
}

export function searchMessages(userId: string, query: string, offset: number) {
  const limit = PAGE_SIZE + 1;
  const prefix = `${escapeLike(query)}%`;
  let rows: SearchRow[];
  if (Array.from(query).length >= 3) {
    rows = all<SearchRow>(`SELECT
        d.rowid,d.message_id,d.conversation_id,c.title AS conversation_title,
        d.role,d.search_text,d.created_at,bm25(message_search_fts) AS rank
      FROM message_search_fts
      JOIN message_search_documents d ON d.rowid=message_search_fts.rowid
      JOIN conversations c ON c.id=d.conversation_id
      WHERE message_search_fts MATCH ? AND d.user_id=?
      ORDER BY
        CASE WHEN d.search_text=? THEN 0 WHEN d.search_text LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END ASC,
        rank ASC,d.created_at DESC,d.rowid DESC
      LIMIT ? OFFSET ?`, ftsPhrase(query), userId, query, prefix, limit, offset);
  } else {
    rows = all<SearchRow>(`SELECT
        d.rowid,d.message_id,d.conversation_id,c.title AS conversation_title,
        d.role,d.search_text,d.created_at
      FROM message_search_documents d
      JOIN conversations c ON c.id=d.conversation_id
      WHERE d.user_id=? AND d.search_text LIKE ? ESCAPE '\\'
      ORDER BY
        CASE WHEN d.search_text=? THEN 0 WHEN instr(d.search_text,?)=1 THEN 1 ELSE 2 END ASC,
        d.created_at DESC,d.rowid DESC
      LIMIT ? OFFSET ?`, userId, `%${escapeLike(query)}%`, query, query, limit, offset);
  }

  const hasMore = rows.length > PAGE_SIZE;
  const items: MessageSearchItemDTO[] = rows.slice(0, PAGE_SIZE).map(result => ({
    messageId: result.message_id,
    conversationId: result.conversation_id,
    conversationTitle: result.conversation_title,
    role: result.role,
    snippet: makeSnippet(result.search_text, query),
    createdAt: result.created_at
  }));
  return { items, hasMore, nextOffset: hasMore ? offset + PAGE_SIZE : null };
}
