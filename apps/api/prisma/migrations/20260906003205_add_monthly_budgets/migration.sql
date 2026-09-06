-- CreateTable
CREATE TABLE "monthly_budgets" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'MGA',
    "categoryId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monthly_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "monthly_budgets_userId_month_idx" ON "monthly_budgets"("userId", "month");

-- AddForeignKey
ALTER TABLE "monthly_budgets" ADD CONSTRAINT "monthly_budgets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_budgets" ADD CONSTRAINT "monthly_budgets_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Index UNIQUES PARTIELS (contraintes métier non exprimables en schéma Prisma) :
--  1. un budget GLOBAL maximum par (userId, month)  → colonnes (userId, month)
--     limité aux lignes SANS catégorie (categoryId IS NULL) ;
--  2. un budget maximum par (userId, month, catégorie) → colonnes
--     (userId, month, categoryId) limité aux lignes AVEC catégorie.
-- PostgreSQL traite les NULL comme distincts : un @@unique([userId, month,
-- categoryId]) simple laisserait passer deux budgets globaux. Ces index
-- partiels garantissent la règle au niveau BASE, y compris en concurrence.
CREATE UNIQUE INDEX "monthly_budgets_global_unique"
  ON "monthly_budgets"("userId", "month")
  WHERE "categoryId" IS NULL;

CREATE UNIQUE INDEX "monthly_budgets_category_unique"
  ON "monthly_budgets"("userId", "month", "categoryId")
  WHERE "categoryId" IS NOT NULL;

-- Montant d'un budget strictement positif (contrainte métier au niveau base).
ALTER TABLE "monthly_budgets"
  ADD CONSTRAINT "monthly_budgets_amount_positive" CHECK ("amount" > 0);
