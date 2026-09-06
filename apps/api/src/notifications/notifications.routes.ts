import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../http-error.js';
import { parseOrThrow } from '../validation.js';
import {
  notificationPreferencePatchSchema,
  pushSubscriptionCreateSchema,
} from '@finance/shared-types';
import {
  createPushSubscription,
  disablePushSubscription,
  getPreferences,
  listNotifications,
  listPushSubscriptions,
  markAllNotificationsRead,
  markNotificationRead,
  publicPushConfig,
  toNotificationPublic,
  updatePreferences,
} from './notifications.service.js';

/**
 * Routes NOTIFICATIONS (étape 12) — toutes protégées par auth/ownership.
 *
 * ⚠ GET STRICTEMENT READ-ONLY : aucun GET ne génère de notification,
 * n'exécute le scheduler, ne modifie isRead, ne crée de delivery ni ne touche
 * une donnée financière. Les seules écritures sont des mutations EXPLICITES.
 */

// ------------------------------------------------------------- /notifications

export const notificationsRouter = Router();

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

/** Centre interne paginé (plus récentes d'abord) + compteur non lu. */
notificationsRouter.get('/', async (req, res) => {
  const query = parseOrThrow(listQuerySchema, req.query);
  res.json(
    await listNotifications(req.userId as string, {
      page: query.page,
      limit: query.limit,
      unreadOnly: query.unreadOnly,
    }),
  );
});

/**
 * PATCH /notifications/:id/read — LU/NON LU du CENTRE INTERNE uniquement.
 * Marquer lu ne confirme JAMAIS une dépense payée / un revenu reçu / une
 * dette réglée (aucune écriture financière, testé en API).
 */
notificationsRouter.patch('/:id/read', async (req, res) => {
  const params = parseOrThrow(z.object({ id: z.string().uuid() }), req.params);
  const updated = await markNotificationRead(req.userId as string, params.id);
  if (!updated) {
    throw new ApiError(404, 'Notification not found.');
  }
  res.json({ notification: toNotificationPublic(updated) });
});

/** POST /notifications/read-all — tout marquer comme lu (centre interne). */
notificationsRouter.post('/read-all', async (req, res) => {
  const updated = await markAllNotificationsRead(req.userId as string);
  res.json({ updated });
});

/** GET /notifications/push-config — clé PUBLIQUE VAPID + disponibilité. */
notificationsRouter.get('/push-config', (_req, res) => {
  res.json(publicPushConfig());
});

// -------------------------------------------------- /notification-preferences

export const notificationPreferencesRouter = Router();

/** GET read-only strict (timezone null tant que rien n'est enregistré). */
notificationPreferencesRouter.get('/', async (req, res) => {
  res.json(await getPreferences(req.userId as string));
});

/** PATCH — mutation EXPLICITE (timezone, consentements, cadence). */
notificationPreferencesRouter.patch('/', async (req, res) => {
  const patch = parseOrThrow(notificationPreferencePatchSchema, req.body);
  res.json(await updatePreferences(req.userId as string, patch));
});

// ----------------------------------------------------- /push-subscriptions

export const pushSubscriptionsRouter = Router();

/** GET read-only — liste des appareils (aucune clé p256dh/auth exposée). */
pushSubscriptionsRouter.get('/', async (req, res) => {
  res.json({ subscriptions: await listPushSubscriptions(req.userId as string) });
});

/** POST — enregistre un endpoint navigateur après consentement utilisateur. */
pushSubscriptionsRouter.post('/', async (req, res) => {
  const input = parseOrThrow(pushSubscriptionCreateSchema, req.body);
  const created = await createPushSubscription(req.userId as string, input);
  res.status(201).json({ subscription: created });
});

/** DELETE /:id — désactivation LOGIQUE d'un endpoint (ownership strict). */
pushSubscriptionsRouter.delete('/:id', async (req, res) => {
  const params = parseOrThrow(
    z.object({ id: z.string().uuid() }),
    req.params,
  );
  const disabled = await disablePushSubscription(
    req.userId as string,
    params.id,
  );
  if (!disabled) {
    throw new ApiError(404, 'Push subscription not found.');
  }
  res.status(204).end();
});
