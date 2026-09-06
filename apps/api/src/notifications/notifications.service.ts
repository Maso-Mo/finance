/**
 * Service NOTIFICATIONS (étape 12) — centre interne, préférences, abonnements.
 *
 * ⚠ RÈGLE ABSOLUE : AUCUNE écriture financière ici. Marquer une notification
 * lue ne confirme jamais une dépense payée, un revenu reçu, une dette réglée.
 * La génération des rappels vit dans notification-scheduler.ts (UNIQUEMENT
 * scheduler / bootstrap / mutations explicitement prévues) — jamais dans un
 * GET.
 */
import { ApiError } from '../http-error.js';
import { prisma } from '../db.js';
import { dbDateToISO } from '../dates.js';
import { isValidTimeZone } from '@finance/finance-core';
import { publicPushConfig } from './push-config.js';
import type {
  AppNotificationPublic,
  NotificationPreferencePatch,
  NotificationPreferencePublic,
  NotificationsListResponse,
  PushSubscriptionCreate,
} from '@finance/shared-types';

export type NotificationRow = {
  id: string;
  userId: string;
  type: string;
  sourceType: string;
  sourceId: string;
  localDate: Date;
  title: string;
  body: string;
  route: string;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
};

export function toNotificationPublic(row: NotificationRow): AppNotificationPublic {
  return {
    id: row.id,
    type: row.type as AppNotificationPublic['type'],
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    localDate: dbDateToISO(row.localDate),
    title: row.title,
    body: row.body,
    route: row.route,
    isRead: row.isRead,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ------------------------------------------------------------- CENTRE ------

export interface ListNotificationsOptions {
  page: number;
  limit: number;
  unreadOnly: boolean;
}

/** Liste paginée (plus récentes d'abord) + compteur non lu. STRICTEMENT READ-ONLY. */
export async function listNotifications(
  userId: string,
  options: ListNotificationsOptions,
): Promise<NotificationsListResponse> {
  const where = {
    userId,
    ...(options.unreadOnly ? { isRead: false } : {}),
  };
  const [rows, total, unreadCount] = await Promise.all([
    prisma.appNotification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (options.page - 1) * options.limit,
      take: options.limit,
    }),
    prisma.appNotification.count({ where }),
    prisma.appNotification.count({ where: { userId, isRead: false } }),
  ]);
  return {
    notifications: rows.map((row) =>
      toNotificationPublic(row as unknown as NotificationRow),
    ),
    total,
    page: options.page,
    limit: options.limit,
    unreadCount,
  };
}

/** Marque UNE notification comme lue (centre interne uniquement). */
export async function markNotificationRead(
  userId: string,
  notificationId: string,
): Promise<NotificationRow | null> {
  const existing = await prisma.appNotification.findFirst({
    where: { id: notificationId, userId },
  });
  if (!existing) {
    return null;
  }
  const updated = await prisma.appNotification.update({
    where: { id: notificationId },
    data: { isRead: true, readAt: new Date() },
  });
  return updated as unknown as NotificationRow;
}

/** « Tout marquer comme lu » (centre interne uniquement). */
export async function markAllNotificationsRead(userId: string): Promise<number> {
  const result = await prisma.appNotification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return result.count;
}

// -------------------------------------------------------- PRÉFÉRENCES ------

const DEFAULT_LOCAL_TIME = '09:00';

function defaultPreferences(): NotificationPreferencePublic {
  return {
    timezone: null,
    browserPushEnabled: false,
    showAmountsInPush: false,
    localTime: DEFAULT_LOCAL_TIME,
  };
}

function toPreferencesPublic(row: {
  timezone: string;
  browserPushEnabled: boolean;
  showAmountsInPush: boolean;
  localTime: string;
}): NotificationPreferencePublic {
  return {
    timezone: row.timezone,
    browserPushEnabled: row.browserPushEnabled,
    showAmountsInPush: row.showAmountsInPush,
    localTime: row.localTime,
  };
}

/** GET : read-only strict. Sans préférence : valeurs par défaut (timezone null). */
export async function getPreferences(
  userId: string,
): Promise<NotificationPreferencePublic> {
  const row = await prisma.notificationPreference.findUnique({
    where: { userId },
  });
  return row ? toPreferencesPublic(row) : defaultPreferences();
}

function assertValidTimeZone(timezone: string): void {
  if (!isValidTimeZone(timezone)) {
    throw new ApiError(400, `Unknown IANA time zone: "${timezone}".`);
  }
}

/**
 * PATCH /notification-preferences (mutation explicite utilisateur).
 * À la PREMIÈRE création, la timezone est obligatoire : sans elle, aucun
 * rappel quotidien ne peut être cadencé dans le jour local de l'utilisateur.
 */
export async function updatePreferences(
  userId: string,
  patch: NotificationPreferencePatch,
): Promise<NotificationPreferencePublic> {
  const existing = await prisma.notificationPreference.findUnique({
    where: { userId },
  });

  if (!existing) {
    if (!patch.timezone) {
      throw new ApiError(400, 'A timezone is required to enable daily reminders.');
    }
    assertValidTimeZone(patch.timezone);
    const created = await prisma.notificationPreference.create({
      data: {
        userId,
        timezone: patch.timezone,
        browserPushEnabled: patch.browserPushEnabled ?? false,
        showAmountsInPush: patch.showAmountsInPush ?? false,
        localTime: patch.localTime ?? DEFAULT_LOCAL_TIME,
      },
    });
    return toPreferencesPublic(created);
  }

  if (patch.timezone !== undefined) {
    assertValidTimeZone(patch.timezone);
  }
  const updated = await prisma.notificationPreference.update({
    where: { userId },
    data: {
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.browserPushEnabled !== undefined
        ? { browserPushEnabled: patch.browserPushEnabled }
        : {}),
      ...(patch.showAmountsInPush !== undefined
        ? { showAmountsInPush: patch.showAmountsInPush }
        : {}),
      ...(patch.localTime !== undefined ? { localTime: patch.localTime } : {}),
    },
  });
  return toPreferencesPublic(updated);
}

// ------------------------------------------------------ PUSH SUBSCRIPTIONS --

export interface PushSubscriptionPublicRow {
  id: string;
  createdAt: string;
  disabledAt: string | null;
}

function toSubscriptionPublic(row: {
  id: string;
  createdAt: Date;
  disabledAt: Date | null;
}): PushSubscriptionPublicRow {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    disabledAt: row.disabledAt ? row.disabledAt.toISOString() : null,
  };
}

/** GET /push-subscriptions — liste des appareils (aucune clé exposée). */
export async function listPushSubscriptions(
  userId: string,
): Promise<PushSubscriptionPublicRow[]> {
  const rows = await prisma.pushSubscription.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => toSubscriptionPublic(row));
}

/** POST /push-subscriptions — associe l'endpoint au bon utilisateur. */
export async function createPushSubscription(
  userId: string,
  input: PushSubscriptionCreate,
): Promise<PushSubscriptionPublicRow> {
  const existingForUser = await prisma.pushSubscription.findUnique({
    where: { endpoint: input.endpoint },
  });
  if (existingForUser) {
    if (existingForUser.userId !== userId) {
      throw new ApiError(
        409,
        'This push subscription is already registered for another account.',
      );
    }
    // Ré-inscription (même navigateur conservant son endpoint après
    // désactivation) : on RÉACTIVE l'abonnement au lieu d'en créer un double.
    if (existingForUser.disabledAt) {
      const reactivated = await prisma.pushSubscription.update({
        where: { id: existingForUser.id },
        data: { disabledAt: null },
      });
      return toSubscriptionPublic(reactivated);
    }
    return toSubscriptionPublic(existingForUser);
  }
  try {
    const created = await prisma.pushSubscription.create({
      data: {
        userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
      },
    });
    return toSubscriptionPublic(created);
  } catch (error) {
    // Course : deux POST simultanés pour le même endpoint → contrainte UNIQUE.
    if ((error as { code?: string }).code === 'P2002') {
      const winner = await prisma.pushSubscription.findUniqueOrThrow({
        where: { endpoint: input.endpoint },
      });
      if (winner.userId !== userId) {
        throw new ApiError(
          409,
          'This push subscription is already registered for another account.',
        );
      }
      if (winner.disabledAt) {
        const reactivated = await prisma.pushSubscription.update({
          where: { id: winner.id },
          data: { disabledAt: null },
        });
        return toSubscriptionPublic(reactivated);
      }
      return toSubscriptionPublic(winner);
    }
    throw error;
  }
}

/**
 * DELETE /push-subscriptions/:id — désactivation LOGIQUE (ownership strict).
 * Ne supprime aucune notification interne. Un endpoint désactivé (dont
 * 404/410 du fournisseur) n'est jamais retenté.
 */
export async function disablePushSubscription(
  userId: string,
  subscriptionId: string,
): Promise<boolean> {
  const existing = await prisma.pushSubscription.findFirst({
    where: { id: subscriptionId, userId },
  });
  if (!existing) {
    return false;
  }
  await prisma.pushSubscription.update({
    where: { id: subscriptionId },
    data: { disabledAt: new Date() },
  });
  return true;
}

// ------------------------------------------------------------- CONFIG ------

export { publicPushConfig };


