import { Router } from 'express';
import { z } from 'zod';
import {
  dateOnlySchema,
  plannedExpenseConfirmPaidSchema,
  plannedExpenseCreateSchema,
  plannedExpenseUpdateSchema,
} from '@finance/shared-types';
import { parseOrThrow } from '../validation.js';
import * as svc from './planned-expenses.service.js';

const router = Router();

// Les routes sont montées dans app.ts sous `/planned-expenses` APRÈS
// `requireAuth` : `req.userId` est donc toujours présent ici.

// ?today=YYYY-MM-DD : jour local du frontend pour calculer les buckets.
const listQuerySchema = z.object({ today: dateOnlySchema.optional() });

// GET /planned-expenses → dépenses futures (ponctuelles + occurrences).
// Rattrape les occurrences manquantes avant de répondre (idempotent).
router.get('/', async (req, res) => {
  const query = parseOrThrow(listQuerySchema, req.query);
  res.json(await svc.listPlannedExpenses(req.userId as string, query.today));
});

// POST /planned-expenses → dépense future ponctuelle (PENDING, aucun solde).
router.post('/', async (req, res) => {
  const body = parseOrThrow(plannedExpenseCreateSchema, req.body);
  const plannedExpense = await svc.createPlannedExpense(
    req.userId as string,
    body,
  );
  res.status(201).json({ plannedExpense });
});

// PATCH /planned-expenses/:id → édition d'une dépense PENDING.
router.patch('/:id', async (req, res) => {
  const body = parseOrThrow(plannedExpenseUpdateSchema, req.body);
  const plannedExpense = await svc.updatePlannedExpense(
    req.userId as string,
    req.params.id,
    body,
  );
  res.json({ plannedExpense });
});

// DELETE /planned-expenses/:id → annulation ponctuelle (CANCELED) OU
// occurrence ignorée (SKIPPED). Pas de suppression physique.
router.delete('/:id', async (req, res) => {
  const plannedExpense = await svc.cancelPlannedExpense(
    req.userId as string,
    req.params.id,
  );
  res.json({ plannedExpense });
});

// POST /planned-expenses/:id/confirm-paid → CONFIRMATION « Oui, payé » :
// crée la vraie Transaction EXPENSE (atomicité, anti double-débit).
router.post('/:id/confirm-paid', async (req, res) => {
  const body = parseOrThrow(plannedExpenseConfirmPaidSchema, req.body);
  const result = await svc.confirmPaidPlannedExpense(
    req.userId as string,
    req.params.id,
    body,
  );
  res.status(201).json(result);
});

// POST /planned-expenses/:id/skip → ignorer CETTE occurrence récurrente.
router.post('/:id/skip', async (req, res) => {
  const plannedExpense = await svc.skipPlannedExpense(
    req.userId as string,
    req.params.id,
  );
  res.json({ plannedExpense });
});

export const plannedExpensesRouter = router;
