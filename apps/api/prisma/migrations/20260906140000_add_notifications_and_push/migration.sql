-- CENTRE DE NOTIFICATIONS + WEB PUSH (étape 12).
--
-- Règles portées au niveau BASE :
--  - `app_notifications.dedupeKey` UNIQUE : « au maximum UNE notification par
--    (utilisateur × source × type d'événement × jour LOCAL) ». Garantie DB,
--    indépendante des passages concurrents du scheduler (createMany
--    skipDuplicates / P2002) ;
--  - `push_subscriptions.endpoint` UNIQUE : un même endpoint navigateur ne
--    peut être enregistré qu'une seule fois ;
--  - `push_notification_deliveries` UNIQUE(notificationId, pushSubscriptionId)
--    : jamais deux envois accidentels du même rappel vers le même abonnement.
--
-- Aucune contrainte financière ici : une notification est purement
-- informative et ne touche JAMAIS Transactions / Transferts / Règlements /
-- Ajustements / soldes / budgets / dépenses / revenus / dettes.

-- CreateEnum
CREATE TYPE "AppNotificationType" AS ENUM (
  'PLANNED_EXPENSE_DUE',
  'PLANNED_EXPENSE_OVERDUE',
  'EXPECTED_INCOME_DUE',
  'EXPECTED_INCOME_WINDOW',
  'EXPECTED_INCOME_OVERDUE',
  'DEBT_DUE',
  'DEBT_OVERDUE'
);

-- CreateEnum
CREATE TYPE "PushDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "app_notifications" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "AppNotificationType" NOT NULL,
    "sourceType" VARCHAR(40) NOT NULL,
    "sourceId" UUID NOT NULL,
    "localDate" DATE NOT NULL,
    "dedupeKey" VARCHAR(255) NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "route" VARCHAR(255) NOT NULL,
    "pushBody" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "userId" UUID NOT NULL,
    "timezone" VARCHAR(80) NOT NULL,
    "browserPushEnabled" BOOLEAN NOT NULL DEFAULT false,
    "showAmountsInPush" BOOLEAN NOT NULL DEFAULT false,
    "localTime" VARCHAR(5) NOT NULL DEFAULT '09:00',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_notification_deliveries" (
    "id" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "pushSubscriptionId" UUID NOT NULL,
    "status" "PushDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB,
    "lastErrorCode" VARCHAR(40),
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_notifications_dedupeKey_key" ON "app_notifications"("dedupeKey");

-- CreateIndex
CREATE INDEX "app_notifications_userId_isRead_createdAt_idx" ON "app_notifications"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "app_notifications_userId_localDate_idx" ON "app_notifications"("userId", "localDate");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_userId_idx" ON "push_subscriptions"("userId");

-- CreateIndex
CREATE INDEX "push_subscriptions_userId_disabledAt_idx" ON "push_subscriptions"("userId", "disabledAt");

-- CreateIndex
CREATE UNIQUE INDEX "push_notification_deliveries_notificationId_pushSubscriptionId_key" ON "push_notification_deliveries"("notificationId", "pushSubscriptionId");

-- CreateIndex
CREATE INDEX "push_notification_deliveries_status_pushSubscriptionId_idx" ON "push_notification_deliveries"("status", "pushSubscriptionId");

-- AddForeignKey
ALTER TABLE "app_notifications" ADD CONSTRAINT "app_notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_notification_deliveries" ADD CONSTRAINT "push_notification_deliveries_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "app_notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_notification_deliveries" ADD CONSTRAINT "push_notification_deliveries_pushSubscriptionId_fkey" FOREIGN KEY ("pushSubscriptionId") REFERENCES "push_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Contraintes de cohérence (au-delà du schéma Prisma) :
--  1. une timezone enregistrée n'est jamais vide ;
--  2. la cadence quotidienne est un « HH:MM » valide (0..23:0..59) ;
--  3. les sources notifiables sont uniquement les familles connues.
ALTER TABLE "notification_preferences"
  ADD CONSTRAINT "notification_preferences_timezone_not_empty"
  CHECK (length(btrim("timezone")) > 0);

ALTER TABLE "notification_preferences"
  ADD CONSTRAINT "notification_preferences_local_time_format"
  CHECK ("localTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

ALTER TABLE "app_notifications"
  ADD CONSTRAINT "app_notifications_source_type_known"
  CHECK ("sourceType" IN ('PLANNED_EXPENSE', 'EXPECTED_INCOME', 'DEBT'));
