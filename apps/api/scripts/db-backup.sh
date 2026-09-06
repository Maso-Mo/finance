#!/usr/bin/env bash
# Sauvegarde PostgreSQL standard d'une base Finance (pg_dump, format custom).
#
# Usage :
#   pnpm --filter @finance/api db:backup            # base de .env (finance_dev)
#   pnpm --filter @finance/api db:backup my_db      # base explicite
#
# Le fichier est écrit dans apps/api/prisma/backups/ (ignoré par Git).
# Aucune donnée financière n'est commitée : le dossier de sortie est hors Git.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_DIR="$ROOT/apps/api"
ENV_FILE="$API_DIR/.env"
OUT_DIR="$API_DIR/prisma/backups"
mkdir -p "$OUT_DIR"

POSTGRES_USER="$(sed -n 's/^POSTGRES_USER=//p' "$ROOT/.env" 2>/dev/null | tr -d '"' | head -1)"
POSTGRES_USER="${POSTGRES_USER:-finance}"

# Base cible : argument explicite, sinon base de DATABASE_URL dans .env.
DB="${1:-}"
if [ -z "$DB" ]; then
  if [ -f "$ENV_FILE" ]; then
    DB="$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE" | head -1 | tr -d '"' | sed -E 's|.*/([^/?]+)(\?.*)?$|\1|')"
  fi
fi
if [ -z "$DB" ]; then
  echo "Erreur : aucune base cible (passez un nom de base en argument ou renseignez DATABASE_URL)." >&2
  exit 2
fi

# Vérifications préalables : le conteneur db doit être up.
if ! (cd "$ROOT" && docker compose ps --format json 2>/dev/null | grep -q '"Service":"db"'); then
  echo "Erreur : conteneur PostgreSQL 'db' indisponible (lancez : docker compose up -d db)." >&2
  exit 2
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="$OUT_DIR/${DB}_${STAMP}.dump"

echo "[backup] pg_dump de '$DB' → $OUT_FILE"
(cd "$ROOT" && docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$DB" --format=custom --no-owner --no-privileges) > "$OUT_FILE"

# Vérification minimale : fichier non vide + en-tête pg_dump.
if [ ! -s "$OUT_FILE" ]; then
  echo "Erreur : le fichier de sauvegarde est vide — pg_dump a échoué." >&2
  rm -f "$OUT_FILE"
  exit 1
fi
echo "[backup] OK — $(du -h "$OUT_FILE" | cut -f1) écrit."
echo "[backup] Restauration : pnpm --filter @finance/api db:restore $OUT_FILE <base_scratch>"
