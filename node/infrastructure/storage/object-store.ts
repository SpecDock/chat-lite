import { Client } from 'minio';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';

export const OBJECT_PREFIX = 'minio://';

export function isObjectPath(value: string | null | undefined): value is string {
  return !!value && value.startsWith(OBJECT_PREFIX);
}

export function objectPath(userId: string, conversationId: string | undefined, bucket: 'input' | 'output' | 'studio', fileName: string) {
  const name = fileName.split(/[/\\]/).pop() || 'file';
  if (bucket === 'studio') return `${OBJECT_PREFIX}u/${userId}/studio/${name}`;
  if (!conversationId) return `${OBJECT_PREFIX}u/${userId}/uploads/${name}`;
  return `${OBJECT_PREFIX}u/${userId}/c/${conversationId}/${bucket}/${name}`;
}

export function isConversationObject(storedPath: string, conversationId: string, bucket: string) {
  return storedPath.startsWith(`${OBJECT_PREFIX}u/`) && storedPath.includes(`/c/${conversationId}/${bucket}/`);
}

export function isUserStudioObject(storedPath: string, userId: string) {
  return storedPath.startsWith(`${OBJECT_PREFIX}u/${userId}/studio/`);
}

function objectKey(storedPath: string) {
  return storedPath.slice(OBJECT_PREFIX.length);
}

let cached: { client: Client; bucket: string } | undefined;

function settings() {
  if (!cached) {
    cached = {
      client: new Client({
        endPoint: '127.0.0.1',
        port: 9000,
        useSSL: false,
        accessKey: 'root',
        secretKey: 'REDACTED',
      }),
      bucket: 'chat-lite',
    };
  }
  return cached;
}

let bucketReady: Promise<void> | undefined;

async function ensureBucket() {
  if (!bucketReady) {
    bucketReady = (async () => {
      const { client, bucket } = settings();
      if (!(await client.bucketExists(bucket))) await client.makeBucket(bucket);
    })();
  }
  return bucketReady;
}

export async function putStored(storedPath: string, body: Buffer, contentType: string) {
  const { client, bucket } = settings();
  await ensureBucket();
  await client.putObject(bucket, objectKey(storedPath), body, body.length, { 'Content-Type': contentType });
}

export async function openStored(storedPath: string): Promise<{ stream: Readable; size: number } | undefined> {
  if (!isObjectPath(storedPath)) {
    try {
      const info = await stat(storedPath);
      return { stream: createReadStream(storedPath), size: info.size };
    } catch {
      return undefined;
    }
  }
  try {
    const { client, bucket } = settings();
    const key = objectKey(storedPath);
    const info = await client.statObject(bucket, key);
    const stream = await client.getObject(bucket, key);
    return { stream, size: info.size };
  } catch {
    return undefined;
  }
}

export async function readStored(storedPath: string) {
  if (!isObjectPath(storedPath)) return readFile(storedPath).catch(() => undefined);
  try {
    const { client, bucket } = settings();
    const stream = await client.getObject(bucket, objectKey(storedPath));
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch {
    return undefined;
  }
}

export async function removeStored(storedPath: string | null | undefined) {
  if (!storedPath) return;
  if (!isObjectPath(storedPath)) {
    await unlink(storedPath).catch(() => undefined);
    return;
  }
  const { client, bucket } = settings();
  await client.removeObject(bucket, objectKey(storedPath)).catch(() => undefined);
}

export async function materializeStored(storedPath: string, destination: string) {
  if (!isObjectPath(storedPath)) {
    await copyFile(storedPath, destination);
    return;
  }
  const body = await readStored(storedPath);
  if (!body) throw new Error('对象不存在');
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, body);
}
