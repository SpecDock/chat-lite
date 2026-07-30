import { unlink } from 'node:fs/promises';
import { jsonError, type Handler, type Router } from '../../core/http.js';
import { auth, newId, requireAuth, safeTitle } from '../../core/security.js';
import { emitToUser } from '../../core/events.js';
import { scheduleConversationTitle } from '../conversation-titles/title.js';
import { defaultChatModelName, estimateTokenUsage, recordTokenUsage } from '../usage/usage.service.js';
import {
  attachmentIdsFromContent,
  cloneUserAttachments,
  discardClonedAttachments,
  parseChatRequest,
  removeAttachmentFiles,
  stripUserImageContent,
  userMessageContent
} from './chat.service.js';
import { prepareConversationContext } from './conversation-context.service.js';
import { ensureRagInitialized, indexChatMessage } from '../rag/rag.js';
import { runAgentLoop } from './engine/agent-loop.js';
import { aggregateAgentUsage, type AgentUsage } from './engine/tool-def.js';
import {
  classifyModelError,
  isPartialFinalStreamError,
  logAgentStage,
  modelMaxAttempts,
  type ModelErrorClassification,
} from './engine/model-retry.js';
import {
  appendEditedMessagePair,
  completeAssistantMessage,
  conversationHasStreamingAssistant,
  conversationExists,
  countValidAttachments,
  createConversation,
  deleteConversationData,
  deleteMessagePairData,
  failAssistantMessage,
  getConversation,
  getMessagePair,
  insertAssistantStreamingMessage,
  insertUserMessage,
  interruptAssistantMessage,
  linkAttachmentsToMessage,
  listMessageAttachments,
  listConversations,
  listMessages,
  renameConversation,
  replaceLatestMessagePair,
  setConversationPinned,
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

  (router as unknown as { add(method: string, path: string, handlers: Handler[]): void })
    .add('PATCH', '/api/conversations/:id', [requireAuth, async (ctx) => {
    const userId = auth(ctx).userId;
    const conversationId = ctx.params.id;
    if (!conversationExists(conversationId, userId)) return jsonError(ctx, 404, '会话不存在');
    const body = await ctx.json().catch(() => undefined);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonError(ctx, 400, '请求必须包含且仅包含一个有效操作');
    }
    const input = body as Record<string, unknown>;
    const keys = Object.keys(input);
    if (keys.length !== 1) return jsonError(ctx, 400, '请求必须包含且仅包含一个有效操作');

    let conversation;
    let reason: 'pinned' | 'unpinned' | 'renamed';
    if (keys[0] === 'pinned' && typeof input.pinned === 'boolean') {
      conversation = setConversationPinned(conversationId, userId, input.pinned);
      reason = input.pinned ? 'pinned' : 'unpinned';
    } else if (keys[0] === 'title' && typeof input.title === 'string') {
      const title = input.title.replace(/\s+/g, ' ').trim();
      if (!title || title.length > 40) return jsonError(ctx, 400, '标题长度必须为 1 到 40 个字符');
      conversation = renameConversation(conversationId, userId, title);
      reason = 'renamed';
    } else {
      return jsonError(ctx, 400, '请求必须包含且仅包含一个有效操作');
    }
    if (!conversation) return jsonError(ctx, 404, '会话不存在');
    emitToUser(userId, 'conversations_changed', { conversationId, reason });
    ctx.sendJson({ conversation });
  }]);

  router.delete('/api/conversations/:id', requireAuth, async (ctx) => {
    const userId = auth(ctx).userId;
    const conversationId = ctx.params.id;
    if (!conversationExists(conversationId, userId)) return jsonError(ctx, 404, '会话不存在');
    if (conversationHasStreamingAssistant(conversationId, userId)) {
      return jsonError(ctx, 409, '会话正在生成回复，请先停止生成后再删除');
    }
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

  router.delete('/api/conversations/:id/messages/:messageId', requireAuth, async (ctx) => {
    const userId = auth(ctx).userId;
    const conversationId = ctx.params.id;
    if (!conversationExists(conversationId, userId)) return jsonError(ctx, 404, '会话不存在');
    if (conversationHasStreamingAssistant(conversationId, userId)) return jsonError(ctx, 409, '会话正在生成回复');
    const pair = getMessagePair(conversationId, userId, ctx.params.messageId);
    if (!pair) return jsonError(ctx, 404, '用户消息不存在');
    const referencedAttachmentIds = attachmentIdsFromContent(`${pair.user.content}\n${pair.assistant?.content || ''}`);
    try {
      const result = deleteMessagePairData({ conversationId, userId, userMessageId: pair.user.id, referencedAttachmentIds });
      await removeAttachmentFiles(result.attachments);
      if (!result.conversationDeleted && result.pair.isFirst && result.nextPair) {
        const nextUserInput = stripUserImageContent(result.nextPair.user.content);
        updateConversationTitle(conversationId, userId, safeTitle(nextUserInput));
        if (result.nextPair.assistant) {
          scheduleConversationTitle(userId, conversationId, nextUserInput, result.nextPair.assistant.content);
        }
      }
      emitToUser(userId, 'messages_changed', { conversationId, reason: 'pair_deleted', userMessageId: pair.user.id, messageId: pair.assistant?.id });
      if (result.conversationDeleted) emitToUser(userId, 'conversation_deleted', { conversationId });
      emitToUser(userId, 'conversations_changed', { conversationId, reason: result.conversationDeleted ? 'deleted' : 'updated' });
      ctx.sendJson({ ok: true, conversationDeleted: result.conversationDeleted });
    } catch (error) {
      return jsonError(ctx, requestErrorStatus(error), requestErrorMessage(error));
    }
  });
}

export function registerChatRoutes(router: Router) {
  router.post('/api/chat', requireAuth, async (ctx) => {
    const body = await ctx.json().catch(() => ({}));
    const parsed = parseChatRequest(body);
    let { conversationId } = parsed;
    const { content, editUserMessageId } = parsed;
    let { attachmentIds, userInput } = parsed;
    const userId = auth(ctx).userId;
    const requestAt = new Date().toISOString();
    let createdConversation = false;
    let history: Awaited<ReturnType<typeof prepareConversationContext>>['history'] = [];
    let conversationSummary = '';
    let firstTurn = false;
    let editMode: 'replace' | 'append' | undefined;
    let userMessageId: string;
    let assistantId: string;
    let assistantPersisted = false;

    try {
      if (editUserMessageId) {
        if (!conversationId) return jsonError(ctx, 400, '编辑消息必须指定会话');
        if (!conversationExists(conversationId, userId)) return jsonError(ctx, 404, '会话不存在');
        if (conversationHasStreamingAssistant(conversationId, userId)) return jsonError(ctx, 409, '会话正在生成回复');
        const pair = getMessagePair(conversationId, userId, editUserMessageId);
        if (!pair) return jsonError(ctx, 404, '用户消息不存在');
        const originalAttachments = listMessageAttachments(pair.user.id, conversationId, userId);
        userInput = stripUserImageContent(content);
        if (!userInput && originalAttachments.length === 0) return jsonError(ctx, 400, '消息不能为空');
        if (pair.isLatest) {
          attachmentIds = originalAttachments.map(attachment => attachment.id);
          const storedUserContent = userMessageContent(userInput, attachmentIds);
          const replacement = replaceLatestMessagePair({
            conversationId,
            userId,
            userMessageId: pair.user.id,
            userContent: storedUserContent,
            newAssistantId: newId('msg'),
            referencedAssistantAttachmentIds: attachmentIdsFromContent(pair.assistant?.content || '')
          });
          userMessageId = pair.user.id;
          assistantId = replacement.assistantId;
          assistantPersisted = true;
          await removeAttachmentFiles(replacement.attachments);
          firstTurn = pair.isFirst;
          editMode = 'replace';
          if (firstTurn) updateConversationTitle(conversationId, userId, safeTitle(userInput));
        } else {
          const clones = await cloneUserAttachments(originalAttachments, userId, conversationId);
          if (conversationHasStreamingAssistant(conversationId, userId)) {
            await discardClonedAttachments(clones, userId);
            return jsonError(ctx, 409, '会话正在生成回复');
          }
          attachmentIds = clones.map(attachment => attachment.id);
          userMessageId = newId('msg');
          assistantId = newId('msg');
          try {
            appendEditedMessagePair({
              conversationId,
              userId,
              originalUserMessageId: pair.user.id,
              userMessageId,
              assistantId,
              userContent: userMessageContent(userInput, attachmentIds),
              attachmentIds
            });
            assistantPersisted = true;
          } catch (error) {
            await discardClonedAttachments(clones, userId);
            throw error;
          }
          editMode = 'append';
        }
      } else {
        if (!content && attachmentIds.length === 0) return jsonError(ctx, 400, '消息不能为空');
        if (!conversationId) {
          conversationId = newId('conv');
          createdConversation = true;
          createConversation(conversationId, userId, safeTitle(userInput));
          emitToUser(userId, 'conversations_changed', { conversationId, reason: 'created' });
        } else if (!conversationExists(conversationId, userId)) return jsonError(ctx, 404, '会话不存在');
        if (attachmentIds.length) {
          const count = countValidAttachments(attachmentIds, userId, conversationId);
          if (count !== attachmentIds.length) return jsonError(ctx, 400, '包含无效图片附件');
        }
        userMessageId = newId('msg');
        assistantId = newId('msg');
        insertUserMessage(userMessageId, userId, conversationId, userMessageContent(userInput, attachmentIds));
        linkAttachmentsToMessage(attachmentIds, userId, conversationId, userMessageId);
        insertAssistantStreamingMessage(assistantId, userId, conversationId);
        assistantPersisted = true;
      }
      const preparedContext = await prepareConversationContext({
        userId,
        conversationId,
        currentMessageId: userMessageId,
        requestAt,
      });
      history = preparedContext.history;
      conversationSummary = preparedContext.summaryText;
      if (!editMode) {
        firstTurn = history.length === 0 && !conversationSummary.trim();
        if (!createdConversation && firstTurn) updateConversationTitle(conversationId, userId, safeTitle(userInput));
      }
      ensureRagInitialized();
      const storedUserContent = userMessageContent(userInput, attachmentIds);
      indexChatMessage({ userId, conversationId, messageId: userMessageId, role: 'user', content: storedUserContent, status: 'completed' });
      emitToUser(userId, 'messages_changed', { conversationId, reason: editMode ? 'user_message_edited' : 'user_message' });
      ctx.res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'connection': 'keep-alive', 'x-accel-buffering': 'no' });
    } catch (error) {
      if (assistantPersisted) {
        const content = `回复准备失败：${requestErrorMessage(error)}`;
        try {
          failAssistantMessage(assistantId!, userId, content);
          emitToUser(userId, 'messages_changed', { conversationId, reason: 'assistant_error' });
        } catch (compensationError) {
          console.error('[chat] failed to compensate pre-stream assistant', compensationError);
        }
      }
      if (!ctx.res.headersSent) return jsonError(ctx, requestErrorStatus(error), requestErrorMessage(error));
      if (!ctx.res.writableEnded) ctx.res.end();
      return;
    }
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
    send('meta', { conversationId, userMessageId, messageId: assistantId, ...(editMode ? { mode: editMode } : {}) });
    const appendThink = (text: string) => {
      if (!thinkStarted || thinkClosed) {
        thinkStarted = true;
        thinkClosed = false;
        storedAssistantContent += '<think>\n';
      }
      storedAssistantContent += `${text}\n`;
      send('think', { text });
    };
    const recordAssistantUsage = (output: string) => {
      recordTokenUsage({
        userId,
        conversationId,
        messageId: assistantId,
        model: capturedUsage?.model || defaultChatModelName(),
        ...(capturedUsage?.totalTokens ? capturedUsage : estimateTokenUsage({ userInput, history, output }))
      });
    };
    const scheduleEditedTitleAfterFailure = (output: string) => {
      if (editMode === 'replace' && firstTurn) {
        scheduleConversationTitle(userId, conversationId, userInput, output);
      }
    };
    const chatStartedAt = Date.now();
    try {
      appendThink('正在分析请求。');
      for await (const event of runAgentLoop({
        userId,
        conversationId,
        requestId: assistantId,
        userInput,
        attachmentIds,
        history,
        conversationSummary,
        signal: abortController.signal
      })) {
        if (abortController.signal.aborted) {
          throw Object.assign(new Error('请求已取消'), { name: 'AbortError' });
        }
        if (event.type === 'think') {
          appendThink(event.text);
        } else if (event.type === 'delta') {
          if (thinkStarted && !thinkClosed) {
            thinkClosed = true;
            storedAssistantContent += '</think>\n\n';
          }
          full += event.text;
          storedAssistantContent += event.text;
          send('delta', { text: event.text });
        } else if (event.type === 'usage') {
          capturedUsage = aggregateAgentUsage(capturedUsage, event.usage);
        }
      }
      if (!full.trim() && !/!\[[^\]]*\]\(\/api\/files\/att_[^)]+\)/.test(storedAssistantContent)) {
        appendThink('主模型未返回正文，请尝试重新提问或调整描述。');
        full = '主模型未返回正文，请尝试重新提问或调整描述。';
      }
      if (thinkStarted && !thinkClosed) storedAssistantContent += '</think>';
      completed = true;
      const completedContent = storedAssistantContent || full || '（助手未返回内容）';
      completeAssistantMessage(assistantId, userId, completedContent);
      indexChatMessage({ userId, conversationId, messageId: assistantId, role: 'assistant', content: completedContent, status: 'completed' });
      recordAssistantUsage(completedContent);
      touchConversation(conversationId, userId);
      emitToUser(userId, 'messages_changed', { conversationId, reason: 'assistant_completed' });
      emitToUser(userId, 'conversations_changed', { conversationId, reason: 'updated' });
      if (firstTurn) scheduleConversationTitle(userId, conversationId, userInput, full || storedAssistantContent);
      send('done', { ok: true });
    } catch (e) {
      const classified = classifyModelError(e, abortController.signal);
      const aborted = abortController.signal.aborted || classified.kind === 'aborted';
      const partial = isPartialFinalStreamError(e);
      logAgentStage({
        callId: assistantId,
        conversationId,
        stage: 'chat_boundary',
        outcome: aborted ? 'interrupted' : partial ? 'partial' : 'run_failed',
        elapsedMs: Date.now() - chatStartedAt,
        errorKind: classified.kind,
        status: classified.status,
        codes: classified.codes,
        requestId: classified.requestId
      });
      if (aborted) {
        if (thinkStarted && !thinkClosed) storedAssistantContent += '</think>';
        const interruptedContent = storedAssistantContent || full || '已取消';
        interruptAssistantMessage(assistantId, userId, interruptedContent);
        indexChatMessage({ userId, conversationId, messageId: assistantId, role: 'assistant', content: interruptedContent, status: 'interrupted' });
        recordAssistantUsage(interruptedContent);
        touchConversation(conversationId, userId);
        scheduleEditedTitleAfterFailure(interruptedContent);
        emitToUser(userId, 'messages_changed', { conversationId, reason: 'assistant_interrupted' });
        emitToUser(userId, 'conversations_changed', { conversationId, reason: 'updated' });
        completed = true;
        send('cancelled', { ok: true });
        return;
      }
      if (partial && full.trim()) {
        if (thinkStarted && !thinkClosed) {
          thinkClosed = true;
          storedAssistantContent += '</think>\n\n';
        }
        const interruptionNotice = '\n\n> 回答生成过程中连接中断，已保留当前内容。你可以让我继续。';
        full += interruptionNotice;
        storedAssistantContent += interruptionNotice;
        send('delta', { text: interruptionNotice });
        const interruptedContent = storedAssistantContent || full;
        interruptAssistantMessage(assistantId, userId, interruptedContent);
        indexChatMessage({ userId, conversationId, messageId: assistantId, role: 'assistant', content: interruptedContent, status: 'interrupted' });
        recordAssistantUsage(interruptedContent);
        touchConversation(conversationId, userId);
        scheduleEditedTitleAfterFailure(interruptedContent);
        emitToUser(userId, 'messages_changed', { conversationId, reason: 'assistant_interrupted' });
        emitToUser(userId, 'conversations_changed', { conversationId, reason: 'updated' });
        completed = true;
        send('cancelled', { ok: true, reason: 'model_interrupted' });
        return;
      }
      const msg = userFacingModelError(classified);
      if (thinkStarted && !thinkClosed) storedAssistantContent += '</think>';
      const errorContent = storedAssistantContent ? `${storedAssistantContent}\n\n${msg}` : msg;
      failAssistantMessage(assistantId, userId, errorContent);
      indexChatMessage({ userId, conversationId, messageId: assistantId, role: 'assistant', content: errorContent, status: 'error' });
      recordAssistantUsage(errorContent);
      scheduleEditedTitleAfterFailure(errorContent);
      emitToUser(userId, 'messages_changed', { conversationId, reason: 'assistant_error' });
      completed = true;
      send('error', { error: msg });
    } finally { if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.res.end(); }
  });
}

function userFacingModelError(classified: ModelErrorClassification) {
  if (classified.kind === 'auth' || classified.kind === 'quota') {
    return '当前主模型额度不足或认证失败，请更换可用的模型 API Key 后再试。';
  }
  if (classified.kind === 'rate_limit') {
    return '当前主模型请求过于频繁，请稍后重试。';
  }
  if (classified.kind === 'connection' || classified.kind === 'timeout' || classified.kind === 'server' || classified.kind === 'empty') {
    return `当前主模型连接不稳定或请求超时。已自动尝试 ${modelMaxAttempts()} 次仍失败，请稍后重试。`;
  }
  return '当前主模型调用失败，请稍后重试。';
}

function requestErrorStatus(error: unknown) {
  if (!error || typeof error !== 'object' || !('status' in error)) return 500;
  const status = Number(error.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function requestErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '服务器错误';
}
