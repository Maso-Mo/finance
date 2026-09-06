-- CreateEnum
CREATE TYPE "AssistantProposalStatus" AS ENUM ('PENDING', 'EXECUTED', 'CANCELED', 'EXPIRED', 'FAILED');

-- CreateTable
CREATE TABLE "assistant_drafts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "intentType" VARCHAR(60) NOT NULL,
    "structuredPayload" JSONB,
    "missingFields" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_action_proposals" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "actionType" VARCHAR(60) NOT NULL,
    "payload" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "status" "AssistantProposalStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "failureReason" VARCHAR(500),
    "resultingResourceType" VARCHAR(60),
    "resultingResourceId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_action_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_drafts_userId_idx" ON "assistant_drafts"("userId");

-- CreateIndex
CREATE INDEX "assistant_action_proposals_userId_status_idx" ON "assistant_action_proposals"("userId", "status");

-- AddForeignKey
ALTER TABLE "assistant_drafts" ADD CONSTRAINT "assistant_drafts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_action_proposals" ADD CONSTRAINT "assistant_action_proposals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "push_notification_deliveries_notificationId_pushSubscriptionId_" RENAME TO "push_notification_deliveries_notificationId_pushSubscriptio_key";

