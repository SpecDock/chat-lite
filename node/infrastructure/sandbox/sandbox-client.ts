import { request } from 'node:http';

export const TABLE_SANDBOX_SOCKET = '/run/table-sandbox/table-sandbox.sock';
export const TABLE_SANDBOX_JOBS = '/run/table-sandbox/jobs';

export type SandboxResult = {
  status: 'succeeded' | 'failed' | 'timeout';
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
};

export async function runTableSandbox(jobId: string, code: string, signal?: AbortSignal): Promise<SandboxResult> {
  if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { name: 'AbortError' });
  const body = Buffer.from(JSON.stringify({ jobId, code }), 'utf8');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: SandboxResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result as SandboxResult);
    };
    const onAbort = () => {
      requestRef?.destroy(Object.assign(new Error('请求已取消'), { name: 'AbortError' }));
    };
    let requestRef: ReturnType<typeof request> | undefined;
    try {
      requestRef = request({
        socketPath: TABLE_SANDBOX_SOCKET,
        path: '/run',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': body.byteLength,
        },
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { finish(new Error('表格沙箱返回了无效结果')); return; }
          if (response.statusCode !== 200) {
            const message = parsed && typeof parsed === 'object' && 'error' in parsed ? String((parsed as { error: unknown }).error) : `HTTP ${response.statusCode}`;
            finish(new Error(`表格沙箱不可用：${message}`));
            return;
          }
          if (!parsed || typeof parsed !== 'object' || !['succeeded', 'failed', 'timeout'].includes(String((parsed as { status?: unknown }).status))) {
            finish(new Error('表格沙箱返回了未知状态'));
            return;
          }
          finish(undefined, parsed as SandboxResult);
        });
      });
      requestRef.on('error', error => finish(error instanceof Error ? error : new Error(String(error))));
      requestRef.setTimeout(35_000, () => requestRef?.destroy(new Error('表格沙箱请求超时')));
      signal?.addEventListener('abort', onAbort, { once: true });
      requestRef.end(body);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
