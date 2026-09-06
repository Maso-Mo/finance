-- CreateEnum
CREATE TYPE "SavingsPlanMode" AS ENUM ('FIXED', 'PERCENTAGE');

-- CreateTable
CREATE TABLE "monthly_savings_plans" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "mode" "SavingsPlanMode" NOT NULL,
    "fixedAmount" DECIMAL(20,2),
    "percentage" DECIMAL(20,2),
    "currency" "Currency" NOT NULL DEFAULT 'MGA',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "monthly_savings_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "savings_contributions" (
    "id" UUID NOT NULL,
    "savingsPlanId" UUID NOT NULL,
    "transferId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "savings_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "monthly_savings_plans_userId_month_idx" ON "monthly_savings_plans"("userId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "savings_contributions_transferId_key" ON "savings_contributions"("transferId");

-- CreateIndex
CREATE INDEX "savings_contributions_savingsPlanId_idx" ON "savings_contributions"("savingsPlanId");

-- AddForeignKey
ALTER TABLE "monthly_savings_plans" ADD CONSTRAINT "monthly_savings_plans_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "savings_contributions" ADD CONSTRAINT "savings_contributions_savingsPlanId_fkey" FOREIGN KEY ("savingsPlanId") REFERENCES "monthly_savings_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "savings_contributions" ADD CONSTRAINT "savings_contributions_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "account_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Contraintes métier au niveau BASE (au-delà du schéma Prisma) :
--  1. AU PLUS UN plan ACTIF par (userId, month). PostgreSQL traite les NULL
--     comme distincts : un @@unique([userId, month]) simple laisserait passer
--     plusieurs plans une fois le premier supprimé logiquement. Cet index
--     UNIQUE PARTIEL garantit la règle au niveau base, y compris en concurrence.
CREATE UNIQUE INDEX "monthly_savings_plans_active_unique"
  ON "monthly_savings_plans"("userId", "month")
  WHERE "deletedAt" IS NULL;

--  2. Modes mutuellement exclusifs : FIXED → fixedAmount présent (pas de
--     percentage) ; PERCENTAGE → percentage présent (pas de fixedAmount).
ALTER TABLE "monthly_savings_plans"
  ADD CONSTRAINT "monthly_savings_plans_mode_shape" CHECK (
    ("mode" = 'FIXED' AND "fixedAmount" IS NOT NULL AND "percentage" IS NULL)
    OR
    ("mode" = 'PERCENTAGE' AND "percentage" IS NOT NULL AND "fixedAmount" IS NULL)
  );

--  3. Une cible FIXE est strictement positive.
ALTER TABLE "monthly_savings_plans"
  ADD CONSTRAINT "monthly_savings_plans_fixed_amount_positive"
  CHECK ("fixedAmount" IS NULL OR "fixedAmount" > 0);

--  4. Un pourcentage est strictement positif et <= 100.
ALTER TABLE "monthly_savings_plans"
  ADD CONSTRAINT "monthly_savings_plans_percentage_bounds"
  CHECK ("percentage" IS NULL OR ("percentage" > 0 AND "percentage" <= 100));

