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

## Accès PC et téléphone (développement)

Après la configuration initiale, trois processus suffisent :

```bash
docker compose up -d
pnpm --filter @finance/api dev
pnpm --filter @finance/web exec vite --host 0.0.0.0
```

Sur un réseau de confiance, `--host 0.0.0.0` expose Vite aux appareils du réseau.
Pour limiter l'écoute à la carte Wi-Fi, utiliser `--host <IP_LOCALE_DU_PC>`.
Le navigateur appelle `/api` : Vite transmet à l'API locale, et réécrit le
chemin du cookie HttpOnly vers `/api/auth`. Ne pas définir `VITE_API_URL` à
`localhost:4000` pour le téléphone. Un éventuel proxy de production doit
également transmettre `/api` et adapter le chemin du cookie, ou configurer
explicitement une URL API autorisée.

Dans `apps/api/.env`, configurer les origines exactes, séparées par des virgules :
`CORS_ORIGIN=http://localhost:5173,http://<IP_LOCALE_DU_PC>:5173`.
Redémarrer l'API après modification. Le port fait partie de l'origine ;
si 5173 est occupé, choisir un port libre et adapter cette liste.
Le contrôle Origin reste actif. Les cookies Secure de production ne changent pas.

### Checklist téléphone

1. Connecter PC et téléphone au même Wi-Fi.
2. Trouver l'IPv4 Wi-Fi du PC (`ip -4 addr`) et configurer `CORS_ORIGIN` ci-dessus.
3. Lancer DB : `docker compose up -d`.
4. Lancer API : `pnpm --filter @finance/api dev`.
5. Lancer Vite : `pnpm --filter @finance/web exec vite --host 0.0.0.0` (ou l'IP Wi-Fi précise).
6. Ouvrir l'URL Network affichée par Vite sur le téléphone.
7. S'inscrire avec un compte de test.
8. Se déconnecter puis se connecter.
9. Ouvrir le dashboard.
10. Créer une petite opération de test.
11. Actualiser la page.
12. Vérifier la session et l'opération enregistrée.

### Lecture offline

Après une réponse API réussie, IndexedDB conserve les derniers agrégats
analytiques, les six soldes, le résumé des budgets et la prévision. Aucun
historique de transactions ni secret d'authentification n'est copié. Les données
sont isolées par utilisateur, validées et plafonnées à 128 Ko par snapshot.
Une nouvelle réponse remplace le snapshot ; aucune donnée locale ne remonte
vers PostgreSQL. Les boutons d'écriture retournent une erreur claire hors connexion.

Si l'API manque pendant une session, les graphiques utilisent ces snapshots
avec « Hors connexion », période et date de synchronisation. Après un reload,
un choix explicite permet de revoir les données du compte déjà utilisé dans
cet onglet ; aucune donnée n'est restaurée automatiquement sans identité.
Une nouvelle session/absence de snapshot nécessite d'abord une connexion.
Le logout supprime les snapshots et le cache de l'utilisateur sur cet appareil,
y compris quand l'API manque, et empêche le refresh automatique ultérieur.

Le build de production précache l'app shell, les chunks, Inter locale et l'icône
via le Service Worker existant. Aucune réponse API financière ne va dans Cache
Storage. Vérifier avec `pnpm --filter @finance/web build`, puis
`pnpm --filter @finance/web exec vite preview --host 127.0.0.1` ; ajouter
`http://localhost:4173` à `CORS_ORIGIN` pour ce test.

Checklist offline téléphone, séparée de l'accès LAN :

1. Servir le build depuis une origine HTTPS reconnue par le téléphone.
2. Se connecter, attendre les graphiques et l'installation du Service Worker.
3. Couper l'accès au serveur, recharger, puis choisir la consultation locale.
4. Vérifier les deux graphiques, la période, le timestamp et le blocage des écritures.
5. Rétablir la connexion et vérifier la mise à jour, puis se déconnecter et vérifier le nettoyage.

**Lecture offline complète sur téléphone nécessite une origine HTTPS.**
HTTP LAN permet l'accès au site, mais ne valide ni Service Worker offline ni Web Push.

## Tests / builds

```bash
pnpm -r test
pnpm -r typecheck
pnpm -r build
```

## Validation guide, comptabilité et offline

`node apps/web/scripts/verify-finance.mjs` utilise l'API locale, Vite et le build
preview. Il crée ses propres comptes de test et n'efface pas les comptes existants.
Variables facultatives : `FINANCE_WEB_URL`, `FINANCE_BUILD_URL`, `CHROMIUM_PATH`,
`FINANCE_SCREENSHOTS` (défaut `/tmp/finance-validation`).

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

## Assistant IA (étape 13) — optionnel (fournisseur Groq)

Sans configuration (`GROQ_API_KEY`/`GROQ_MODEL` absents), mode dégradé propre :
`GET /assistant/status` → `{ available: false }` et le reste de l'API fonctionne.
Groq est branché **uniquement côté API** (le web ne possède jamais la clé) via
une abstraction `AssistantProvider` (transport HTTP OpenAI-compatible, aucun SDK) :

```bash
GROQ_API_KEY=…                       # jamais commitée
GROQ_MODEL=…                         # ex. openai/gpt-oss-20b
GROQ_BASE_URL=https://api.groq.com/openai/v1   # défaut si absent
GROQ_TIMEOUT_MS=30000                # défaut
GROQ_MAX_COMPLETION_TOKENS=2048      # défaut (min 256) ; inclut le raisonnement
GROQ_REASONING_EFFORT=low            # low|medium|high (modèles GPT-OSS/Qwen3)
GROQ_INCLUDE_REASONING=false         # défaut : `message.reasoning` jamais exposé
```

Sur les modèles à raisonnement (GPT-OSS), le budget `max_completion_tokens`
couvre les tokens de raisonnement : un budget trop faible renvoie un `content`
vide (`finish_reason=length`). Le provider n'utilise **jamais**
`choices[0].message.reasoning` comme réponse et journalise en cas d'échec un
diagnostic sûr (modèle, statut HTTP, `finish_reason`, compteurs de tokens).

Un endpoint OpenAI-compatible hérité (modèle local LAN futur) reste
configurable via `AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL` sans toucher au métier
(`max_tokens`, aucun paramètre de raisonnement).
L'assistant ne produit **jamais** d'écriture : uniquement des propositions
(`AssistantActionProposal`) qui ne sont exécutées qu'après confirmation
explicite de l'utilisateur (réexécution déterministe côté services métier).
Test réel optionnel (jamais exécuté automatiquement) :
`pnpm --filter @finance/api assistant:smoke` — charge `apps/api/.env`
automatiquement, n'appelle le fournisseur que si `GROQ_API_KEY` est présente et
utilise uniquement des données synthétiques.

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
