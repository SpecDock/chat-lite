import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const source = resolve('src/server/schema.sql');
const target = resolve('dist-server/schema.sql');

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
