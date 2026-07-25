import { generateImageForUser } from '../../images/image-generation.service.js';

/**
 * Execute the image_edit (image-to-image) pipeline for a single user request.
 * This is the same implementation previously wrapped inside the plan
 * executor; the agent loop calls it directly via the `image_edit` tool def.
 */
export async function executeImageEditForUser(input: {
  userId: string;
  conversationId: string;
  prompt: string;
  sourceAttachmentId: string;
  signal?: AbortSignal;
}) {
  return await generateImageForUser({
    userId: input.userId,
    conversationId: input.conversationId,
    prompt: input.prompt,
    sourceAttachmentId: input.sourceAttachmentId,
    signal: input.signal
  });
}
