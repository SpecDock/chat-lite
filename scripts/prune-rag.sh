#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
SERVICE_NAME="${SERVICE_NAME:-chat-lite}"
PERCENT="${RAG_PRUNE_PERCENT:-40}"
MIN_ITEMS="${RAG_PRUNE_MIN_ITEMS:-100}"
MODE="dry-run"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/prune-rag.sh [--apply] [--percent 40] [--min-items 100]

Default is dry-run: it only prints what would be deleted.

Env:
  COMPOSE_FILE=docker-compose.prod.yml
  SERVICE_NAME=chat-lite
  RAG_DATABASE_PATH=/data/rag.db     # used inside container/direct node process
  RAG_PRUNE_PERCENT=40
  RAG_PRUNE_MIN_ITEMS=100
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)
      MODE="apply"
      shift
      ;;
    --percent)
      PERCENT="${2:-}"
      shift 2
      ;;
    --min-items)
      MIN_ITEMS="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! [[ "$PERCENT" =~ ^[0-9]+$ ]] || [ "$PERCENT" -le 0 ] || [ "$PERCENT" -ge 100 ]; then
  echo "--percent must be an integer between 1 and 99" >&2
  exit 1
fi

if ! [[ "$MIN_ITEMS" =~ ^[0-9]+$ ]]; then
  echo "--min-items must be a non-negative integer" >&2
  exit 1
fi

read -r -d '' NODE_SCRIPT <<'NODE' || true
const Database = require('better-sqlite3');
const path = process.env.RAG_DATABASE_PATH || '/data/rag.db';
const percent = Number(process.env.PRUNE_PERCENT || 40);
const minItems = Number(process.env.PRUNE_MIN_ITEMS || 100);
const apply = process.env.PRUNE_APPLY === '1';

const db = new Database(path);
const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rag_items' LIMIT 1").get();
if (!hasTable) {
  console.error(`[rag:prune] rag_items table not found in ${path}`);
  process.exit(1);
}

const total = db.prepare('SELECT COUNT(*) AS count FROM rag_items').get().count;
console.log(`[rag:prune] database=${path}`);
console.log(`[rag:prune] total_chunks=${total} percent=${percent}% min_items=${minItems} mode=${apply ? 'apply' : 'dry-run'}`);

if (total <= minItems) {
  console.log(`[rag:prune] skip: total_chunks <= min_items (${total} <= ${minItems})`);
  process.exit(0);
}

const deleteCount = Math.floor(total * percent / 100);
if (deleteCount <= 0) {
  console.log('[rag:prune] skip: deleteCount is 0');
  process.exit(0);
}

// Lower score = less useful.
// Signals:
// - hit_count: retrieval frequency
// - last_injected_at/last_hit_at: actual recent usefulness
// - importance: semantic long-term value from chunker
// - created_at: older unused chunks are less valuable
const candidates = db.prepare(`
  SELECT
    rowid,
    id,
    user_id,
    conversation_id,
    message_id,
    role,
    chunk_type,
    importance,
    hit_count,
    last_hit_at,
    last_injected_at,
    created_at,
    substr(replace(replace(chunk_text, char(10), ' '), char(13), ' '), 1, 120) AS preview,
    (
      COALESCE(hit_count, 0) * 10
      + CASE WHEN last_injected_at IS NOT NULL THEN 6 ELSE 0 END
      + CASE WHEN last_hit_at IS NOT NULL THEN 3 ELSE 0 END
      + COALESCE(importance, 0.5) * 5
      + CASE WHEN datetime(created_at) >= datetime('now', '-30 days') THEN 2 ELSE 0 END
    ) AS usefulness_score
  FROM rag_items
  ORDER BY usefulness_score ASC, COALESCE(last_hit_at, '') ASC, created_at ASC
  LIMIT ?
`).all(deleteCount);

console.log(`[rag:prune] selected_for_delete=${candidates.length}`);
console.log('[rag:prune] preview first 20 candidates:');
for (const item of candidates.slice(0, 20)) {
  console.log(`- rowid=${item.rowid} score=${Number(item.usefulness_score).toFixed(2)} hits=${item.hit_count} importance=${item.importance} injected=${item.last_injected_at || '-'} type=${item.chunk_type} role=${item.role} text=${item.preview}`);
}

if (!apply) {
  console.log('[rag:prune] dry-run only. Re-run with --apply to delete these chunks.');
  process.exit(0);
}

const hasVec = db.prepare("SELECT 1 FROM sqlite_master WHERE name='vec_rag_items' LIMIT 1").get();
const deleteItem = db.prepare('DELETE FROM rag_items WHERE rowid=?');
const deleteVec = hasVec ? db.prepare('DELETE FROM vec_rag_items WHERE rowid=?') : null;
const tx = db.transaction((rows) => {
  for (const row of rows) {
    if (deleteVec) {
      try { deleteVec.run(BigInt(row.rowid)); } catch {}
    }
    deleteItem.run(row.rowid);
  }
});
tx(candidates);

try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
try { db.exec('VACUUM'); } catch (error) { console.warn('[rag:prune] VACUUM skipped:', error.message); }

const remaining = db.prepare('SELECT COUNT(*) AS count FROM rag_items').get().count;
console.log(`[rag:prune] deleted=${candidates.length} remaining=${remaining}`);
NODE

run_in_container() {
  docker compose -f "$COMPOSE_FILE" exec -T \
    -e PRUNE_APPLY="$([ "$MODE" = "apply" ] && echo 1 || echo 0)" \
    -e PRUNE_PERCENT="$PERCENT" \
    -e PRUNE_MIN_ITEMS="$MIN_ITEMS" \
    "$SERVICE_NAME" node -e "$NODE_SCRIPT"
}

run_direct() {
  PRUNE_APPLY="$([ "$MODE" = "apply" ] && echo 1 || echo 0)" \
  PRUNE_PERCENT="$PERCENT" \
  PRUNE_MIN_ITEMS="$MIN_ITEMS" \
  node -e "$NODE_SCRIPT"
}

if command -v docker >/dev/null 2>&1 && [ -f "$COMPOSE_FILE" ] && docker compose -f "$COMPOSE_FILE" ps -q "$SERVICE_NAME" >/dev/null 2>&1; then
  run_in_container
else
  run_direct
fi
