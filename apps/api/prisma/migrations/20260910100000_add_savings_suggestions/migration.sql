-- Additive : table des PROPOSITIONS d'épargne liées aux revenus réels reçus.
-- ⚠ Une proposition n'est jamais de l'argent : aucun montant stocké ici.
-- Le Transfer de confirmation reste la source de vérité (savings_contributions).

-- Enum de décision humaine : PENDING / DISMISSED / CONFIRMED.
CREATE TYPE "SavingsSuggestionStatus" AS ENUM ('PENDING', 'DISMISSED', 'CONFIRMED');

CREATE TABLE "savings_suggestions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "incomeTransactionId" UUID NOT NULL,
    "status" "SavingsSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "sourceAccountId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "savings_suggestions_pkey" PRIMARY KEY ("id")
);

-- Une même Transaction INCOME ne peut jamais produire deux propositions.
CREATE UNIQUE INDEX "savings_suggestions_incomeTransactionId_key" ON "savings_suggestions"("incomeTransactionId");
CREATE UNIQUE INDEX "savings_suggestions_userId_incomeTransactionId_key" ON "savings_suggestions"("userId", "incomeTransactionId");
CREATE INDEX "savings_suggestions_userId_status_idx" ON "savings_suggestions"("userId", "status");

ALTER TABLE "savings_suggestions" ADD CONSTRAINT "savings_suggestions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "savings_suggestions" ADD CONSTRAINT "savings_suggestions_incomeTransactionId_fkey" FOREIGN KEY ("incomeTransactionId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "savings_suggestions" ADD CONSTRAINT "savings_suggestions_sourceAccountId_fkey" FOREIGN KEY ("sourceAccountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
