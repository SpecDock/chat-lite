import json
import os
import re
import resource
import signal
import socketserver
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path

SOCKET_PATH = Path('/run/table-sandbox/table-sandbox.sock')
JOBS_ROOT = Path('/run/table-sandbox/jobs').resolve()
MAX_CODE_BYTES = 1 * 1024 * 1024
MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_OUTPUT_BYTES = 64 * 1024
TIMEOUT_SECONDS = 30
JOB_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,80}$')


def bounded_text(value: bytes) -> str:
    if len(value) <= MAX_OUTPUT_BYTES:
        return value.decode('utf-8', errors='replace')
    kept = value[:MAX_OUTPUT_BYTES].decode('utf-8', errors='replace')
    return kept + '\n[output truncated]\n'


def limit_resources() -> None:
    if os.name != 'posix':
        return
    resource.setrlimit(resource.RLIMIT_CPU, (TIMEOUT_SECONDS, TIMEOUT_SECONDS + 2))
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (20 * 1024 * 1024, 20 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))


def valid_job_dir(job_id: str) -> Path | None:
    if not JOB_ID_RE.fullmatch(job_id):
        return None
    job = (JOBS_ROOT / job_id).resolve()
    try:
        job.relative_to(JOBS_ROOT)
    except ValueError:
        return None
    if not job.is_dir() or not (job / 'input').is_dir():
        return None
    return job


def run_job(job: Path, code: str) -> dict[str, object]:
    script = job / 'script.py'
    script.write_text(code, encoding='utf-8')
    script.chmod(0o444)

    env = {
        'PATH': '/usr/local/bin:/usr/bin:/bin',
        'PYTHONUNBUFFERED': '1',
        'HOME': '/tmp',
    }
    started = time.monotonic()
    process = subprocess.Popen(
        [sys.executable, '-I', '-B', str(script)],
        cwd=str(job),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        preexec_fn=limit_resources if os.name == 'posix' else None,
    )
    timed_out = False
    try:
        stdout, stderr = process.communicate(timeout=TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        timed_out = True
        if os.name == 'posix':
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
        stdout, stderr = process.communicate()

    return {
        'status': 'timeout' if timed_out else ('succeeded' if process.returncode == 0 else 'failed'),
        'exit_code': None if timed_out else process.returncode,
        'stdout': bounded_text(stdout),
        'stderr': bounded_text(stderr),
        'duration_ms': round((time.monotonic() - started) * 1000),
        'timed_out': timed_out,
    }


class UnixHTTPServer(socketserver.UnixStreamServer):  # type: ignore[attr-defined]
    allow_reuse_address = True


class Handler(BaseHTTPRequestHandler):
    server_version = 'chat-lite-table-sandbox/1'

    def log_message(self, format: str, *_args: object) -> None:
        return

    def send_json(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if self.path != '/run':
            self.send_json(404, {'error': 'not found'})
            return
        try:
            length = int(self.headers.get('content-length', '0'))
            if length <= 0 or length > MAX_REQUEST_BYTES:
                self.send_json(413, {'error': 'request too large'})
                return
            payload = json.loads(self.rfile.read(length).decode('utf-8'))
            job_id = str(payload.get('jobId', ''))
            code = payload.get('code')
            if not isinstance(code, str) or not code.strip() or len(code.encode('utf-8')) > MAX_CODE_BYTES:
                self.send_json(400, {'error': 'invalid code'})
                return
            job = valid_job_dir(job_id)
            if job is None:
                self.send_json(400, {'error': 'invalid job'})
                return
            self.send_json(200, run_job(job, code))
        except Exception as error:
            self.send_json(500, {'error': f'{type(error).__name__}: {error}'})


def main() -> None:
    SOCKET_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        SOCKET_PATH.unlink()
    except FileNotFoundError:
        pass
    server = UnixHTTPServer(str(SOCKET_PATH), Handler)
    SOCKET_PATH.chmod(0o660)
    server.serve_forever()


if __name__ == '__main__':
    main()
