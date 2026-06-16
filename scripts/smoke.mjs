import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const port = Number(process.env.SMOKE_PORT || 4100 + Math.floor(Math.random() * 1000));
const origin = `http://127.0.0.1:${port}`;
const dataDir = await mkdtemp(join(tmpdir(), 'chat-lite-smoke-'));

const server = spawn(process.execPath, ['dist-server/index.js'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    APP_ORIGIN: origin,
    DATA_DIR: dataDir,
    UPLOAD_DIR: join(dataDir, 'uploads'),
    DATABASE_PATH: join(dataDir, 'app.db'),
    INVITE_CODE: 'smoke-invite',
    SMTP_HOST: '',
    SMTP_USER: '',
    SMTP_PASS: '',
  },
});

let stdout = '';
let stderr = '';
server.stdout.on('data', chunk => { stdout += chunk; });
server.stderr.on('data', chunk => { stderr += chunk; });

async function waitForHealth() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`server did not become healthy\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function expectStatus(label, url, init, expected) {
  const res = await fetch(url, init);
  if (res.status !== expected) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label}: expected ${expected}, got ${res.status}: ${body}`);
  }
}

try {
  await waitForHealth();
  await expectStatus('GET /', `${origin}/`, undefined, 200);
  await expectStatus('GET /api/auth/me unauthenticated', `${origin}/api/auth/me`, undefined, 401);
  await expectStatus('POST /api/profile/password unauthenticated', `${origin}/api/profile/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ currentPassword: 'old-password', newPassword: 'new-password', confirmPassword: 'new-password' }),
  }, 401);
  await expectStatus('POST /api/auth/send-code invalid invite', `${origin}/api/auth/send-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email: 'smoke@example.com', inviteCode: 'wrong' }),
  }, 400);
  console.log('smoke ok');
} finally {
  server.kill('SIGTERM');
  await new Promise(resolve => server.once('exit', resolve));
  await rm(dataDir, { recursive: true, force: true });
}
