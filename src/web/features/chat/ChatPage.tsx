import { useEffect, useRef, useState } from 'react';
import type { AttachmentDTO, ConversationDTO, MessageDTO, SearchMessageResultDTO, UserDTO } from '../../../shared/types';
import { api, streamChat, type ChatStreamData } from '../../shared/api/client';
import ConversationList from './ConversationList';
import ConversationSearch from './ConversationSearch';
import DeleteConversationDialog from './DeleteConversationDialog';
import DeleteMessageDialog from './DeleteMessageDialog';
import MessageInput from './MessageInput';
import MessageList from './MessageList';
import RenameConversationDialog from './RenameConversationDialog';
import {
  clearConversationUnread,
  migrateConversationActivity,
  parseUnreadActivities,
  removeConversationActivity,
  serializeUnreadActivities,
  transitionConversationActivity,
  type ConversationActivities
} from './conversationActivity';
import { composeUserMessage, splitUserMessage } from './messageContent';
import {
  drainConversationDelta,
  enqueueConversationDelta,
  normalizeStreamingMarkdownInterval,
  type ConversationDeltaBufferState,
  type DeltaFlushScheduler,
} from './conversationDeltaBuffer';
import ProfileMenu from '../profile/ProfileMenu';

const EMPTY_CONVERSATION_KEY = '__none__';
const TEMPORARY_CONVERSATION_PREFIX = '__temporary__:';

function safeGetItem(key: string) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function safeSetItem(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* ignore unavailable storage */ }
}

function safeRemoveItem(key: string) {
  try { window.localStorage.removeItem(key); } catch { /* ignore unavailable storage */ }
}

function parseEventData(event: MessageEvent) {
  try {
    return JSON.parse(event.data || '{}') as { conversationId?: string; reason?: string };
  } catch {
    return {};
  }
}

function replacePair(messages: MessageDTO[], userIndex: number, user: MessageDTO, assistant: MessageDTO) {
  const hasAssistant = messages[userIndex + 1]?.role === 'assistant';
  return [
    ...messages.slice(0, userIndex),
    user,
    assistant,
    ...messages.slice(userIndex + (hasAssistant ? 2 : 1))
  ];
}

function isTemporaryKey(key?: string) {
  return Boolean(key?.startsWith(TEMPORARY_CONVERSATION_PREFIX));
}

function conversationIdForKey(key?: string) {
  return key && key !== EMPTY_CONVERSATION_KEY && !isTemporaryKey(key) ? key : undefined;
}

function moveRecordValue<T>(record: Record<string, T>, fromKey: string, toKey: string): Record<string, T> {
  if (fromKey === toKey || !(fromKey in record)) return record;
  const next = { ...record, [toKey]: record[fromKey] };
  delete next[fromKey];
  return next;
}

function removeRecordValue<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

type ScrollIntent = 'restore' | 'bottom' | 'follow';
type EditMode = 'replace' | 'append';
type Operation = 'send' | 'edit';

type ActiveTask = ConversationDeltaBufferState & {
  controller: AbortController;
  assistantId: string;
  sentText: string;
  operation: Operation;
  cancelRequested: boolean;
};

const viteEnv = (import.meta as ImportMeta & { readonly env: Record<string, string | undefined> }).env;
const streamingMarkdownInterval = normalizeStreamingMarkdownInterval(viteEnv.VITE_STREAM_MARKDOWN_INTERVAL_MS);
const deltaFlushScheduler: DeltaFlushScheduler = {
  schedule: callback => window.setTimeout(callback, streamingMarkdownInterval),
  cancel: handle => window.clearTimeout(handle),
};

type Refill = { text: string; key: number };
type JumpTarget = { conversationId: string; messageId: string };
type ConversationDialogTarget = { conversation: ConversationDTO; trigger: HTMLButtonElement };

type StreamOptions = {
  conversationId?: string;
  text: string;
  attachmentIds: string[];
  editUserMessageId?: string;
  tempAssistantId: string;
  task: ActiveTask;
  getTargetKey: () => string;
  alignMeta: (data: ChatStreamData, assistantMessageId: string) => void;
};

export default function ChatPage({ user, initialScroll, onLogout }: { user: UserDTO; initialScroll: 'restore' | 'bottom'; onLogout: () => void }) {
  const storageKey = `chat-lite:last-conversation:${user.id}`;
  const activityStorageKey = `chat-lite:conversation-activity:${user.id}`;
  const [profile, setProfile] = useState(user);
  const [convs, setConvs] = useState<ConversationDTO[]>([]);
  const [current, setCurrent] = useState<string>();
  const [messagesByConversation, setMessagesByConversation] = useState<Record<string, MessageDTO[]>>({});
  const [pendingByConversation, setPendingByConversation] = useState<Record<string, AttachmentDTO[]>>({});
  const [refillByConversation, setRefillByConversation] = useState<Record<string, Refill>>({});
  const [errorsByConversation, setErrorsByConversation] = useState<Record<string, string>>({});
  const [activities, setActivities] = useState<ConversationActivities>(() => parseUnreadActivities(safeGetItem(activityStorageKey)));
  const [, setTaskRevision] = useState(0);
  const [editingMessageId, setEditingMessageId] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<MessageDTO>();
  const [renameConversationTarget, setRenameConversationTarget] = useState<ConversationDialogTarget>();
  const [deleteConversationTarget, setDeleteConversationTarget] = useState<ConversationDialogTarget>();
  const [drawer, setDrawer] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [jumpTarget, setJumpTarget] = useState<JumpTarget>();
  const [scrollIntent, setScrollIntent] = useState<ScrollIntent>(initialScroll);
  const restoredRef = useRef(false);
  const currentRef = useRef<string | undefined>(undefined);
  const tasksRef = useRef<Map<string, ActiveTask>>(new Map());
  const keyAliasesRef = useRef<Map<string, string>>(new Map());
  const searchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const searchSelectionRef = useRef(0);
  const [jumpReady, setJumpReady] = useState(false);

  const currentKey = current || EMPTY_CONVERSATION_KEY;
  const currentConversationId = conversationIdForKey(current);
  const messages = messagesByConversation[currentKey] || [];
  const pending = pendingByConversation[currentKey] || [];
  const refill = refillByConversation[currentKey] || { text: '', key: 0 };
  const currentTask = tasksRef.current.get(currentKey);
  const hasStreamingMessage = messages.some(message => message.status === 'streaming');
  const conversationStreaming = activities[currentKey]?.status === 'streaming' || hasStreamingMessage;
  const interactionBusy = Boolean(currentTask) || conversationStreaming;
  const actionsDisabled = interactionBusy || Boolean(editingMessageId) || Boolean(deleteTarget);
  const err = errorsByConversation[currentKey] || '';

  function bumpTasks() {
    setTaskRevision(revision => revision + 1);
  }

  function updateMessages(key: string, update: (messages: MessageDTO[]) => MessageDTO[]) {
    setMessagesByConversation(cache => ({ ...cache, [key]: update(cache[key] || []) }));
  }

  function flushTaskDelta(task: ActiveTask) {
    const pending = drainConversationDelta(task, deltaFlushScheduler);
    if (!pending) return;
    const targetKey = resolveKey(pending.targetKey);
    updateMessages(targetKey, currentMessages => currentMessages.map(message => message.id === pending.assistantId
      ? { ...message, content: message.content + pending.text }
      : message));
  }

  function queueTaskDelta(task: ActiveTask, text: string, targetKey: string, assistantId: string) {
    const delta = { text, targetKey: resolveKey(targetKey), assistantId };
    if (!enqueueConversationDelta(task, delta, deltaFlushScheduler, () => flushTaskDelta(task))) {
      flushTaskDelta(task);
      enqueueConversationDelta(task, delta, deltaFlushScheduler, () => flushTaskDelta(task));
    }
  }

  function setConversationError(key: string, error: string) {
    setErrorsByConversation(errors => error
      ? { ...errors, [key]: error }
      : removeRecordValue(errors, key));
  }

  function resolveKey(key: string) {
    let resolved = key;
    const visited = new Set<string>();
    while (keyAliasesRef.current.has(resolved) && !visited.has(resolved)) {
      visited.add(resolved);
      resolved = keyAliasesRef.current.get(resolved) as string;
    }
    return resolved;
  }

  function setActivity(key: string, status: 'streaming' | 'completed' | 'error') {
    const isOpen = (currentRef.current || EMPTY_CONVERSATION_KEY) === key;
    setActivities(currentActivities => transitionConversationActivity(currentActivities, key, status, isOpen));
  }

  function removeTask(task: ActiveTask) {
    flushTaskDelta(task);
    for (const [key, candidate] of tasksRef.current) {
      if (candidate === task) {
        tasksRef.current.delete(key);
        bumpTasks();
        return;
      }
    }
  }

  function migrateConversationKey(fromKey: string, toKey: string) {
    if (fromKey === toKey) return;
    keyAliasesRef.current.set(fromKey, toKey);
    setMessagesByConversation(cache => moveRecordValue(cache, fromKey, toKey));
    setPendingByConversation(cache => moveRecordValue(cache, fromKey, toKey));
    setRefillByConversation(cache => moveRecordValue(cache, fromKey, toKey));
    setErrorsByConversation(cache => moveRecordValue(cache, fromKey, toKey));
    setActivities(currentActivities => migrateConversationActivity(currentActivities, fromKey, toKey));
    const task = tasksRef.current.get(fromKey);
    if (task) {
      tasksRef.current.delete(fromKey);
      tasksRef.current.set(toKey, task);
      bumpTasks();
    }
    if ((currentRef.current || EMPTY_CONVERSATION_KEY) === fromKey) {
      currentRef.current = toKey;
      setCurrent(toKey);
    }
  }

  function removeConversationState(key: string) {
    const task = tasksRef.current.get(key);
    if (task) {
      flushTaskDelta(task);
      task.controller.abort();
    }
    tasksRef.current.delete(key);
    setMessagesByConversation(cache => removeRecordValue(cache, key));
    setPendingByConversation(cache => removeRecordValue(cache, key));
    setRefillByConversation(cache => removeRecordValue(cache, key));
    setErrorsByConversation(cache => removeRecordValue(cache, key));
    setActivities(currentActivities => removeConversationActivity(currentActivities, key));
    bumpTasks();
  }

  function clearDeletedConversation(conversationId: string) {
    removeConversationState(conversationId);
    if (currentRef.current === conversationId) {
      currentRef.current = undefined;
      keyAliasesRef.current.delete(EMPTY_CONVERSATION_KEY);
      safeRemoveItem(storageKey);
      setCurrent(undefined);
    }
  }

  const refreshConversations = async () => {
    const result = await api.listConversations();
    setConvs(result.conversations);
    return result.conversations;
  };

  const refreshMessages = async (conversationId?: string, propagateError = false, isRelevant?: () => boolean) => {
    if (!conversationId) return;
    if (tasksRef.current.has(conversationId)) return messagesByConversation[conversationId];
    const result = await api.messages(conversationId).catch(error => {
      if (isRelevant && !isRelevant()) return undefined;
      if (error instanceof Error && /404|会话不存在|文件不存在/.test(error.message)) {
        clearDeletedConversation(conversationId);
      }
      if (propagateError) throw error;
      return undefined;
    });
    if (result && (!isRelevant || isRelevant()) && !tasksRef.current.has(conversationId)) {
      setMessagesByConversation(cache => ({ ...cache, [conversationId]: result.messages }));
      setActivities(currentActivities => {
        if (result.messages.some(message => message.status === 'streaming')) {
          return transitionConversationActivity(
            currentActivities,
            conversationId,
            'streaming',
            currentRef.current === conversationId
          );
        }
        if (currentActivities[conversationId]?.status !== 'streaming') return currentActivities;
        const latestAssistant = [...result.messages].reverse().find(message => message.role === 'assistant');
        if (latestAssistant?.status === 'completed') {
          return transitionConversationActivity(currentActivities, conversationId, 'completed', currentRef.current === conversationId);
        }
        if (latestAssistant?.status === 'error' || latestAssistant?.status === 'interrupted') {
          return transitionConversationActivity(currentActivities, conversationId, 'error', currentRef.current === conversationId);
        }
        return currentActivities;
      });
    }
    return result?.messages;
  };

  const refreshAll = async () => {
    const list = await refreshConversations();
    const active = conversationIdForKey(currentRef.current);
    if (active && !list.some(conversation => conversation.id === active)) {
      clearDeletedConversation(active);
      return;
    }
    await refreshMessages(active);
  };

  useEffect(() => { currentRef.current = current; }, [current]);

  useEffect(() => {
    if (currentConversationId) safeSetItem(storageKey, currentConversationId);
  }, [currentConversationId, storageKey]);

  useEffect(() => {
    safeSetItem(activityStorageKey, serializeUnreadActivities(activities));
  }, [activities, activityStorageKey]);

  useEffect(() => {
    if (!current) return;
    setActivities(currentActivities => clearConversationUnread(currentActivities, current));
  }, [current]);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    void (async () => {
      const list = await refreshConversations();
      const saved = safeGetItem(storageKey);
      if (saved && list.some(conversation => conversation.id === saved)) {
        setScrollIntent(initialScroll);
        currentRef.current = saved;
        setCurrent(saved);
      } else if (!saved && list.length === 1) {
        setScrollIntent(initialScroll === 'bottom' ? 'bottom' : 'restore');
        currentRef.current = list[0].id;
        setCurrent(list[0].id);
      }
    })().catch(error => setConversationError(EMPTY_CONVERSATION_KEY, error instanceof Error ? error.message : '会话加载失败'));
  }, [initialScroll, storageKey]);

  useEffect(() => {
    setEditingMessageId(undefined);
    setDeleteTarget(undefined);
    const conversationId = conversationIdForKey(current);
    if (conversationId) void refreshMessages(conversationId);
  }, [current]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      const onFocus = () => { void refreshAll().catch(() => undefined); };
      window.addEventListener('focus', onFocus);
      return () => window.removeEventListener('focus', onFocus);
    }

    const events = new EventSource('/api/events', { withCredentials: true });
    const onConversationsChanged = () => { void refreshConversations().catch(() => undefined); };
    const onMessagesChanged = (event: MessageEvent) => {
      const data = parseEventData(event);
      const conversationId = data.conversationId;
      if (!conversationId) return;
      const hasLocalTask = tasksRef.current.has(conversationId);
      if (!hasLocalTask) {
        if (data.reason === 'user_message' || data.reason === 'user_message_edited') setActivity(conversationId, 'streaming');
        if (data.reason === 'assistant_completed') setActivity(conversationId, 'completed');
        if (data.reason === 'assistant_error' || data.reason === 'assistant_interrupted') setActivity(conversationId, 'error');
        void refreshMessages(conversationId).catch(() => undefined);
      }
      void refreshConversations().catch(() => undefined);
    };
    const onConversationDeleted = (event: MessageEvent) => {
      const data = parseEventData(event);
      if (!data.conversationId) return;
      clearDeletedConversation(data.conversationId);
      void refreshConversations().catch(() => undefined);
    };
    const onFocus = () => { void refreshAll().catch(() => undefined); };

    events.addEventListener('conversations_changed', onConversationsChanged);
    events.addEventListener('messages_changed', onMessagesChanged);
    events.addEventListener('conversation_deleted', onConversationDeleted);
    window.addEventListener('focus', onFocus);
    events.onerror = () => { /* EventSource auto-reconnects; focus refresh remains as fallback. */ };

    return () => {
      events.close();
      window.removeEventListener('focus', onFocus);
    };
  }, [storageKey]);

  useEffect(() => {
    const abortTasks = () => {
      for (const task of tasksRef.current.values()) {
        flushTaskDelta(task);
        task.controller.abort();
      }
      tasksRef.current.clear();
    };
    window.addEventListener('pagehide', abortTasks);
    return () => {
      window.removeEventListener('pagehide', abortTasks);
      abortTasks();
    };
  }, []);

  async function consumeStream(options: StreamOptions) {
    let assistantMessageId = options.tempAssistantId;
    let thinkStarted = false;
    let thinkClosed = false;
    let terminalEvent = false;

    try {
      await streamChat(options.conversationId, options.text, options.attachmentIds, (event, data) => {
      if (event !== 'delta') flushTaskDelta(options.task);
      if (event === 'meta') {
        assistantMessageId = data.messageId || assistantMessageId;
        options.task.assistantId = assistantMessageId;
        options.alignMeta(data, assistantMessageId);
      }
      const targetKey = options.getTargetKey();
      if (event === 'think') {
        const reopenThink = thinkStarted && thinkClosed;
        thinkStarted = true;
        if (reopenThink) thinkClosed = false;
        updateMessages(targetKey, currentMessages => currentMessages.map(message => {
          if (message.id !== assistantMessageId) return message;
          const prefix = !message.content || reopenThink ? '<think>\n' : '';
          return { ...message, content: `${message.content}${prefix}${data.text || ''}\n` };
        }));
      }
      if (event === 'delta') {
        const prefix = thinkStarted && !thinkClosed ? '</think>\n\n' : '';
        thinkClosed = thinkStarted || thinkClosed;
        queueTaskDelta(options.task, prefix + (data.text || ''), targetKey, assistantMessageId);
      }
      if (event === 'done') {
        terminalEvent = true;
        updateMessages(targetKey, currentMessages => currentMessages.map(message => {
          if (message.id !== assistantMessageId) return message;
          const content = thinkStarted && !thinkClosed ? `${message.content}</think>` : message.content;
          return { ...message, content, status: 'completed' };
        }));
        setActivity(targetKey, 'completed');
        window.setTimeout(() => { void refreshConversations().catch(() => undefined); }, 1600);
        window.setTimeout(() => { void refreshConversations().catch(() => undefined); }, 5000);
      }
      if (event === 'cancelled') {
        terminalEvent = true;
        updateMessages(targetKey, currentMessages => currentMessages.map(message => message.id === assistantMessageId
          ? { ...message, content: message.content || '已取消', status: 'interrupted' }
          : message));
        setActivity(targetKey, 'error');
      }
      if (event === 'error') {
        terminalEvent = true;
        const errorText = data.error || '请求失败';
        setConversationError(targetKey, errorText);
        updateMessages(targetKey, currentMessages => currentMessages.map(message => {
          if (message.id !== assistantMessageId) return message;
          const content = `${thinkStarted && !thinkClosed ? `${message.content}</think>\n\n` : message.content}${errorText}`;
          return { ...message, content, status: 'error' };
        }));
        setActivity(targetKey, 'error');
      }
      }, options.task.controller.signal, options.editUserMessageId);
    } finally {
      flushTaskDelta(options.task);
    }

    if (!terminalEvent && !options.task.controller.signal.aborted) throw new Error('回答连接已中断');
    return assistantMessageId;
  }

  function cancelCurrentRequest() {
    const key = currentRef.current || EMPTY_CONVERSATION_KEY;
    const task = tasksRef.current.get(key);
    if (!task) return;
    flushTaskDelta(task);
    task.cancelRequested = true;
    task.controller.abort();
    if (task.operation === 'send') {
      setRefillByConversation(refills => ({ ...refills, [key]: { text: task.sentText, key: (refills[key]?.key || 0) + 1 } }));
    }
    updateMessages(key, currentMessages => currentMessages.map(message => message.id === task.assistantId
      ? { ...message, content: message.content || '已取消', status: 'interrupted' }
      : message));
    setActivity(key, 'error');
  }

  async function send(text: string) {
    let targetKey = currentRef.current || EMPTY_CONVERSATION_KEY;
    const conversationId = conversationIdForKey(targetKey);
    const targetMessages = messagesByConversation[targetKey] || [];
    if (tasksRef.current.has(targetKey) || activities[targetKey]?.status === 'streaming' || targetMessages.some(message => message.status === 'streaming')) return;

    if (!conversationId) {
      const temporaryKey = `${TEMPORARY_CONVERSATION_PREFIX}${crypto.randomUUID()}`;
      migrateConversationKey(targetKey, temporaryKey);
      targetKey = temporaryKey;
    }

    setScrollIntent('follow');
    setConversationError(targetKey, '');
    const controller = new AbortController();
    const attachments = pendingByConversation[currentRef.current || EMPTY_CONVERSATION_KEY] || pendingByConversation[targetKey] || pending;
    setPendingByConversation(cache => ({ ...cache, [targetKey]: [] }));
    const userText = text.trim();
    const userContent = attachments.length ? `${userText}\n\n${attachments.map(attachment => `![${attachment.original_name}](${attachment.public_path})`).join('\n')}` : userText;
    const now = new Date().toISOString();
    const tempUser: MessageDTO = { id: crypto.randomUUID(), conversation_id: conversationId || '', role: 'user', content: userContent, status: 'completed', created_at: now };
    const tempAssistant: MessageDTO = { id: crypto.randomUUID(), conversation_id: conversationId || '', role: 'assistant', content: '', status: 'streaming', created_at: now };
    const task: ActiveTask = {
      controller,
      assistantId: tempAssistant.id,
      sentText: userText,
      operation: 'send',
      cancelRequested: false,
      pendingDelta: '',
      deltaFlushHandle: null,
    };
    tasksRef.current.set(targetKey, task);
    bumpTasks();
    setActivity(targetKey, 'streaming');
    updateMessages(targetKey, currentMessages => [...currentMessages, tempUser, tempAssistant]);

    try {
      await consumeStream({
        conversationId,
        text: userText,
        attachmentIds: attachments.map(attachment => attachment.id),
        tempAssistantId: tempAssistant.id,
        task,
        getTargetKey: () => targetKey,
        alignMeta: (data, assistantMessageId) => {
          if (data.conversationId && data.conversationId !== targetKey) {
            const previousKey = targetKey;
            targetKey = data.conversationId;
            migrateConversationKey(previousKey, targetKey);
          }
          updateMessages(targetKey, currentMessages => currentMessages.map(message => {
            if (message.id === tempUser.id) return { ...message, id: data.userMessageId || message.id, conversation_id: data.conversationId || message.conversation_id };
            if (message.id === tempAssistant.id) return { ...message, id: assistantMessageId, conversation_id: data.conversationId || message.conversation_id };
            return message;
          }));
        }
      });
      await refreshConversations();
    } catch (cause) {
      flushTaskDelta(task);
      const cancelled = task.cancelRequested || (cause instanceof DOMException && cause.name === 'AbortError');
      if (cancelled) {
        setRefillByConversation(refills => ({ ...refills, [targetKey]: { text: userText, key: (refills[targetKey]?.key || 0) + 1 } }));
        updateMessages(targetKey, currentMessages => currentMessages.map(message => message.id === task.assistantId
          ? { ...message, content: message.content || '已取消', status: 'interrupted' }
          : message));
      } else {
        const errorText = cause instanceof Error ? cause.message : '发送失败';
        setPendingByConversation(cache => ({ ...cache, [targetKey]: attachments }));
        setConversationError(targetKey, errorText);
        updateMessages(targetKey, currentMessages => currentMessages.map(message => message.id === task.assistantId
          ? { ...message, content: message.content || errorText, status: 'error' }
          : message));
      }
      setActivity(targetKey, 'error');
    } finally {
      flushTaskDelta(task);
      removeTask(task);
      const resolvedConversationId = conversationIdForKey(targetKey);
      if (resolvedConversationId) await refreshMessages(resolvedConversationId).catch(() => undefined);
    }
  }

  function startEdit(message: MessageDTO) {
    if (message.role !== 'user' || actionsDisabled) return;
    setConversationError(message.conversation_id, '');
    setEditingMessageId(message.id);
  }

  async function confirmEdit(message: MessageDTO, text: string) {
    const targetKey = message.conversation_id;
    const baseMessages = messagesByConversation[targetKey] || [];
    if (tasksRef.current.has(targetKey) || activities[targetKey]?.status === 'streaming' || baseMessages.some(candidate => candidate.status === 'streaming')) return;
    const userIndex = baseMessages.findIndex(candidate => candidate.id === message.id && candidate.role === 'user');
    if (userIndex < 0) return;
    const parts = splitUserMessage(message);
    const editedText = text.trim();
    if (!editedText && parts.images.length === 0) return;

    const latestUserIndex = baseMessages.reduce((latest, candidate, index) => candidate.role === 'user' ? index : latest, -1);
    const optimisticMode: EditMode = latestUserIndex === userIndex ? 'replace' : 'append';
    const now = new Date().toISOString();
    const editedContent = composeUserMessage(editedText, parts.images);
    const replacementUser: MessageDTO = { ...message, content: editedContent, status: 'completed' };
    const appendedUser: MessageDTO = { ...replacementUser, id: crypto.randomUUID(), created_at: now };
    const tempAssistant: MessageDTO = { id: crypto.randomUUID(), conversation_id: targetKey, role: 'assistant', content: '', status: 'streaming', created_at: now };
    const optimisticUserId = optimisticMode === 'replace' ? replacementUser.id : appendedUser.id;
    const controller = new AbortController();
    const task: ActiveTask = {
      controller,
      assistantId: tempAssistant.id,
      sentText: editedText,
      operation: 'edit',
      cancelRequested: false,
      pendingDelta: '',
      deltaFlushHandle: null,
    };
    let editAcknowledged = false;

    setEditingMessageId(undefined);
    setDeleteTarget(undefined);
    setConversationError(targetKey, '');
    setScrollIntent(optimisticMode === 'append' ? 'follow' : 'bottom');
    setMessagesByConversation(cache => ({
      ...cache,
      [targetKey]: optimisticMode === 'replace'
        ? replacePair(baseMessages, userIndex, replacementUser, tempAssistant)
        : [...baseMessages, appendedUser, tempAssistant]
    }));
    tasksRef.current.set(targetKey, task);
    bumpTasks();
    setActivity(targetKey, 'streaming');

    try {
      await consumeStream({
        conversationId: targetKey,
        text: editedText,
        attachmentIds: [],
        editUserMessageId: message.id,
        tempAssistantId: tempAssistant.id,
        task,
        getTargetKey: () => targetKey,
        alignMeta: (data, assistantMessageId) => {
          editAcknowledged = true;
          const actualMode = data.mode || optimisticMode;
          const realConversationId = data.conversationId || targetKey;
          if (actualMode !== optimisticMode) {
            const realUser = actualMode === 'replace'
              ? { ...replacementUser, id: data.userMessageId || replacementUser.id, conversation_id: realConversationId }
              : { ...appendedUser, id: data.userMessageId || appendedUser.id, conversation_id: realConversationId };
            setMessagesByConversation(cache => ({
              ...cache,
              [targetKey]: (() => {
                const currentAssistant = (cache[targetKey] || []).find(candidate => candidate.id === tempAssistant.id);
                const realAssistant = {
                  ...tempAssistant,
                  content: currentAssistant?.content || tempAssistant.content,
                  id: assistantMessageId,
                  conversation_id: realConversationId,
                };
                return actualMode === 'replace'
                  ? replacePair(baseMessages, userIndex, realUser, realAssistant)
                  : [...baseMessages, realUser, realAssistant];
              })()
            }));
            return;
          }
          updateMessages(targetKey, currentMessages => currentMessages.map(candidate => {
            if (candidate.id === optimisticUserId) return { ...candidate, id: data.userMessageId || candidate.id, conversation_id: realConversationId };
            if (candidate.id === tempAssistant.id) return { ...candidate, id: assistantMessageId, conversation_id: realConversationId };
            return candidate;
          }));
        }
      });
      await refreshConversations();
    } catch (cause) {
      flushTaskDelta(task);
      if (task.cancelRequested || (cause instanceof DOMException && cause.name === 'AbortError')) {
        updateMessages(targetKey, currentMessages => currentMessages.map(candidate => candidate.id === task.assistantId
          ? { ...candidate, content: candidate.content || '已取消', status: 'interrupted' }
          : candidate));
      } else {
        const errorText = cause instanceof Error ? cause.message : '编辑失败';
        setConversationError(targetKey, errorText);
        updateMessages(targetKey, currentMessages => currentMessages.map(candidate => candidate.id === task.assistantId
          ? { ...candidate, content: candidate.content || errorText, status: 'error' }
          : candidate));
      }
      setActivity(targetKey, 'error');
    } finally {
      flushTaskDelta(task);
      removeTask(task);
      if (editAcknowledged) await refreshMessages(targetKey).catch(() => undefined);
    }
  }

  function requestDelete(message: MessageDTO) {
    if (message.role !== 'user' || actionsDisabled) return;
    setConversationError(message.conversation_id, '');
    setDeleteTarget(message);
  }

  async function deleteMessage() {
    const target = deleteTarget;
    const conversationId = target?.conversation_id;
    if (!target || !conversationId || tasksRef.current.has(conversationId) || activities[conversationId]?.status === 'streaming') {
      throw new Error('当前无法删除消息');
    }
    try {
      const result = await api.deleteMessage(conversationId, target.id);
      if (result.conversationDeleted) {
        clearDeletedConversation(conversationId);
        await refreshConversations();
        return;
      }
      await Promise.all([refreshMessages(conversationId), refreshConversations()]);
    } catch (cause) {
      setConversationError(conversationId, cause instanceof Error ? cause.message : '删除失败');
      throw cause;
    }
  }

  function selectConversation(id: string) {
    searchSelectionRef.current += 1;
    setEditingMessageId(undefined);
    setDeleteTarget(undefined);
    setJumpTarget(undefined);
    setJumpReady(false);
    setScrollIntent('bottom');
    currentRef.current = id;
    setCurrent(id);
    setActivities(currentActivities => clearConversationUnread(currentActivities, id));
    setDrawer(false);
  }

  async function pinConversation(id: string, pinned: boolean) {
    const errorKey = currentRef.current || EMPTY_CONVERSATION_KEY;
    setConversationError(errorKey, '');
    try {
      await api.pinConversation(id, pinned);
      await refreshConversations();
    } catch (cause) {
      setConversationError(errorKey, cause instanceof Error ? cause.message : '置顶操作失败');
      throw cause;
    }
  }

  async function renameConversation(id: string, title: string) {
    const errorKey = currentRef.current || EMPTY_CONVERSATION_KEY;
    setConversationError(errorKey, '');
    try {
      await api.renameConversation(id, title);
      await refreshConversations();
    } catch (cause) {
      setConversationError(errorKey, cause instanceof Error ? cause.message : '重命名失败');
      throw cause;
    }
  }

  async function deleteConversation(id: string) {
    const errorKey = currentRef.current || EMPTY_CONVERSATION_KEY;
    if (activities[id]?.status === 'streaming') throw new Error('请先停止生成');
    setConversationError(errorKey, '');
    try {
      await api.deleteConversation(id);
      clearDeletedConversation(id);
      await refreshConversations();
    } catch (cause) {
      setConversationError(errorKey, cause instanceof Error ? cause.message : '删除会话失败');
      throw cause;
    }
  }

  function selectSearchResult(result: SearchMessageResultDTO) {
    const conversationId = result.conversationId;
    const selectionId = ++searchSelectionRef.current;
    const isSelectionActive = () => searchSelectionRef.current === selectionId;
    const isViewCurrent = () => isSelectionActive() && currentRef.current === conversationId;
    setSearchOpen(false);
    setDrawer(false);
    setEditingMessageId(undefined);
    setDeleteTarget(undefined);
    setJumpTarget(undefined);
    setJumpReady(false);
    setScrollIntent('restore');
    setConversationError(conversationId, '');
    currentRef.current = conversationId;
    setCurrent(conversationId);
    setActivities(currentActivities => clearConversationUnread(currentActivities, conversationId));

    const cachedMessages = messagesByConversation[conversationId];
    setJumpTarget({ conversationId, messageId: result.messageId });
    if (cachedMessages?.some(message => message.id === result.messageId)) {
      setJumpReady(true);
      return;
    }

    void refreshMessages(conversationId, true, isViewCurrent).then(loadedMessages => {
      if (!isViewCurrent()) return;
      if (loadedMessages?.some(message => message.id === result.messageId)) {
        setJumpReady(true);
      } else {
        setJumpTarget(undefined);
        setConversationError(conversationId, '消息已不存在');
      }
    }).catch(cause => {
      if (!isSelectionActive()) return;
      const missing = cause instanceof Error && /404|会话不存在|文件不存在/.test(cause.message);
      setJumpTarget(undefined);
      const targetKey = currentRef.current === conversationId ? conversationId : EMPTY_CONVERSATION_KEY;
      setConversationError(targetKey, missing ? '消息已不存在' : (cause instanceof Error ? cause.message : '消息加载失败'));
    });
  }

  function abortAllTasks() {
    for (const task of tasksRef.current.values()) {
      flushTaskDelta(task);
      task.controller.abort();
    }
    tasksRef.current.clear();
    bumpTasks();
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon-button menu-button" aria-label="打开会话" onClick={() => setDrawer(!drawer)}>☰</button>
        <strong className="brand">chat-lite</strong>
        <span className="user-email">{profile.email}</span>
        <ProfileMenu user={profile} onUserChange={setProfile} />
        <button className="secondary" onClick={() => { abortAllTasks(); onLogout(); }}>退出</button>
      </header>
      <div className="layout">
        {drawer && <button className="drawer-backdrop" aria-label="关闭会话" onClick={() => setDrawer(false)} />}
        <div className={drawer ? 'drawer open' : 'drawer'}>
          <ConversationList
            conversations={convs}
            currentId={currentConversationId}
            statuses={activities}
            searchTriggerRef={searchTriggerRef}
            onSearch={() => setSearchOpen(true)}
            onSelect={selectConversation}
            onNew={async () => {
              const conversation = (await api.createConversation()).conversation;
              setConvs(currentConversations => [
                ...currentConversations.filter(candidate => candidate.pinned_at),
                conversation,
                ...currentConversations.filter(candidate => !candidate.pinned_at),
              ]);
              selectConversation(conversation.id);
            }}
            onPin={pinConversation}
            onRename={(conversation, trigger) => setRenameConversationTarget({ conversation, trigger })}
            onDelete={(conversation, trigger) => setDeleteConversationTarget({ conversation, trigger })}
          />
        </div>
        <main className="chat">
          {err && <div className="error app-error">{err}</div>}
          <MessageList
            messages={messages}
            conversationId={current}
            storageKey={`chat-lite:scroll:${user.id}:${currentKey}`}
            scrollIntent={scrollIntent}
            editingMessageId={editingMessageId}
            actionsDisabled={actionsDisabled}
            editorDisabled={interactionBusy}
            onEdit={startEdit}
            onCancelEdit={() => setEditingMessageId(undefined)}
            onConfirmEdit={(message, text) => void confirmEdit(message, text)}
            onDelete={requestDelete}
            jumpMessageId={jumpTarget && jumpTarget.conversationId === currentConversationId ? jumpTarget.messageId : undefined}
            jumpReady={jumpReady}
            onJumpComplete={found => {
              const target = jumpTarget;
              setJumpTarget(undefined);
              setJumpReady(false);
              if (!found && target) setConversationError(target.conversationId, '消息已不存在');
            }}
          />
          <MessageInput
            disabled={interactionBusy || Boolean(editingMessageId) || Boolean(deleteTarget)}
            sending={Boolean(currentTask)}
            refillText={refill.text}
            refillKey={refill.key}
            pending={pending}
            onSend={send}
            onCancel={cancelCurrentRequest}
            onRemoveImage={id => setPendingByConversation(cache => ({
              ...cache,
              [currentKey]: (cache[currentKey] || []).filter(attachment => attachment.id !== id)
            }))}
            onImage={async file => {
              const uploadKey = currentRef.current || EMPTY_CONVERSATION_KEY;
              try {
                const result = await api.upload(file, conversationIdForKey(uploadKey));
                const targetKey = resolveKey(uploadKey);
                setPendingByConversation(cache => ({ ...cache, [targetKey]: [...(cache[targetKey] || []), result.attachment] }));
              } catch (cause) {
                setConversationError(resolveKey(uploadKey), cause instanceof Error ? cause.message : '上传失败');
              }
            }}
          />
        </main>
      </div>
      <ConversationSearch
        open={searchOpen}
        triggerRef={searchTriggerRef}
        onClose={() => setSearchOpen(false)}
        onSelect={selectSearchResult}
      />
      {renameConversationTarget && <RenameConversationDialog
        key={renameConversationTarget.conversation.id}
        open
        conversation={renameConversationTarget.conversation}
        trigger={renameConversationTarget.trigger}
        onClose={() => setRenameConversationTarget(undefined)}
        onConfirm={title => renameConversation(renameConversationTarget.conversation.id, title)}
      />}
      {deleteConversationTarget && <DeleteConversationDialog
        key={deleteConversationTarget.conversation.id}
        open
        conversation={deleteConversationTarget.conversation}
        trigger={deleteConversationTarget.trigger}
        streaming={activities[deleteConversationTarget.conversation.id]?.status === 'streaming'}
        onClose={() => setDeleteConversationTarget(undefined)}
        onConfirm={() => deleteConversation(deleteConversationTarget.conversation.id)}
      />}
      <DeleteMessageDialog key={deleteTarget?.id || 'closed'} open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(undefined)} onConfirm={deleteMessage} />
    </div>
  );
}
