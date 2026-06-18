import { unlink } from 'node:fs/promises';
import { jsonError, type Router } from '../../core/http.js';
import { auth, newId, requireAuth, safeTitle } from '../../core/security.js';
import type { AgentUsage } from './agent.js';
import { emitToUser } from '../../core/events.js';
import { scheduleConversationTitle } from '../conversation-titles/title.js';
import { defaultChatModelName, estimateTokenUsage, recordTokenUsage } from '../usage/usage.service.js';
import { agentInputForMessage, looksLikeUnfinishedPlan, parseChatRequest, shouldForceSearchFallback, userMessageContent } from './chat.service.js';
import { routeTask } from './task-router.js';
import { runWorkflow } from './workflows/index.js';
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
    const parsed = parseChatRequest(body);
    let conversationId = parsed.conversationId;
    const { content, attachmentIds, userInput } = parsed;
    if (!content && attachmentIds.length === 0) return jsonError(ctx, 400, '消息不能为空');
    const userId = auth(ctx).userId;
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
    const storedUserContent = userMessageContent(userInput, attachmentIds);
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
    const appendThink = (text: string) => {
      if (!thinkStarted || thinkClosed) {
        thinkStarted = true;
        thinkClosed = false;
        storedAssistantContent += '<think>\n';
      }
      storedAssistantContent += `${text}\n`;
      send('think', { text });
    };
    const agentInput = agentInputForMessage(userInput, attachmentIds);
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
      appendThink('正在分析请求。');
      const route = await routeTask(userInput, attachmentIds, history, abortController.signal);
      let webSearchTriggered = route.intent === 'web_search';
      appendThink(`任务类型：${route.intent}`);
      const runAgent = async (input: string) => {
        for await (const chunk of runWorkflow(route, { userId, conversationId, input, history, attachmentIds, sourceAttachmentId: route.sourceAttachmentId, signal: abortController.signal })) {
          if (abortController.signal.aborted) break;
          if (chunk.type === 'usage') {
            capturedUsage = chunk.usage;
          } else if (chunk.type === 'think') {
            if (/web_search|搜索网页|搜索完成/.test(chunk.text)) webSearchTriggered = true;
            appendThink(chunk.text);
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
      };
      await runAgent(agentInput);
      if (!full.trim() && !/!\[[^\]]*\]\(\/api\/files\/att_[^)]+\)/.test(storedAssistantContent)) {
        throw new Error('主模型未返回正文');
      }
      if (!webSearchTriggered && looksLikeUnfinishedPlan(full) && shouldForceSearchFallback(userInput, full)) {
        appendThink('检测到需要联网搜索，正在自动补充搜索结果。');
        const searchRoute = { intent: 'web_search' as const, needVision: false, needImageEdit: false, needSearch: true, confidence: 1 };
        for await (const chunk of runWorkflow(searchRoute, { userId, conversationId, input: userInput, history, attachmentIds, signal: abortController.signal })) {
          if (abortController.signal.aborted) break;
          if (chunk.type === 'usage') capturedUsage = chunk.usage;
          else if (chunk.type === 'think') appendThink(chunk.text);
          else {
            if (thinkStarted && !thinkClosed) {
              thinkClosed = true;
              storedAssistantContent += '</think>\n\n';
            }
            full += chunk.text;
            storedAssistantContent += chunk.text;
            send('delta', { text: chunk.text });
          }
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
      const msg = userFacingModelError(e);
      failAssistantMessage(assistantId, userId, msg);
      recordAssistantUsage(msg);
      emitToUser(userId, 'messages_changed', { conversationId, reason: 'assistant_error' });
      send('error', { error: msg });
    } finally { if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.res.end(); }
  });
}

function userFacingModelError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/额度不足|insufficient|quota|balance|403|401|authentication|invalid.*token/i.test(message)) {
    return '当前主模型额度不足或认证失败，请更换可用的模型 API Key 后再试。';
  }
  return `当前主模型调用失败，请稍后重试。${message ? `\n\n错误信息：${message}` : ''}`;
}
