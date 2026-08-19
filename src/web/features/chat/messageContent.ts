import type { MessageDTO } from '../../../shared/types';

export type MessageImage = {
  alt: string;
  src: string;
  markdown: string;
};

const USER_IMAGE_PATTERN = /!\[([^\]]*)\]\((\/api\/files\/att_[^)\s]+)\)/g;

function markdownAlt(value: string) {
  return value.replace(/[\[\]]/g, '');
}

export function splitUserMessage(message: MessageDTO) {
  const images: MessageImage[] = [];
  const paths = new Set<string>();
  const text = String(message.content || '').replace(USER_IMAGE_PATTERN, (markdown, alt: string, src: string) => {
    images.push({ alt: alt || '图片', src, markdown });
    paths.add(src);
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();

  for (const attachment of message.attachments || []) {
    if (paths.has(attachment.public_path)) continue;
    const alt = attachment.original_name || '图片';
    images.push({
      alt,
      src: attachment.public_path,
      markdown: `![${markdownAlt(alt)}](${attachment.public_path})`
    });
  }

  return { text, images };
}

export function composeUserMessage(text: string, images: MessageImage[]) {
  return [text.trim(), images.map(image => image.markdown).join('\n')].filter(Boolean).join('\n\n');
}
