import { Router } from 'express';
import { z } from 'zod';
import { parseOrThrow } from '../validation.js';
import { getAnalyticsOverview } from './analytics.service.js';
import { dateOnlySchema } from '@finance/shared-types';

/**
 * Routes ANALYTIQUE (tableau de bord) — protégées par auth/ownership.
 *
 * GET /analytics/overview?months=6[&today=YYYY-MM-DD]
 * STRICTEMENT READ-ONLY : le service ne fait que lire le journal réel et
 * calculer. Aucune écriture, aucun changement de statut, aucune génération.
 *
 * `today` (jour LOCAL du front, YYYY-MM-DD) est optionnel : il définit le
 * « mois courant » — par défaut le jour local du serveur.
 */
export const analyticsRouter = Router();

const overviewQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(12).default(6),
  today: dateOnlySchema.optional(),
});

analyticsRouter.get('/overview', async (req, res) => {
  const query = parseOrThrow(overviewQuerySchema, req.query);
  res.json(
    await getAnalyticsOverview(
      req.userId as string,
      query.months,
      query.today,
    ),
  );
});
