export type ImagePixelSize = { width: number; height: number; mimeType: string; ext: string };

function validSize(width: number, height: number) {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 20000 && height <= 20000;
}

function pngSize(buffer: Buffer): ImagePixelSize | undefined {
  if (buffer.length < 24) return undefined;
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return undefined;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!validSize(width, height)) return undefined;
  return { width, height, mimeType: 'image/png', ext: '.png' };
}

function isJpegSof(marker: number) {
  return marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3
    || marker === 0xc5 || marker === 0xc6 || marker === 0xc7
    || marker === 0xc9 || marker === 0xca || marker === 0xcb
    || marker === 0xcd || marker === 0xce || marker === 0xcf;
}

function jpegSize(buffer: Buffer): ImagePixelSize | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return undefined;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return undefined;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (offset + 1 >= buffer.length) return undefined;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return undefined;
    if (isJpegSof(marker)) {
      if (length < 7 || offset + 6 >= buffer.length) return undefined;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (!validSize(width, height)) return undefined;
      return { width, height, mimeType: 'image/jpeg', ext: '.jpg' };
    }
    offset += length;
  }
  return undefined;
}

function webpSize(buffer: Buffer): ImagePixelSize | undefined {
  if (buffer.length < 30) return undefined;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return undefined;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    if (!validSize(width, height)) return undefined;
    return { width, height, mimeType: 'image/webp', ext: '.webp' };
  }
  if (chunk === 'VP8 ') {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return undefined;
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    if (!validSize(width, height)) return undefined;
    return { width, height, mimeType: 'image/webp', ext: '.webp' };
  }
  if (chunk === 'VP8L') {
    if (buffer[20] !== 0x2f) return undefined;
    const bits = buffer.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    if (!validSize(width, height)) return undefined;
    return { width, height, mimeType: 'image/webp', ext: '.webp' };
  }
  return undefined;
}

export function readGeneratedImage(buffer: Buffer): ImagePixelSize | undefined {
  return pngSize(buffer) || jpegSize(buffer) || webpSize(buffer);
}
