import { isAbsolute, join, relative, resolve } from 'node:path';

export type WorkspaceBucket = 'input' | 'output';

export function isSafeWorkspaceId(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

export function workspaceRoot(dataDir: string) {
  return join(dataDir, 'work');
}

export function conversationWorkspaceDir(dataDir: string, conversationId: string) {
  return join(workspaceRoot(dataDir), conversationId);
}

export function workspaceBucketDir(dataDir: string, conversationId: string, bucket: WorkspaceBucket) {
  return join(conversationWorkspaceDir(dataDir, conversationId), bucket);
}

export function isWithinDirectory(root: string, target: string) {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}
