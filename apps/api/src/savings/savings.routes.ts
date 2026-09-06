import { Router } from 'express';
import { z } from 'zod';
import {
  monthKeySchema,
  savingsContributionCreateSchema,
  savingsPlanUpdateSchema,
} from '@finance/shared-types';
import { parseOrThrow } from '../validation.js';
import * as svc from './savings.service.js';

const router = Router();

// Les routes sont montées dans app.ts sous `/savings-plans` APRÈS
// `requireAuth` : `req.userId` est donc toujours présent ici.

// GET /savings-plans?month=YYYY-MM → vue analytique read-only du mois : plan
// actif éventuel + cible/contribution DÉRIVÉES + solde réel Épargne.
// STRICTEMENT READ-ONLY : aucune écriture, aucune génération.
router.get('/', async (req, res) => {
  const query = parseOrThrow(
    z.object({ month: monthKeySchema }),
    req.query,
  );
  res.json(await svc.getSavingsMonthView(req.userId as string, query.month));
});

// POST /savings-plans → crée un plan ACTIF (FIXED ou PERCENTAGE) pour un mois.
// Aucun impact sur les soldes : un plan n'est jamais de l'argent.
router.post('/', async (req, res) => {
  const body = parseOrThrow(savingsPlanUpdateSchema, req.body);
  const plan = await svc.createSavingsPlan(req.userId as string, body);
  res.status(201).json({ plan });
});

// PATCH /savings-plans/:id → modifie un plan ACTIF (mode + cible). Aucune
// modification n'altère les Transfers réels déjà enregistrés.
router.patch('/:id', async (req, res) => {
  const body = parseOrThrow(savingsPlanUpdateSchema, req.body);
  const plan = await svc.updateSavingsPlan(
    req.userId as string,
    req.params.id,
    body,
  );
  res.json({ plan });
});

// DELETE /savings-plans/:id → suppression LOGIQUE : le plan disparaît mais les
// Transfers réels restent (l'argent a réellement été épargné).
router.delete('/:id', async (req, res) => {
  await svc.deleteSavingsPlan(req.userId as string, req.params.id);
  res.status(204).end();
});

// POST /savings-plans/:id/contributions → confirme un transfert RÉEL vers
// Épargne et le lie au plan (atomique). Aucune Transaction créée.
router.post('/:id/contributions', async (req, res) => {
  const body = parseOrThrow(savingsContributionCreateSchema, req.body);
  const result = await svc.createSavingsContribution(
    req.userId as string,
    req.params.id,
    body,
  );
  res.status(201).json(result);
});

export const savingsPlansRouter = router;
