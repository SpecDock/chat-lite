import { all, db, now } from '../../core/db.js';

export function insertTokenUsage(input: { userId: string; conversationId: string; messageId: string; model: string | null; promptTokens: number; completionTokens: number; totalTokens: number; cacheMeasuredPromptTokens: number | null; cachedTokens: number | null }) {
  db.prepare(`INSERT INTO token_usage (user_id,conversation_id,message_id,model,prompt_tokens,completion_tokens,total_tokens,cache_measured_prompt_tokens,cached_tokens,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(input.userId, input.conversationId, input.messageId, input.model, input.promptTokens, input.completionTokens, input.totalTokens, input.cacheMeasuredPromptTokens, input.cachedTokens, now());
}

export function insertImageUsage(input: { userId: string; imageGenerationId: string; model: string | null; costUnits: number }) {
  db.prepare(`INSERT INTO image_usage (user_id,image_generation_id,model,cost_units,created_at)
    VALUES (?,?,?,?,?)`).run(input.userId, input.imageGenerationId, input.model, input.costUnits, now());
}

export function sumTokenUsage(userId: string) {
  return db.prepare(`SELECT COALESCE(SUM(total_tokens), 0) AS total,
    COALESCE(SUM(cached_tokens), 0) AS cachedTotal FROM token_usage WHERE user_id=?`).get(userId) as { total: number; cachedTotal: number };
}

export function sumImageUsage(userId: string) {
  return db.prepare('SELECT COALESCE(SUM(cost_units), 0) AS total FROM image_usage WHERE user_id=?').get(userId) as { total: number };
}

export function listTokenUsageDays(userId: string) {
  return all<{ date: string; value: number; cachedValue: number; measuredPromptValue: number | null }>(`SELECT date(created_at) AS date, SUM(total_tokens) AS value,
      COALESCE(SUM(cached_tokens), 0) AS cachedValue,
      SUM(cache_measured_prompt_tokens) AS measuredPromptValue
    FROM token_usage WHERE user_id=? GROUP BY date(created_at) ORDER BY date(created_at) DESC LIMIT 7`, userId);
}

export function listImageUsageDays(userId: string) {
  return all<{ date: string; value: number }>(`SELECT date(created_at) AS date, SUM(cost_units) AS value
    FROM image_usage WHERE user_id=? GROUP BY date(created_at) ORDER BY date(created_at) DESC LIMIT 7`, userId);
}
