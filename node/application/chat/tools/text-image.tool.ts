import { generateImageForUser } from '../../../infrastructure/images/image-generation.service.js';

/**
 * Conversation text-to-image wrapper around generateImageForUser.
 * The chat tool registry no longer exposes this; the image studio calls the image service directly.
 */
export async function executeTextImageForUser(input: { userId: string; conversationId: string; prompt: string; signal?: AbortSignal }) {
  return await generateImageForUser({
    userId: input.userId,
    conversationId: input.conversationId,
    prompt: input.prompt,
    signal: input.signal
  });
}
