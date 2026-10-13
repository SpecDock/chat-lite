import { generateImageForUser } from '../../../infrastructure/images/image-generation.service.js';

/**
 * Conversation image-edit wrapper around generateImageForUser.
 * The chat tool registry no longer exposes this; the image studio calls the image service directly.
 */
export async function executeImageEditForUser(input: {
  userId: string;
  conversationId: string;
  prompt: string;
  sourceAttachmentId: string;
  referenceAttachmentIds?: string[];
  signal?: AbortSignal;
}) {
  return await generateImageForUser({
    userId: input.userId,
    conversationId: input.conversationId,
    prompt: input.prompt,
    sourceAttachmentId: input.sourceAttachmentId,
    referenceAttachmentIds: input.referenceAttachmentIds,
    signal: input.signal
  });
}
