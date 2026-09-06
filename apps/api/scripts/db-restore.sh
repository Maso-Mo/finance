#!/usr/bin/env bash
# Restauration d'une sauvegarde pg_dump (format custom) dans une base SCRATCH.
#
# Usage :
#   pnpm --filter @finance/api db:restore <fichier.dump> <base_scratch_cible>
#
# ⚠ GARDE ANTI-DESTRUCTION :
#   La base cible ne doit PAS être une base réelle/quotidienne. Le script
#   REFUSE : finance_dev, finance_test, finance_prod, finance, postgres,
#   template0, template1. La base scratch est DROP + CREATE, puis restaurée.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
POSTGRES_USER="$(sed -n 's/^POSTGRES_USER=//p' "$ROOT/.env" 2>/dev/null | tr -d '"' | head -1)"
POSTGRES_USER="${POSTGRES_USER:-finance}"

DUMP_FILE="${1:-}"
TARGET_DB="${2:-}"
if [ -z "$DUMP_FILE" ] || [ -z "$TARGET_DB" ]; then
  echo "Usage : pnpm --filter @finance/api db:restore <fichier.dump> <base_scratch_cible>" >&2
  exit 2
fi
if [ ! -s "$DUMP_FILE" ]; then
  echo "Erreur : fichier de sauvegarde introuvable/vide : $DUMP_FILE" >&2
  exit 2
fi

# ---- Garde : jamais une base réelle/quotidienne ----
BLOCKED='^(finance_dev|finance_test|finance_prod|finance|postgres|template0|template1)$'
if [[ "$TARGET_DB" =~ $BLOCKED ]]; then
  echo "REFUS : '$TARGET_DB' ressemble à une base réelle. Choisissez une base scratch dédiée." >&2
  exit 3
fi

if ! (cd "$ROOT" && docker compose ps --format json 2>/dev/null | grep -q '"Service":"db"'); then
  echo "Erreur : conteneur PostgreSQL 'db' indisponible." >&2
  exit 2
fi

IN_CONTAINER="/tmp/restore_$(basename "$DUMP_FILE")"
docker cp "$DUMP_FILE" "$(cd "$ROOT" && docker compose ps -q db):$IN_CONTAINER"

echo "[restore] DROP + CREATE de la base scratch '$TARGET_DB'…"
(cd "$ROOT" && docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres \
  -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$TARGET_DB\"" -c "CREATE DATABASE \"$TARGET_DB\"")

echo "[restore] pg_restore : $(basename "$DUMP_FILE") → '$TARGET_DB'"
(cd "$ROOT" && docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$TARGET_DB" \
  --no-owner --no-privileges --exit-on-error "$IN_CONTAINER")
(cd "$ROOT" && docker compose exec -T db rm -f "$IN_CONTAINER")

echo "[restore] Vérification (tables publiques restaurées) :"
(cd "$ROOT" && docker compose exec -T db psql -U "$POSTGRES_USER" -d "$TARGET_DB" -Atc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
echo "[restore] OK. Pensez à supprimer la base scratch après validation :"
echo "  docker compose exec -T db psql -U $POSTGRES_USER -d postgres -c 'DROP DATABASE \"$TARGET_DB\"'"
