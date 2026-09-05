-- CreateEnum
CREATE TYPE "PlannedExpenseStatus" AS ENUM ('PENDING', 'PAID', 'CANCELED', 'SKIPPED');

-- CreateTable
CREATE TABLE "recurring_expense_rules" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'MGA',
    "dayOfMonth" INTEGER NOT NULL,
    "categoryId" UUID,
    "categoryUnknown" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_expense_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planned_expenses" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'MGA',
    "dueDate" DATE NOT NULL,
    "categoryId" UUID,
    "categoryUnknown" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "status" "PlannedExpenseStatus" NOT NULL DEFAULT 'PENDING',
    "recurringRuleId" UUID,
    "confirmedTransactionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planned_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recurring_expense_rules_userId_idx" ON "recurring_expense_rules"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "planned_expenses_confirmedTransactionId_key" ON "planned_expenses"("confirmedTransactionId");

-- CreateIndex
CREATE INDEX "planned_expenses_userId_status_idx" ON "planned_expenses"("userId", "status");

-- CreateIndex
CREATE INDEX "planned_expenses_userId_dueDate_idx" ON "planned_expenses"("userId", "dueDate");

-- CreateIndex
CREATE INDEX "planned_expenses_recurringRuleId_status_idx" ON "planned_expenses"("recurringRuleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "planned_expenses_recurringRuleId_dueDate_key" ON "planned_expenses"("recurringRuleId", "dueDate");

-- AddForeignKey
ALTER TABLE "recurring_expense_rules" ADD CONSTRAINT "recurring_expense_rules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_expense_rules" ADD CONSTRAINT "recurring_expense_rules_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planned_expenses" ADD CONSTRAINT "planned_expenses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planned_expenses" ADD CONSTRAINT "planned_expenses_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planned_expenses" ADD CONSTRAINT "planned_expenses_recurringRuleId_fkey" FOREIGN KEY ("recurringRuleId") REFERENCES "recurring_expense_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planned_expenses" ADD CONSTRAINT "planned_expenses_confirmedTransactionId_fkey" FOREIGN KEY ("confirmedTransactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
