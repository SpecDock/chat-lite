import { unlink } from 'node:fs/promises';
import { jsonError, type Router } from '../../core/http.js';
import { auth, newId, requireAuth, safeTitle } from '../../core/security.js';
import { streamAgentChat } from './agent.js';
import type { AgentUsage } from './agent.js';
import { emitToUser } from '../../core/events.js';
import { scheduleConversationTitle } from '../conversation-titles/title.js';
import { defaultChatModelName, estimateTokenUsage, recordTokenUsage } from '../usage/usage.service.js';
import {
  completeAssistantMessage,
  conversationExists,
  countValidAttachments,
  createConversation,
  deleteConversationData,
  failAssistantMessage,
  getConversation,
  insertAssistantStreamingMessage,
  insertUserMessage,
  interruptAssistantMessage,
  linkAttachmentsToMessage,
  listChatHistory,
  listConversations,
  listMessages,
  touchConversation,
  updateConversationTitle,
} from './chat.repo.js';

export function registerConversationRoutes(router: Router) {
  router.get('/api/conversations', requireAuth, (ctx) => {
    ctx.sendJson({ conversations: listConversations(auth(ctx).userId) });
  });

  router.post('/api/conversations', requireAuth, async (ctx) => {
    const body = await ctx.json().catch(() => ({}));
    const id = newId('conv');
    const conversation = createConversation(id, auth(ctx).userId, safeTitle(String(body.title || '新会话')));
    emitToUser(auth(ctx).userId, 'conversations_changed', { conversationId: id, reason: 'created' });
    ctx.sendJson({ conversation });
  });

  router.get('/api/conversations/:id', requireAuth, (ctx) => {
    const conversation = getConversation(ctx.params.id, auth(ctx).userId);
    if (!conversation) return jsonError(ctx, 404, '会话不存在');
    ctx.sendJson({ conversation });
  });

  router.delete('/api/conversations/:id', requireAuth, async (ctx) => {
    const userId = auth(ctx).userId;
    const conversationId = ctx.params.id;
    if (!conversationExists(conversationId, userId)) return jsonError(ctx, 404, '会话不存在');
    const attachments = deleteConversationData(conversationId, userId);
    await Promise.allSettled(attachments.map(a => unlink(a.file_path)));
    emitToUser(userId, 'conversation_deleted', { conversationId });
    emitToUser(userId, 'conversations_changed', { conversationId, reason: 'deleted' });
    ctx.sendJson({ ok: true });
  });

  router.get('/api/conversations/:id/messages', requireAuth, (ctx) => {
    if (!conversationExists(ctx.params.id, auth(ctx).userId)) return jsonError(ctx, 404, '会话不存在');
    const messages = listMessages(ctx.params.id, auth(ctx).userId);
    ctx.sendJson({ messages });
  });
}

export function registerChatRoutes(router: Router) {
  router.post('/api/chat', requireAuth, async (ctx) => {
    const body = await ctx.json().catch(() => ({}));
    const content = String(body.content || body.message || '').trim();
    let conversationId = String(body.conversationId || '').trim();
    const attachmentIds: string[] = Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String).filter(Boolean).slice(0, 4) : [];
    if (!content && attachmentIds.length === 0) return jsonError(ctx, 400, '消息不能为空');
    const userId = auth(ctx).userId;
    const userInput = content || '请描述这张图片';
    let createdConversation = false;
    if (!conversationId) {
      conversationId = newId('conv');
      createdConversation = true;
      createConversation(conversationId, userId, safeTitle(userInput));
      emitToUser(userId, 'conversations_changed', { conversationId, reason: 'created' });
    } else if (!conversationExists(conversationId, userId)) return jsonError(ctx, 404, '会话不存在');
    if (attachmentIds.length) {
      const count = countValidAttachments(attachmentIds, userId);
      if (count !== attachmentIds.length) return jsonError(ctx, 400, '包含无效图片附件');
    }
    const history = listChatHistory(conversationId, userId);
    const firstTurn = history.length === 0;
    if (!createdConversation && firstTurn) {
      updateConversationTitle(conversationId, userId, safeTitle(userInput));
    }
    const userMessageId = newId('msg');
    const storedUserContent = attachmentIds.length ? `${userInput}\n\n${attachmentIds.map(id => `![image](/api/files/${id})`).join('\n')}` : userInput;
    insertUserMessage(userMessageId, userId, conversationId, storedUserContent);
    emitToUser(userId, 'messages_changed', { conversationId, reason: 'user_message' });
    linkAttachmentsToMessage(attachmentIds, userId, conversationId, userMessageId);
    const assistantId = newId('msg');
    insertAssistantStreamingMessage(assistantId, userId, conversationId);

    ctx.res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'connection': 'keep-alive', 'x-accel-buffering': 'no' });
    const abortController = new AbortController();
    let responseClosed = false;
    let completed = false;
    ctx.res.on('close', () => {
      if (!completed) {
        responseClosed = true;
        abortController.abort();
      }
    });
    const send = (event: string, data: unknown) => {
      if (responseClosed || ctx.res.destroyed || ctx.res.writableEnded) return;
      ctx.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    let full = '';
    let storedAssistantContent = '';
    let capturedUsage: AgentUsage | undefined;
    let thinkStarted = false;
    let thinkClosed = false;
    send('meta', { conversationId, userMessageId, messageId: assistantId });
    const agentInput = attachmentIds.length
      ? `${userInput}\n\n本轮图片附件 ID：${attachmentIds.join(', ')}。如果是识别/分析图片，请调用 understand_image；如果是基于原图生成或修改图片，请调用 image_to_image。`
      : userInput;
    const recordAssistantUsage = (output: string) => {
      recordTokenUsage({
        userId,
        conversationId,
        messageId: assistantId,
        model: capturedUsage?.model || defaultChatModelName(),
        ...(capturedUsage?.totalTokens ? capturedUsage : estimateTokenUsage({ userInput: agentInput, history, output }))
      });
    };
    try {
      for await (const chunk of streamAgentChat({ userId, conversationId, input: agentInput, history, attachmentIds, signal: abortController.signal })) {
        if (abortController.signal.aborted) break;
        if (chunk.type === 'usage') {
          capturedUsage = chunk.usage;
        } else if (chunk.type === 'think') {
          if (!thinkStarted) {
            thinkStarted = true;
            storedAssistantContent += '<think>\n';
          }
          storedAssistantContent += `${chunk.text}\n`;
          send('think', { text: chunk.text });
        } else {
          if (thinkStarted && !thinkClosed) {
            thinkClosed = true;
            storedAssistantContent += '</think>\n\n';
          }
          full += chunk.text;
          storedAssistantContent += chunk.text;
          send('delta', { text: chunk.text });
        }
      }
      if (thinkStarted && !thinkClosed) storedAssistantContent += '</think>';
      completed = true;
      completeAssistantMessage(assistantId, userId, storedAssistantContent || full);
      recordAssistantUsage(storedAssistantContent || full);
      touchConversation(conversationId, userId);
      emitToUser(userId, 'messages_changed', { conversationId, reason: 'assistant_completed' });
      emitToUser(userId, 'conversations_changed', { conversationId, reason: 'updated' });
      if (firstTurn) scheduleConversationTitle(userId, conversationId, userInput, full || storedAssistantContent);
      send('done', { ok: true });
    } catch (e) {
      if (abortController.signal.aborted || (e instanceof Error && e.name === 'AbortError')) {
        if (thinkStarted && !thinkClosed) storedAssistantContent += '</think>';
        interruptAssistantMessage(assistantId, userId, storedAssistantContent || full || '已取消');
        recordAssistantUsage(storedAssistantContent || full || '已取消');
        touchConversation(conversationId, userId);
        emitToUser(userId, 'messages_changed', { conversationId, reason: 'assistant_interrupted' });
        emitToUser(userId, 'conversations_changed', { conversationId, reason: 'updated' });
        completed = true;
        send('cancelled', { ok: true });
        return;
      }
      const msg = e instanceof Error ? e.message : '模型调用失败';
      failAssistantMessage(assistantId, userId, msg);
      recordAssistantUsage(msg);
      emitToUser(userId, 'messages_changed', { conversationId, reason: 'assistant_error' });
      send('error', { error: msg });
    } finally { if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.res.end(); }
  });
}
