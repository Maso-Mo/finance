/*
  Migration corrective du modèle Transaction (étape 5) :
  - nouvelle entité TransactionAccountAllocation : une transaction est ventilée
    en zéro/une/plusieurs allocations (elle n'appartient plus à un seul compte) ;
  - table Category (catégories système) + AccountAdjustment (correction de solde) ;
  - occurredAt devient nullable (date inconnue explicite) ;
  - suppression LOGIQUE : deletedAt.

  Backfill des données existantes :
  - chaque transaction (modèle historique mono-compte) est convertie en UNE
    allocation de son montant sur son ancien compte ;
  - les anciennes dépenses sans catégorie deviennent « catégorie inconnue »
    (categoryUnknown = true), équivalent sémantique du choix « je ne sais plus ».
*/

-- Phase 1 : nouvelles colonnes (accountId est CONSERVÉE pour le backfill).
ALTER TABLE "transactions"
  ADD COLUMN "accountUnknown" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "categoryId" UUID,
  ADD COLUMN "categoryUnknown" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ALTER COLUMN "occurredAt" DROP NOT NULL;

-- Les transactions existantes n'ont jamais eu de catégorie : les dépenses sont
-- marquées « catégorie inconnue » (explicite), les revenus n'en ont pas besoin.
UPDATE "transactions" SET "categoryUnknown" = ("type" = 'EXPENSE');

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "userId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_account_allocations" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_account_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_adjustments" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_adjustments_pkey" PRIMARY KEY ("id")
);

-- Backfill : l'historique existant (mono-compte) devient une allocation unique
-- de son montant sur l'ancien compte de la transaction.
INSERT INTO "transaction_account_allocations" ("id", "transactionId", "accountId", "amount", "createdAt")
SELECT gen_random_uuid(), "id", "accountId", "amount", "createdAt"
FROM "transactions";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_accountId_fkey";

-- DropIndex
DROP INDEX "transactions_accountId_occurredAt_idx";

-- Suppression de l'ancienne colonne mono-compte (modèle remplacé).
ALTER TABLE "transactions" DROP COLUMN "accountId";

-- CreateIndex
CREATE UNIQUE INDEX "categories_code_key" ON "categories"("code");

-- CreateIndex
CREATE INDEX "categories_userId_idx" ON "categories"("userId");

-- CreateIndex
CREATE INDEX "transaction_account_allocations_accountId_idx" ON "transaction_account_allocations"("accountId");

-- CreateIndex
CREATE INDEX "transaction_account_allocations_transactionId_idx" ON "transaction_account_allocations"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_account_allocations_transactionId_accountId_key" ON "transaction_account_allocations"("transactionId", "accountId");

-- CreateIndex
CREATE INDEX "account_adjustments_userId_idx" ON "account_adjustments"("userId");

-- CreateIndex
CREATE INDEX "account_adjustments_accountId_idx" ON "account_adjustments"("accountId");

-- CreateIndex
CREATE INDEX "transactions_userId_createdAt_idx" ON "transactions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "transactions_userId_deletedAt_idx" ON "transactions"("userId", "deletedAt");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_account_allocations" ADD CONSTRAINT "transaction_account_allocations_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_account_allocations" ADD CONSTRAINT "transaction_account_allocations_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_adjustments" ADD CONSTRAINT "account_adjustments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_adjustments" ADD CONSTRAINT "account_adjustments_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

