import { createChatModel, textFromModelMessage } from '../model.js';
import type { WorkflowEvent } from './types.js';

const FORMULA_INSTRUCTION = '\n\n涉及数学、物理、化学公式时：行内公式使用 $...$，独立公式使用 $$...$$；不要用 [ ... ] 包裹公式；方程组、分式、推导步骤优先使用标准 LaTeX。';

export async function* streamFinalAnswer(input: { system: string; user: string; signal?: AbortSignal }): AsyncGenerator<WorkflowEvent> {
  const stream = await createChatModel().stream([
    { role: 'system', content: `${input.system}${FORMULA_INSTRUCTION}` },
    { role: 'user', content: input.user }
  ], { signal: input.signal });
  for await (const chunk of stream) {
    const text = textFromModelMessage(chunk);
    if (text) yield { type: 'delta', text };
  }
}

export async function* streamLiteralText(text: string): AsyncGenerator<WorkflowEvent> {
  const parts = text.match(/.{1,24}/gs) || [text];
  for (const part of parts) yield { type: 'delta', text: part };
}
