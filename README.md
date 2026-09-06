# Finance — gestion financière personnelle (web + API)

Application personnelle de **suivi financier** (journal de transactions, dépenses
planifiées, revenus attendus, budgets, prévision, transferts internes, épargne,
dettes, notifications, assistant IA optionnel). V1 volontairement restreinte :
l'application **n'effectue jamais de mouvement bancaire réel** — elle enregistre
ce que vous avez réellement fait.

Monorepo pnpm :

- `apps/web` — frontend React 19 + Vite + Tailwind v4 (+ TanStack Query).
- `apps/api` — backend Express + TypeScript + Prisma 7 / PostgreSQL.
- `packages/finance-core` — règles financières (Décimaux exacts).
- `packages/shared-types` — DTO/zod partagés.

---

## Prérequis

- Node.js **>= 24 < 25** et pnpm (11.x).
- PostgreSQL **17** — recommandé : Docker (voir `docker-compose.yml`).
- Un navigateur Chromium/Firefox (développement + tests E2E).

## Démarrage rapide (développement)

```bash
# 1. Infrastructure (base PostgreSQL locale)
docker compose up -d db

# 2. Environnements : copier les fichiers d'exemple puis renseigner les valeurs
cp apps/api/.env.example apps/api/.env
#    - DATABASE_URL pointe vers finance_dev
#    - générer un secret : openssl rand -hex 32

# 3. Dépendances + génération Prisma
pnpm install
pnpm --filter @finance/api db:generate

# 4. Migrations (base de développement, SINON voir « Installations vierges »)
#    ⚠ Préférez `migrate deploy` pour toute base partagée/réelle :
cd apps/api && npx prisma migrate deploy

# 5. Catégories système (seed idempotent)
pnpm --filter @finance/api db:seed

# 6. Lancer
pnpm dev:api    # http://localhost:4000
pnpm dev:web    # http://localhost:5173
```

## Installations vierges (recommandé — prouvé à l'étape 14)

`prisma migrate deploy` fonctionne depuis une base **vide** (13 migrations).
```bash
createdb finance_vierge   # ou : docker compose exec -T db createdb -U finance ...
cd apps/api
DATABASE_URL="postgresql://…/finance_vierge?schema=public" npx prisma migrate deploy
DATABASE_URL="postgresql://…/finance_vierge?schema=public" pnpm db:seed
```
⚠ **Politique shadow DB** : ne jamais `reset` `finance_dev` / `finance_test` si
`migrate dev` échoue sur la base shadow. Diagnostiquer, ou utiliser
`migrate deploy` (stratégie sûre). La migration
`20260906125000_add_savings_contribution_transfer_fk` est volontairement
idempotente pour les bases déjà historiques.

## Sauvegarde / restauration (obligatoire pour usage quotidien)

Outil PostgreSQL standard (`pg_dump` custom) via le conteneur `db` :

```bash
pnpm --filter @finance/api db:backup            # base de .env (finance_dev)
pnpm --filter @finance/api db:backup mon_nom    # base explicite
# → écrit apps/api/prisma/backups/ (dossier hors Git)
```

Restauration dans une base **scratch** (jamais une base réelle — garde intégrée) :

```bash
pnpm --filter @finance/api db:restore apps/api/prisma/backups/finance_x.dump finance_restore_probe
docker compose exec -T db psql -U finance -d postgres -c 'DROP DATABASE "finance_restore_probe"'
```

Aucune donnée financière ni secret n'est versionné (dossier `backups/` ignoré,
`.env*` ignorés).

## Audit d'intégrité (lecture seule)

```bash
pnpm --filter @finance/api db:audit
# DATABASE_URL=… permet de cibler une autre base. Session PostgreSQL READ ONLY.
```
24 contrôles : six comptes standards, allocations, sommes = montants, catégories,
transferts, épargne, dettes, statuts liés, doublons budgets/plans, dédup
notifications, propositions assistant.

## Tests / builds

```bash
pnpm -r test          # 680+ tests (core 188, API 372, web 120)
pnpm -r typecheck
pnpm -r build
```

## E2E navigateur réel (Chromium système)

Base dédiée **finance_e2e** (DROP+CREATE), API 4000, build de production en
preview 4173 :

```bash
bash apps/web/e2e/run-e2e.sh
```
Par défaut, `playwright-core` pilote `/usr/bin/chromium` en headless (voir
`apps/web/e2e/e2e.mjs`).

## Web Push (étape 12) — optionnel

Sans clés VAPID l'application reste complète (centre de notifications interne) ;
`GET /assistant/status` et `/notifications/push-config` exposent l'état.

```bash
pnpm --filter @finance/api exec web-push generate-vapid-keys
# renseigner WEB_PUSH_VAPID_PUBLIC_KEY / WEB_PUSH_VAPID_PRIVATE_KEY / SUBJECT
# (app .env, jamais commitées)
```
Règles de sécurité : la clé PRIVÉE ne quitte jamais le serveur ; le Service
Worker ne fait aucune écriture ; le clic d'une notification ne fait que naviguer.

## Assistant IA (étape 13) — optionnel

Sans configuration (`AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL` absents), mode dégradé
propre. Fournisseur compatible OpenAI :

```bash
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=…            # jamais commitée
AI_MODEL=…
AI_TIMEOUT_MS=30000     # défaut
```
L'assistant ne produit **jamais** d'écriture : uniquement des propositions
(`AssistantActionProposal`) qui ne sont exécutées qu'après confirmation
explicite de l'utilisateur (réexécution déterministe côté services métier).

## Dataset de performance (benchmark)

```bash
# base explicitement dédiée (garde anti-dev/prod intégrée)
DATABASE_URL="postgresql://…/finance_perf?schema=public" pnpm --filter @finance/api db:perf-seed
DATABASE_URL="postgresql://…/finance_perf?schema=public" pnpm --filter @finance/api db:audit
node apps/api/scripts/api-perf.mjs http://localhost:4000 perf-benchmark@finance.local 'PerfBenchmark#2026'
```
Génère ~10 000 transactions, 2 000 planned, 1 000 expected, 2 000 transferts,
budgets, épargne, dettes, notifications — déterministe, montants en Décimaux.

## Sécurité

- Access token JWT **en mémoire uniquement** ; refresh token en cookie
  **HttpOnly + SameSite=Lax + Secure (prod)** + rotation et révocation.
- Origin/CORS explicites (jamais `*` avec credentials) ; rate limits sur
  auth / refresh / assistant.
- Ownership systématique `userId` ; aucun ID étranger exploitable (testé).
- React affiche tout en texte — **aucun** `dangerouslySetInnerHTML`.
- Aucune requête SQL non paramétrée (`$queryRawUnsafe` interdit et absent).
- `pnpm audit` : 3 avis sur `mysql2` (dépendance transitive du CLI Prisma,
  non atteignable : backend PostgreSQL) — surveillés, pas d'upgrade majeur
  aveugle (voir rapport d'étape 14).

## Limites V1 (documentées)

- Aucun mouvement bancaire réel, aucune synchronisation bancaire.
- Web Push dépend du navigateur / OS ; non testable en CI headless.
- Assistant IA optionnel (mode dégradé sinon).
- Pas de multi-devises (conversion), pas d'investissement, pas d'application
  mobile, pas de PWA hors-ligne complète.
- Un rappel interne est émis **par source et par jour** (dédup base).

## Healthcheck

`GET /health` : état API + connexion PostgreSQL (`SELECT 1`), léger, jamais de
scheduler ni d'audit dans la requête.
