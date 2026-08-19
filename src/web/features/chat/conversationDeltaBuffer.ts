export type DeltaFlushScheduler = {
  schedule: (callback: () => void) => number;
  cancel: (handle: number) => void;
};

export type ConversationDeltaBufferState = {
  pendingDelta: string;
  deltaFlushHandle: number | null;
  deltaTargetKey?: string;
  deltaAssistantId?: string;
};

export type PendingConversationDelta = {
  text: string;
  targetKey: string;
  assistantId: string;
};

export function normalizeStreamingMarkdownInterval(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return 50;
  if (typeof value === 'string' && !value.trim()) return 50;
  const interval = Number(value);
  if (!Number.isFinite(interval)) return 50;
  return Math.min(1000, Math.max(16, interval));
}

export function enqueueConversationDelta(
  buffer: ConversationDeltaBufferState,
  delta: PendingConversationDelta,
  scheduler: DeltaFlushScheduler,
  onFlush: () => void,
) {
  if (!delta.text) return true;
  if (buffer.pendingDelta && (
    buffer.deltaTargetKey !== delta.targetKey
    || buffer.deltaAssistantId !== delta.assistantId
  )) return false;

  buffer.pendingDelta += delta.text;
  buffer.deltaTargetKey = delta.targetKey;
  buffer.deltaAssistantId = delta.assistantId;
  if (buffer.deltaFlushHandle === null) {
    buffer.deltaFlushHandle = scheduler.schedule(() => {
      buffer.deltaFlushHandle = null;
      onFlush();
    });
  }
  return true;
}

export function drainConversationDelta(
  buffer: ConversationDeltaBufferState,
  scheduler: DeltaFlushScheduler,
): PendingConversationDelta | undefined {
  if (buffer.deltaFlushHandle !== null) scheduler.cancel(buffer.deltaFlushHandle);
  buffer.deltaFlushHandle = null;
  if (!buffer.pendingDelta || !buffer.deltaTargetKey || !buffer.deltaAssistantId) {
    buffer.pendingDelta = '';
    buffer.deltaTargetKey = undefined;
    buffer.deltaAssistantId = undefined;
    return undefined;
  }
  const pending = {
    text: buffer.pendingDelta,
    targetKey: buffer.deltaTargetKey,
    assistantId: buffer.deltaAssistantId,
  };
  buffer.pendingDelta = '';
  buffer.deltaTargetKey = undefined;
  buffer.deltaAssistantId = undefined;
  return pending;
}
