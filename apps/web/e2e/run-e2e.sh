#!/usr/bin/env bash
# E2E navigateur réel : base vierge dédiée finance_e2e (DROP+CREATE), API sur
# le port 4000, build web en preview sur 4173, puis Chromium via playwright.
#
# ⚠ DESTRUCTIF pour la base DÉDIÉE finance_e2e uniquement (jamais dev/test).
# Usage : bash apps/web/e2e/run-e2e.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_DIR="$ROOT/apps/api"
DB_NAME="finance_e2e"

# On exige une URL pointant explicitement vers finance_e2e (garde).
BASE_URL="$(sed -n 's/^DATABASE_URL=//p' "$API_DIR/.env" | head -1 | tr -d '"')"
DB_HOST="${BASE_URL%/*}"; DB_HOST="${DB_HOST%:*}"
E2E_URL="${BASE_URL%%/*}//finance:$(printf '%s' "$BASE_URL" | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|')@localhost:5432/${DB_NAME}?schema=public"

echo "[e2e] reset base dédiée $DB_NAME…"
(cd "$ROOT" && docker compose exec -T db psql -U finance -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME" >/dev/null)
(cd "$ROOT" && docker compose exec -T db psql -U finance -d postgres -c "CREATE DATABASE $DB_NAME" >/dev/null)

echo "[e2e] migrations from scratch + catégories…"
(cd "$API_DIR" && DATABASE_URL="$E2E_URL" npx prisma migrate deploy >/dev/null)
(cd "$API_DIR" && DATABASE_URL="$E2E_URL" npx tsx prisma/seed.ts >/dev/null)

echo "[e2e] build web (production)…"
(cd "$ROOT" && pnpm --filter @finance/web build >/dev/null)

echo "[e2e] démarrage API (4000) + preview (4173)…"
(cd "$API_DIR" && DATABASE_URL="$E2E_URL" PORT=4000 CORS_ORIGIN="http://localhost:4173" nohup npx tsx src/index.ts >/tmp/e2e-api.log 2>&1 & echo $! > /tmp/e2e-api.pid)
(cd "$ROOT/apps/web" && nohup npx vite preview --port 4173 --strictPort >/tmp/e2e-web.log 2>&1 & echo $! > /tmp/e2e-web.pid)

cleanup() {
  kill "$(cat /tmp/e2e-api.pid 2>/dev/null)" 2>/dev/null || true
  kill "$(cat /tmp/e2e-web.pid 2>/dev/null)" 2>/dev/null || true
  pkill -f 'vite preview --port 4173' 2>/dev/null || true
  pkill -f 'tsx src/index.ts' 2>/dev/null || true
}
trap cleanup EXIT

for i in $(seq 1 30); do
  curl -sf http://localhost:4000/health >/dev/null && break
  sleep 1
done
for i in $(seq 1 30); do
  curl -sf http://localhost:4173 >/dev/null && break
  sleep 1
done

echo "[e2e] exécution Playwright…"
node "$ROOT/apps/web/e2e/e2e.mjs" http://localhost:4173 http://localhost:4000 /usr/bin/chromium
