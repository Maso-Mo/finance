-- Transfert INTERNE RÉEL entre deux comptes de l'utilisateur (étape 9).
--
-- Règles métier au niveau BASE :
--  - `amount` > 0 : la SOMME CRÉDITÉE sur le compte destination ;
--  - `feeAmount` >= 0 : frais V1 TOUJOURS prélevés EN PLUS sur la SOURCE
--    (0 = aucun frais) ;
--  - `sourceAccountId` <> `destinationAccountId` : un transfert vers le même
--    compte est interdit ;
--  - suppression LOGIQUE (`deletedAt`) : la ligne reste en base mais n'impacte
--    plus les soldes ni l'historique ;
--  - un Transfer n'est JAMAIS une Transaction EXPENSE/INCOME (aucune écriture
--    dans le journal, aucun budget) : seuls les soldes courants dérivés en
--    tiennent compte (source −(amount + fee), destination +amount).
--
-- CreateTable
CREATE TABLE "account_transfers" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sourceAccountId" UUID NOT NULL,
    "destinationAccountId" UUID NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "feeAmount" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "currency" "Currency" NOT NULL DEFAULT 'MGA',
    "occurredAt" TIMESTAMP(3),
    "dateUnknown" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_transfers_userId_deletedAt_idx" ON "account_transfers"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "account_transfers_userId_occurredAt_idx" ON "account_transfers"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "account_transfers_userId_sourceAccountId_idx" ON "account_transfers"("userId", "sourceAccountId");

-- CreateIndex
CREATE INDEX "account_transfers_userId_destinationAccountId_idx" ON "account_transfers"("userId", "destinationAccountId");

-- AddForeignKey
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_sourceAccountId_fkey" FOREIGN KEY ("sourceAccountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_destinationAccountId_fkey" FOREIGN KEY ("destinationAccountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Contraintes métier au niveau base (au-delà du schéma Prisma) :
--  1. le montant transféré (crédité sur la destination) est strictement positif ;
--  2. les frais sont nuls ou positifs (jamais négatifs) ;
--  3. source <> destination (jamais un transfert vers le même compte).
ALTER TABLE "account_transfers"
  ADD CONSTRAINT "account_transfers_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "account_transfers"
  ADD CONSTRAINT "account_transfers_fee_non_negative" CHECK ("feeAmount" >= 0);

ALTER TABLE "account_transfers"
  ADD CONSTRAINT "account_transfers_distinct_accounts"
  CHECK ("sourceAccountId" <> "destinationAccountId");
