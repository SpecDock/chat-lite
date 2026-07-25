#!/usr/bin/env bash
# Per-user usage report for Chat Lite.
# Auto-locates app.db at ../data/app.db relative to this script.
# Override with APP_DB=/path/to/app.db if needed.
#
# Usage:
#   bash scripts/usage-report.sh
#   APP_DB=/custom/path/app.db bash scripts/usage-report.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DB="${APP_DB:-${SCRIPT_DIR}/../data/app.db}"

if [ ! -f "$APP_DB" ]; then
  echo "app.db not found: $APP_DB" >&2
  echo "Set APP_DB env var to override, e.g.:" >&2
  echo "  APP_DB=/data/chat-lite/chat-lite/data/app.db bash scripts/usage-report.sh" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 command not found. Install with: apt-get install -y sqlite3" >&2
  exit 1
fi

echo "============================================================"
echo " Chat Lite per-user usage report"
echo " app.db : $APP_DB"
echo " time   : $(date -Iseconds)"
echo "============================================================"
echo ""

echo "[1/3] Token usage per user"
echo "------------------------------------------------------------"
sqlite3 -header -column "$APP_DB" <<'SQL'
SELECT
  u.id                         AS user_id,
  COALESCE(u.email, '(no email)') AS email,
  COUNT(t.id)                            AS records,
  COALESCE(SUM(t.total_tokens), 0)       AS total_tokens,
  COALESCE(SUM(t.cached_tokens), 0)      AS cached_tokens,
  CASE WHEN SUM(t.cache_measured_prompt_tokens) > 0
    THEN printf('%.1f%%', COALESCE(SUM(t.cached_tokens), 0) * 100.0 / SUM(t.cache_measured_prompt_tokens))
    ELSE '--'
  END                                    AS cache_rate
FROM users u
LEFT JOIN token_usage t ON t.user_id = u.id
GROUP BY u.id
ORDER BY total_tokens DESC;
SQL

echo ""
echo "[2/3] Image generation per user"
echo "------------------------------------------------------------"
sqlite3 -header -column "$APP_DB" <<'SQL'
SELECT
  u.id                            AS user_id,
  COALESCE(u.email, '(no email)') AS email,
  COUNT(i.id)                     AS image_count,
  COALESCE(SUM(i.cost_units), 0)  AS total_cost_units
FROM users u
LEFT JOIN image_usage i ON i.user_id = u.id
GROUP BY u.id
ORDER BY image_count DESC;
SQL

echo ""
echo "[3/3] Grand totals"
echo "------------------------------------------------------------"
sqlite3 -header -column "$APP_DB" <<'SQL'
SELECT
  'token_usage' AS table_name,
  COUNT(*) AS rows,
  COALESCE(SUM(total_tokens), 0) AS total_tokens,
  NULL AS total_cost_units,
  COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
  CASE WHEN SUM(cache_measured_prompt_tokens) > 0
    THEN printf('%.1f%%', COALESCE(SUM(cached_tokens), 0) * 100.0 / SUM(cache_measured_prompt_tokens))
    ELSE '--'
  END AS cache_rate
FROM token_usage
UNION ALL
SELECT
  'image_usage' AS table_name,
  COUNT(*) AS rows,
  NULL AS total_tokens,
  COALESCE(SUM(cost_units), 0) AS total_cost_units,
  NULL AS cached_tokens,
  NULL AS cache_rate
FROM image_usage;
SQL

echo ""
echo "============================================================"
echo " Done."
echo "============================================================"
