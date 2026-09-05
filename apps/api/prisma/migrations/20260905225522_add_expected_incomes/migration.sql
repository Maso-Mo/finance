-- CreateEnum
CREATE TYPE "ExpectedIncomeCertainty" AS ENUM ('CONFIRMED', 'UNCERTAIN');

-- CreateEnum
CREATE TYPE "ExpectedIncomeStatus" AS ENUM ('PENDING', 'RECEIVED', 'CANCELED');

-- CreateTable
CREATE TABLE "expected_incomes" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'MGA',
    "certainty" "ExpectedIncomeCertainty" NOT NULL,
    "status" "ExpectedIncomeStatus" NOT NULL DEFAULT 'PENDING',
    "description" TEXT,
    "expectedDate" DATE,
    "windowStart" DATE,
    "windowEnd" DATE,
    "receivedTransactionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expected_incomes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expected_incomes_receivedTransactionId_key" ON "expected_incomes"("receivedTransactionId");

-- CreateIndex
CREATE INDEX "expected_incomes_userId_status_idx" ON "expected_incomes"("userId", "status");

-- CreateIndex
CREATE INDEX "expected_incomes_userId_expectedDate_idx" ON "expected_incomes"("userId", "expectedDate");

-- AddForeignKey
ALTER TABLE "expected_incomes" ADD CONSTRAINT "expected_incomes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expected_incomes" ADD CONSTRAINT "expected_incomes_receivedTransactionId_fkey" FOREIGN KEY ("receivedTransactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
