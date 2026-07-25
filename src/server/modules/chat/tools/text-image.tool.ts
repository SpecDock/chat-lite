import { generateImageForUser } from '../../images/image-generation.service.js';

/**
 * Execute a single text-to-image generation. Used directly by the `text_to_image`
 * ToolDef in the new main agent-loop path.
 */
export async function executeTextImageForUser(input: { userId: string; conversationId: string; prompt: string; signal?: AbortSignal }) {
  return await generateImageForUser({
    userId: input.userId,
    conversationId: input.conversationId,
    prompt: input.prompt,
    signal: input.signal
  });
}
