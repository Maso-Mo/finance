# Ingestion mobile — fondation V1 (relevés PDF + SMS)

Cette page documente la **fondation** d'ingestion financière locale du projet
Finance. V1 = **100 % local, textuel, déterministe, sans LLM, sans service
externe**. Aucune donnée bancaire ne quitte l'appareil.

Principe directeur commun (relevés comme SMS) :

> Une source ingérée ne produit **jamais** une écriture financière directe.
> Elle produit des **candidats** que l'utilisateur relit, corrige et confirme
> avec les écrans existants du journal.

---

## 1. Relevés bancaires / mobile money (PDF locaux)

### Chaîne de traitement

```
PDF (fichier local)
   │  extractPdfText(buffer)            apps/api/src/ingestion/pdf.ts
   │  · 100 % local (node:zlib, aucun paquet PDF)
   │  · décode uniquement les flux FlateDecode + Tj/TJ
   │  · refuse explicitement les non-PDF ; ignore ce qu'il ne comprend pas
   ▼
texte brut
   │  parseStatementText(text)          packages/finance-core/src/statement.ts
   │  · grammaire STRICTE, ligne à ligne, fonctions pures
   │  · sens EXPLICITE : montant signé OU colonne débit/crédit
   │  · toute ligne ambiguë est rejetée avec une raison
   ▼
candidats (rows + ignored + headers)
   │  POST /ingestion/bank-statements/preview   (strictement read-only)
   │  · l'utilisateur coche les lignes à importer
   ▼
POST /ingestion/bank-statements/import { text, rowIndices }
   │  · le serveur RE-PARSE le texte : jamais de montant/type arbitraire
   │  · déduplication idempotente (même fichier rejoué = aucun doublon)
   ▼
Transactions « compte inconnu » / « catégorie inconnue »
   (aucun impact sur les soldes tant qu'un humain ne les ventile pas)
```

### Grammaires de lignes reconnues (V1)

Séparateur : tabulation, puis `;`, puis `|`, puis `,`.

**A. Montant signé** — `date ; libellé ; -montant` (ou `+montant`)

```
2026-09-01;Marche Alakamisy;-4500.00
2026-09-02;Vente zebu;+1500000
```

**B. Colonnes débit / crédit** — `date ; libellé ; débit ; crédit`
(exactement **une** des deux colonnes remplie)

```
01/09/2026;Retrait distributeur;20000.00;
01/09/2026;Virement salaire;;1500000.00
```

Toute autre forme est ignorée **avec une raison** (`ignored`). Une ligne où
débit **et** crédit sont remplis est toujours rejetée.

### Garanties

- `PREVIEW` est strictement read-only (aucune écriture possible depuis la
  route) ;
- `IMPORT` re-parse le texte d'origine et n'accepte que des **indices de
  lignes** déjà reconnues : le client ne peut pas injecter de montant/type ;
- déduplication par `type + montant + date + description` chez l'utilisateur :
  rejouer un import ne crée aucun doublon ;
- les lignes importées arrivent en « compte inconnu » / « catégorie inconnue »
  et **ne modifient aucun solde** tant qu'elles ne sont pas ventilées ;
- extraction PDF volontairement minimaliste : toute construction non
  supportée est ignorée plutôt que devinée.

## 2. SMS « mobile money » (socle pur)

`packages/finance-core/src/sms.ts` pose le socle **pur** (aucune I/O) d'un
futur ingestion SMS MVola / Orange Money / Airtel Money :

- `providerFromSender(sender)` — opérateur reconnu, ou `null` ;
- `extractSmsAmount(body)` / `extractSmsDate(body)` — montants en chaîne
  décimale exacte, dates du JOUR lues dans le corps ;
- `parseMoneySms(message)` → `ParsedSms` : `kind` INCOME / EXPENSE /
  **UNKNOWN** (jamais inventé) ; un SMS ambigu reste UNKNOWN ;
- `smsDedupeKey(sender, body)` — clé stable de déduplication.

Règles verrouillées par les tests (`packages/finance-core/test/sms.test.ts`) :

- l'horodatage du message (`receivedAt`) n'est **jamais** utilisé comme date
  d'occurrence ;
- un SMS n'écrit rien : seule la confirmation humaine passe par les services
  du journal existants ;
- aucun LLM, aucun webhook en V1 (le relais SMS est laissé volontairement
  hors périmètre : la couche d'adaptation reste à brancher sur le transport
  choisi plus tard).

## 3. Périmètre volontairement exclu en V1

- PDF cryptés, polices composites CFF, flux non-FlateDecode → non extraits
  (jamais devinés) ;
- OCR d'images (un relevé scanné devra passer par un OCR local, hors V1) ;
- détection automatique de fournisseur par le contenu : le parseur rejette ce
  qu'il ne reconnaît pas ;
- toute écriture automatique (import ou SMS → transaction sans confirmation
  humaine).

## 4. Emplacements du code

| Élément | Fichier |
| --- | --- |
| Extraction PDF locale (API) | `apps/api/src/ingestion/pdf.ts` |
| Service preview/import relevés | `apps/api/src/ingestion/bank-statements.service.ts` |
| Routes HTTP | `apps/api/src/ingestion/bank-statements.routes.ts` |
| Contrats partagés (Zod) | `packages/shared-types/src/ingestion.ts` |
| Parseur de texte de relevé (pur) | `packages/finance-core/src/statement.ts` |
| Parseur SMS (pur) | `packages/finance-core/src/sms.ts` |
| Tests API | `apps/api/test/ingestion.test.ts` |
| Tests finance-core | `packages/finance-core/test/statement.test.ts`, `…/sms.test.ts` |
