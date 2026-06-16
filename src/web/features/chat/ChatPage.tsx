import { useEffect, useRef, useState } from 'react';
import type { AttachmentDTO, ConversationDTO, MessageDTO, UserDTO } from '../../../shared/types';
import { api, streamChat } from '../../shared/api/client';
import ConversationList from './ConversationList';
import MessageList from './MessageList';
import MessageInput from './MessageInput';
import ProfileMenu from '../profile/ProfileMenu';

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
  try { return JSON.parse(event.data || '{}') as { conversationId?: string }; } catch { return {}; }
}

type ScrollIntent = 'restore' | 'bottom' | 'follow';

export default function ChatPage({ user, initialScroll, onLogout }: { user: UserDTO; initialScroll: 'restore' | 'bottom'; onLogout: () => void }) {
  const [profile, setProfile] = useState(user);
  const [convs, setConvs] = useState<ConversationDTO[]>([]);
  const [current, setCurrent] = useState<string>();
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [pending, setPending] = useState<AttachmentDTO[]>([]);
  const [busy, setBusy] = useState(false);
  const [refillText, setRefillText] = useState('');
  const [refillKey, setRefillKey] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const [err, setErr] = useState('');
  const [scrollIntent, setScrollIntent] = useState<ScrollIntent>(initialScroll);
  const restoredRef = useRef(false);
  const streamingRef = useRef(false);
  const currentRef = useRef<string>();
  const abortRef = useRef<AbortController | null>(null);
  const cancelRequestedRef = useRef(false);
  const activeAssistantIdRef = useRef('');
  const activeSentTextRef = useRef('');
  const storageKey = `chat-lite:last-conversation:${user.id}`;

  const refreshConversations = async () => {
    const r = await api.listConversations();
    setConvs(r.conversations);
    return r.conversations;
  };

  const refreshMessages = async (conversationId = currentRef.current) => {
    if (!conversationId || streamingRef.current) return;
    const r = await api.messages(conversationId).catch(error => {
      if (error instanceof Error && /404|会话不存在|文件不存在/.test(error.message)) {
        setCurrent(undefined);
        setMessages([]);
        safeRemoveItem(storageKey);
      }
      return undefined;
    });
    if (r && currentRef.current === conversationId) setMessages(r.messages);
  };

  const refreshAll = async () => {
    const list = await refreshConversations();
    const active = currentRef.current;
    if (active && !list.some(c => c.id === active)) {
      setCurrent(undefined);
      setMessages([]);
      safeRemoveItem(storageKey);
      return;
    }
    await refreshMessages(active);
  };

  useEffect(() => { currentRef.current = current; }, [current]);

  useEffect(() => {
    if (!current) return;
    safeSetItem(storageKey, current);
  }, [current, storageKey]);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    void (async () => {
      const list = await refreshConversations();
      const saved = safeGetItem(storageKey);
      if (saved && list.some(c => c.id === saved)) {
        setScrollIntent(initialScroll);
        setCurrent(saved);
      } else if (!saved && list.length === 1) {
        setScrollIntent(initialScroll === 'bottom' ? 'bottom' : 'restore');
        setCurrent(list[0].id);
      }
    })().catch(error => setErr(error instanceof Error ? error.message : '会话加载失败'));
  }, [initialScroll, storageKey]);

  useEffect(() => {
    if (!current) {
      setMessages([]);
      return;
    }
    void refreshMessages(current);
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
      if (data.conversationId && data.conversationId === currentRef.current) void refreshMessages(data.conversationId).catch(() => undefined);
      void refreshConversations().catch(() => undefined);
    };
    const onConversationDeleted = (event: MessageEvent) => {
      const data = parseEventData(event);
      if (data.conversationId && data.conversationId === currentRef.current) {
        setCurrent(undefined);
        setMessages([]);
        safeRemoveItem(storageKey);
      }
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

  function cancelActiveRequest() {
    if (!busy) return;
    cancelRequestedRef.current = true;
    abortRef.current?.abort();
    setBusy(false);
    streamingRef.current = false;
    setRefillText(activeSentTextRef.current);
    setRefillKey(key => key + 1);
    const assistantId = activeAssistantIdRef.current;
    if (assistantId) setMessages(m => m.map(x => x.id === assistantId ? { ...x, status: 'interrupted' } : x));
  }

  async function send(text: string) {
    if (busy) { cancelActiveRequest(); return; }
    streamingRef.current = true;
    setScrollIntent('follow');
    setBusy(true);
    setErr('');
    cancelRequestedRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;
    const attachments = pending;
    setPending([]);

    const userText = text.trim() || (attachments.length ? '请描述这张图片' : '');
    activeSentTextRef.current = userText;
    const userContent = attachments.length ? `${userText}\n\n${attachments.map(a => `![${a.original_name}](${a.public_path})`).join('\n')}` : userText;
    const tempUser: MessageDTO = { id: crypto.randomUUID(), conversation_id: current || '', role: 'user', content: userContent, status: 'completed', created_at: new Date().toISOString() };
    const tempAssistant: MessageDTO = { id: crypto.randomUUID(), conversation_id: current || '', role: 'assistant', content: '', status: 'streaming', created_at: new Date().toISOString() };
    let assistantMessageId = tempAssistant.id;
    activeAssistantIdRef.current = assistantMessageId;
    let thinkStarted = false;
    let thinkClosed = false;

    setMessages(m => [...m, tempUser, tempAssistant]);

    try {
      await streamChat(current, userText, attachments.map(a => a.id), (event, data) => {
        if (event === 'meta') {
          assistantMessageId = data.messageId || assistantMessageId;
          activeAssistantIdRef.current = assistantMessageId;
          if (!current) setCurrent(data.conversationId);
          setMessages(m => m.map(x => {
            if (x.id === tempUser.id) return { ...x, id: data.userMessageId || x.id, conversation_id: data.conversationId || x.conversation_id };
            if (x.id === tempAssistant.id) return { ...x, id: assistantMessageId, conversation_id: data.conversationId || x.conversation_id };
            return x;
          }));
        }
        if (event === 'think') {
          thinkStarted = true;
          setMessages(m => m.map(x => x.id === assistantMessageId ? { ...x, content: `${x.content || '<think>\n'}${data.text}\n` } : x));
        }
        if (event === 'delta') {
          const prefix = thinkStarted && !thinkClosed ? '</think>\n\n' : '';
          thinkClosed = thinkStarted || thinkClosed;
          setMessages(m => m.map(x => x.id === assistantMessageId ? { ...x, content: x.content + prefix + data.text } : x));
        }
        if (event === 'done') {
          if (thinkStarted && !thinkClosed) setMessages(m => m.map(x => x.id === assistantMessageId ? { ...x, content: `${x.content}</think>` } : x));
          window.setTimeout(refreshConversations, 1600);
          window.setTimeout(refreshConversations, 5000);
        }
        if (event === 'cancelled') setMessages(m => m.map(x => x.id === assistantMessageId ? { ...x, status: 'interrupted' } : x));
        if (event === 'error') {
          setErr(data.error);
          setMessages(m => m.map(x => {
            if (x.id !== assistantMessageId) return x;
            const content = thinkStarted && !thinkClosed ? `${x.content}</think>` : x.content;
            return { ...x, content, status: 'error' };
          }));
        }
      }, controller.signal);
      await refreshConversations();
    } catch (e) {
      if (cancelRequestedRef.current || (e instanceof DOMException && e.name === 'AbortError')) {
        setRefillText(userText);
        setRefillKey(key => key + 1);
        setMessages(m => m.map(x => x.id === assistantMessageId ? { ...x, status: 'interrupted' } : x));
      } else {
        setPending(attachments);
        setErr(e instanceof Error ? e.message : '发送失败');
      }
    } finally {
      if (abortRef.current === controller) {
        setBusy(false);
        streamingRef.current = false;
        abortRef.current = null;
        activeAssistantIdRef.current = '';
      }
    }
  }

  return <div className="app"><header className="topbar"><button className="icon-button menu-button" aria-label="打开会话" onClick={() => setDrawer(!drawer)}>☰</button><strong className="brand">chat-lite</strong><span className="user-email">{profile.email}</span><ProfileMenu user={profile} onUserChange={setProfile} /><button className="secondary" onClick={onLogout}>退出</button></header><div className="layout">{drawer && <button className="drawer-backdrop" aria-label="关闭会话" onClick={() => setDrawer(false)} />}<div className={drawer ? 'drawer open' : 'drawer'}><ConversationList conversations={convs} currentId={current} onSelect={id => { setScrollIntent('bottom'); setCurrent(id); setDrawer(false); }} onNew={async () => { const c = (await api.createConversation()).conversation; setConvs([c, ...convs]); setScrollIntent('bottom'); setCurrent(c.id); setDrawer(false); }} onDelete={async id => { await api.deleteConversation(id); if (id === currentRef.current) { safeRemoveItem(storageKey); setCurrent(undefined); setMessages([]); } await refreshConversations(); }} /></div><main className="chat">{err && <div className="error app-error">{err}</div>}<MessageList messages={messages} conversationId={current} storageKey={`chat-lite:scroll:${user.id}:${current || 'none'}`} scrollIntent={scrollIntent} /><MessageInput disabled={busy} sending={busy} refillText={refillText} refillKey={refillKey} pending={pending} onSend={send} onCancel={cancelActiveRequest} onRemoveImage={id => setPending(x => x.filter(a => a.id !== id))} onImage={async f => { try { const r = await api.upload(f, currentRef.current); setPending(x => [...x, r.attachment]); } catch (e) { setErr(e instanceof Error ? e.message : '上传失败'); } }} /></main></div></div>;
}
