-- DETTES / CRÉANCES / RÈGLEMENTS (étape 11).
--
-- Règles métier portées au niveau BASE :
--  - `debts.originalAmount` > 0 : le montant initial est la SOURCE DE VÉRITÉ
--    (le restant est toujours DÉRIVÉ : original − Σ règlements actifs) ;
--  - une dette « avance » (`INCOME_ADVANCE_RECEIVABLE`) n'existe QUE sur la
--    direction `OWED_TO_ME` (CHECK) et uniquement si l'utilisateur la qualifie
--    EXPLICITEMENT ainsi — aucune détection automatique ;
--  - échéance : `dueDate` réelle XOR `dueDateUnknown` explicite (jamais les
--    deux ; ni l'une ni l'autre = aucune échéance suivie) ;
--  - `debt_settlements.amount` > 0 : montant RÉELLEMENT payé/reçu, stocké
--    POSITIF — le sens du mouvement est porté par `debts.direction` ;
--  - compte : `accountId` XOR `accountUnknown` explicite (« je ne sais plus ») ;
--  - date : `occurredAt` (jour réel) XOR `dateUnknown` explicite ;
--  - la règle « Σ règlements actifs <= originalAmount » est TRANSACTIONNELLE
--    (verrou ligne SELECT … FOR UPDATE dans le service) : un simple CHECK ne
--    peut pas traverser les lignes, elle n'est donc PAS exprimée ici ;
--  - suppression LOGIQUE partout (`deletedAt`) : jamais de perte d'historique.

-- CreateEnum
CREATE TYPE "DebtDirection" AS ENUM ('I_OWE', 'OWED_TO_ME');

-- CreateEnum
CREATE TYPE "DebtKind" AS ENUM ('STANDARD', 'INCOME_ADVANCE_RECEIVABLE');

-- CreateTable
CREATE TABLE "debts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "direction" "DebtDirection" NOT NULL,
    "kind" "DebtKind" NOT NULL DEFAULT 'STANDARD',
    "originalAmount" DECIMAL(20,2) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'MGA',
    "counterpartyName" TEXT,
    "description" TEXT,
    "dueDate" DATE,
    "dueDateUnknown" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "debts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debt_settlements" (
    "id" UUID NOT NULL,
    "debtId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'MGA',
    "accountId" UUID,
    "accountUnknown" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" TIMESTAMP(3),
    "dateUnknown" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "linkedTransactionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "debt_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "debts_userId_direction_idx" ON "debts"("userId", "direction");

-- CreateIndex
CREATE INDEX "debts_userId_deletedAt_idx" ON "debts"("userId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "debt_settlements_linkedTransactionId_key" ON "debt_settlements"("linkedTransactionId");

-- CreateIndex
CREATE INDEX "debt_settlements_debtId_deletedAt_idx" ON "debt_settlements"("debtId", "deletedAt");

-- CreateIndex
CREATE INDEX "debt_settlements_userId_accountId_idx" ON "debt_settlements"("userId", "accountId");

-- CreateIndex
CREATE INDEX "debt_settlements_userId_deletedAt_idx" ON "debt_settlements"("userId", "deletedAt");

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_settlements" ADD CONSTRAINT "debt_settlements_debtId_fkey" FOREIGN KEY ("debtId") REFERENCES "debts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_settlements" ADD CONSTRAINT "debt_settlements_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_settlements" ADD CONSTRAINT "debt_settlements_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_settlements" ADD CONSTRAINT "debt_settlements_linkedTransactionId_fkey" FOREIGN KEY ("linkedTransactionId") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Contraintes métier au niveau base (au-delà du schéma Prisma) :
--  1. montant initial d'une dette strictement positif ;
--  2. le type « avance » (`INCOME_ADVANCE_RECEIVABLE`) est réservé aux
--     créances (`OWED_TO_ME`) — jamais sur « je dois » ;
--  3. échéance réelle XOR « je ne sais plus » ;
--  4. montant d'un règlement strictement positif ;
--  5. compte précis XOR « compte inconnu » explicite ;
--  6. date réelle XOR « date inconnue » explicite.
ALTER TABLE "debts"
  ADD CONSTRAINT "debts_original_amount_positive" CHECK ("originalAmount" > 0);

ALTER TABLE "debts"
  ADD CONSTRAINT "debts_advance_only_when_owed_to_me"
  CHECK ("kind" <> 'INCOME_ADVANCE_RECEIVABLE' OR "direction" = 'OWED_TO_ME');

ALTER TABLE "debts"
  ADD CONSTRAINT "debts_due_date_xor_unknown"
  CHECK (NOT ("dueDateUnknown" AND "dueDate" IS NOT NULL));

ALTER TABLE "debt_settlements"
  ADD CONSTRAINT "debt_settlements_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "debt_settlements"
  ADD CONSTRAINT "debt_settlements_account_xor_unknown"
  CHECK (NOT ("accountUnknown" AND "accountId" IS NOT NULL));

ALTER TABLE "debt_settlements"
  ADD CONSTRAINT "debt_settlements_date_xor_unknown"
  CHECK (NOT ("dateUnknown" AND "occurredAt" IS NOT NULL));
