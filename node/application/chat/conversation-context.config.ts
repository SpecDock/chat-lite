const DEFAULT_MODEL_INPUT_PRICE_PER_MILLION = 5;
const DEFAULT_MODEL_OUTPUT_PRICE_PER_MILLION = 30;
const DEFAULT_MODEL_CACHED_INPUT_PRICE_PER_MILLION = 0.5;
const DEFAULT_CONVERSATION_SUMMARY_MAX_TOKENS = 2048;
const DEFAULT_CONVERSATION_CACHE_IDLE_MINUTES = 15;
const DEFAULT_CONVERSATION_CONTEXT_COST_RATIO = 1.2;

function nonNegativeNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export const MODEL_INPUT_PRICE_PER_MILLION = nonNegativeNumber(
  'MODEL_INPUT_PRICE_PER_MILLION',
  DEFAULT_MODEL_INPUT_PRICE_PER_MILLION
);
export const MODEL_OUTPUT_PRICE_PER_MILLION = nonNegativeNumber(
  'MODEL_OUTPUT_PRICE_PER_MILLION',
  DEFAULT_MODEL_OUTPUT_PRICE_PER_MILLION
);
export const MODEL_CACHED_INPUT_PRICE_PER_MILLION = nonNegativeNumber(
  'MODEL_CACHED_INPUT_PRICE_PER_MILLION',
  DEFAULT_MODEL_CACHED_INPUT_PRICE_PER_MILLION
);
export const CONVERSATION_SUMMARY_MAX_TOKENS = positiveInteger(
  'CONVERSATION_SUMMARY_MAX_TOKENS',
  DEFAULT_CONVERSATION_SUMMARY_MAX_TOKENS
);
export const CONVERSATION_CACHE_IDLE_MINUTES = nonNegativeNumber(
  'CONVERSATION_CACHE_IDLE_MINUTES',
  DEFAULT_CONVERSATION_CACHE_IDLE_MINUTES
);
export const CONVERSATION_CONTEXT_COST_RATIO = positiveNumber(
  'CONVERSATION_CONTEXT_COST_RATIO',
  DEFAULT_CONVERSATION_CONTEXT_COST_RATIO
);
