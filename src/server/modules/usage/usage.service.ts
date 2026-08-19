import type { MessageDTO, UsageDTO } from '../../../shared/types.js';
import * as repo from './usage.repo.js';

export type TokenUsageInput = {
  userId: string;
  conversationId: string;
  messageId: string;
  model?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheMeasuredPromptTokens?: number;
  cachedTokens?: number;
};

export type TokenEstimateInput = {
  userInput: string;
  history: Pick<MessageDTO, 'content'>[];
  output: string;
};

export function defaultChatModelName() {
  return process.env.MODEL_NAME || process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

export function defaultImageModelName() {
  return process.env.IMAGE_MODEL || '';
}

function positiveInt(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0;
}

function nullableNonnegativeInt(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.ceil(value);
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateTokenUsage(input: TokenEstimateInput) {
  const promptText = `${input.history.map(m => m.content).join('\n')}\n${input.userInput}`;
  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(input.output || '');
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

export function recordTokenUsage(input: TokenUsageInput) {
  const promptTokens = positiveInt(input.promptTokens);
  const completionTokens = positiveInt(input.completionTokens);
  const totalTokens = positiveInt(input.totalTokens) || promptTokens + completionTokens;
  if (totalTokens <= 0) return;
  const cacheMeasuredPromptTokens = nullableNonnegativeInt(input.cacheMeasuredPromptTokens);
  const cachedTokens = nullableNonnegativeInt(input.cachedTokens);
  const hasCacheMeasurement = cacheMeasuredPromptTokens !== null && cachedTokens !== null;
  repo.insertTokenUsage({
    userId: input.userId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    model: input.model || defaultChatModelName(),
    promptTokens,
    completionTokens,
    totalTokens,
    cacheMeasuredPromptTokens: hasCacheMeasurement ? cacheMeasuredPromptTokens : null,
    cachedTokens: hasCacheMeasurement ? cachedTokens : null,
  });
}

export function recordImageUsage(userId: string, imageGenerationId: string, model?: string | null) {
  const configured = Number(process.env.IMAGE_COST_PER_IMAGE || 1);
  const costUnits = Number.isFinite(configured) && configured > 0 ? configured : 1;
  repo.insertImageUsage({ userId, imageGenerationId, model: model || defaultImageModelName() || null, costUnits });
}

function labelForDate(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  const d = new Date(year, (month || 1) - 1, day || 1);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function usageDays(rows: Array<{ date: string; value: number }>) {
  return rows.reverse().map(row => ({ date: row.date, label: labelForDate(row.date), value: Number(row.value || 0) }));
}

function tokenUsageDays(rows: Array<{ date: string; inputValue: number; outputValue: number; cachedValue: number; measuredInputValue: number; measuredInputCount: number }>) {
  return rows.reverse().map(row => {
    const inputValue = Number(row.inputValue || 0);
    const outputValue = Number(row.outputValue || 0);
    const cachedValue = Number(row.cachedValue || 0);
    const measuredInputValue = Number(row.measuredInputValue || 0);
    return {
      date: row.date,
      label: labelForDate(row.date),
      inputValue,
      outputValue,
      cachedValue,
      cacheRate: row.measuredInputCount > 0 && measuredInputValue > 0 ? (cachedValue / measuredInputValue) * 100 : null,
      value: inputValue + outputValue,
    };
  });
}

export function getUsage(userId: string): UsageDTO {
  const tokenUsage = repo.sumTokenUsage(userId);
  const inputTotal = Number(tokenUsage.inputTotal || 0);
  const outputTotal = Number(tokenUsage.outputTotal || 0);
  return {
    token: {
      inputTotal,
      outputTotal,
      cachedTotal: Number(tokenUsage.cachedTotal || 0),
      days: tokenUsageDays(repo.listTokenUsageDays(userId)),
      total: inputTotal + outputTotal,
    },
    image: { total: Number(repo.sumImageUsage(userId).total || 0), days: usageDays(repo.listImageUsageDays(userId)) }
  };
}
