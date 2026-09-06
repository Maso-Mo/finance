import { z } from 'zod';
import { dateOnlySchema } from './transaction.js';

/**
 * Contrats partagés des NOTIFICATIONS WEB (étape 12).
 *
 * Centre interne persistant + notifications navigateur (Web Push). Règles :
 *  - une notification est purement INFORMATIVE : elle ne crée/modifie jamais
 *    une donnée financière. Aucune action de confirmation n'est déclenchée par
 *    un GET, un clic ou un « marquer lu » ;
 *  - les sources financières restent la SEULE vérité : aucun DTO public ne
 *    duplique leur statut métier ;
 *  - aucun secret n'est partagé (pas de clé VAPID privée, pas de clés
 *    p256dh/auth d'abonnement, pas de JWT).
 */

// --- Type d'événement de rappel ---
export const notificationTypeSchema = z.enum([
  'PLANNED_EXPENSE_DUE',
  'PLANNED_EXPENSE_OVERDUE',
  'EXPECTED_INCOME_DUE',
  'EXPECTED_INCOME_WINDOW',
  'EXPECTED_INCOME_OVERDUE',
  'DEBT_DUE',
  'DEBT_OVERDUE',
]);
export type AppNotificationType = z.infer<typeof notificationTypeSchema>;

// --- Notification interne (centre) ---
export const appNotificationPublicSchema = z.object({
  id: z.string().uuid(),
  type: notificationTypeSchema,
  sourceType: z.string(),
  sourceId: z.string().uuid(),
  // Jour LOCAL (YYYY-MM-DD) qui a produit ce rappel quotidien.
  localDate: dateOnlySchema,
  title: z.string(),
  body: z.string(),
  route: z.string().startsWith('/'),
  isRead: z.boolean(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type AppNotificationPublic = z.infer<typeof appNotificationPublicSchema>;

export const notificationsListResponseSchema = z.object({
  notifications: z.array(appNotificationPublicSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  // Nombre de notifications NON LUES (badge de la cloche).
  unreadCount: z.number().int().nonnegative(),
});
export type NotificationsListResponse = z.infer<
  typeof notificationsListResponseSchema
>;

export const notificationReadResponseSchema = z.object({
  notification: appNotificationPublicSchema,
});
export type NotificationReadResponse = z.infer<
  typeof notificationReadResponseSchema
>;

export const readAllNotificationsResponseSchema = z.object({
  updated: z.number().int().nonnegative(),
});
export type ReadAllNotificationsResponse = z.infer<
  typeof readAllNotificationsResponseSchema
>;

// --- Préférences de notifications ---
export const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM (24h).');
export type LocalTime = z.infer<typeof localTimeSchema>;

// GET : timezone null = préférence pas encore enregistrée (le frontend propose
// alors Intl.DateTimeFormat().resolvedOptions().timeZone).
export const notificationPreferencePublicSchema = z.object({
  timezone: z.string().nullable(),
  browserPushEnabled: z.boolean(),
  showAmountsInPush: z.boolean(),
  localTime: localTimeSchema,
});
export type NotificationPreferencePublic = z.infer<
  typeof notificationPreferencePublicSchema
>;

// PATCH : champs partiels. La timezone est OBLIGATOIRE à la première
// création (sans elle aucun rappel journalier ne peut être cadencé dans le
// jour local de l'utilisateur).
export const notificationPreferencePatchSchema = z.object({
  timezone: z.string().trim().min(1).max(80).optional(),
  browserPushEnabled: z.boolean().optional(),
  showAmountsInPush: z.boolean().optional(),
  localTime: localTimeSchema.optional(),
});
export type NotificationPreferencePatch = z.infer<
  typeof notificationPreferencePatchSchema
>;

// --- Configuration Push (jamais de secret) ---
export const pushConfigSchema = z.object({
  pushAvailable: z.boolean(),
  publicKey: z.string().nullable(),
});
export type PushConfig = z.infer<typeof pushConfigSchema>;

// --- Abonnements navigateur ---
export const pushSubscriptionPublicSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string(),
  disabledAt: z.string().nullable(),
});
export type PushSubscriptionPublic = z.infer<typeof pushSubscriptionPublicSchema>;

export const pushSubscriptionCreateSchema = z.object({
  endpoint: z.string().url().max(500),
  p256dh: z.string().min(1).max(500),
  auth: z.string().min(1).max(500),
});
export type PushSubscriptionCreate = z.infer<typeof pushSubscriptionCreateSchema>;
