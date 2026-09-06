import { Router } from 'express';
import { z } from 'zod';
import { dateOnlySchema } from '@finance/shared-types';
import { parseOrThrow } from '../validation.js';
import * as svc from './forecast.service.js';

const router = Router();

// Les routes sont montées dans app.ts sous `/forecast` APRÈS `requireAuth` :
// `req.userId` est donc toujours présent ici.

// GET /forecast?today=YYYY-MM-DD → PRÉVISION FINANCIÈRE DU MOIS COURANT
// (le mois contenant `today`). STRICTEMENT READ-ONLY : lectures seules
// (comptes, transactions dérivées, PlannedExpense, ExpectedIncome), calcul,
// retour. Aucune écriture ni changement de statut. Ce contrat ne couvre QUE
// le mois courant : pour un mois passé/futur ce concept est absent (voir
// shared-types/forecast.ts) — on n'invente jamais un solde de départ.
const querySchema = z.object({
  today: dateOnlySchema.optional(),
});

router.get('/', async (req, res) => {
  const query = parseOrThrow(querySchema, req.query);
  res.json(await svc.getMonthEndFinancialForecast(req.userId as string, query.today));
});

export const forecastRouter = router;
