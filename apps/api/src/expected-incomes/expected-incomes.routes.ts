import { Router } from 'express';
import { z } from 'zod';
import {
  dateOnlySchema,
  expectedIncomeConfirmReceivedSchema,
  expectedIncomeCreateSchema,
  expectedIncomeUpdateSchema,
} from '@finance/shared-types';
import { parseOrThrow } from '../validation.js';
import * as svc from './expected-incomes.service.js';

const router = Router();

// Les routes sont montées dans app.ts sous `/expected-incomes` APRÈS
// `requireAuth` : `req.userId` est donc toujours présent ici.

// ?today=YYYY-MM-DD : jour local du frontend pour dériver reminderBucket.
const listQuerySchema = z.object({ today: dateOnlySchema.optional() });

// GET /expected-incomes → revenus futurs de l'utilisateur (tous statuts).
// STRICTEMENT READ-ONLY : aucune écriture, aucun changement de statut.
router.get('/', async (req, res) => {
  const query = parseOrThrow(listQuerySchema, req.query);
  res.json(await svc.listExpectedIncomes(req.userId as string, query.today));
});

// POST /expected-incomes → revenu futur (PENDING, aucun impact solde).
router.post('/', async (req, res) => {
  const body = parseOrThrow(expectedIncomeCreateSchema, req.body);
  const expectedIncome = await svc.createExpectedIncome(
    req.userId as string,
    body,
  );
  res.status(201).json({ expectedIncome });
});

// PATCH /expected-incomes/:id → édition d'un revenu PENDING.
router.patch('/:id', async (req, res) => {
  const body = parseOrThrow(expectedIncomeUpdateSchema, req.body);
  const expectedIncome = await svc.updateExpectedIncome(
    req.userId as string,
    req.params.id,
    body,
  );
  res.json({ expectedIncome });
});

// DELETE /expected-incomes/:id → ANNULATION (CANCELED), jamais physique.
// Un revenu déjà RECEIVED est refusé (409) : traiter d'abord la Transaction.
router.delete('/:id', async (req, res) => {
  const expectedIncome = await svc.cancelExpectedIncome(
    req.userId as string,
    req.params.id,
  );
  res.json({ expectedIncome });
});

// POST /expected-incomes/:id/confirm-received → « Oui, je l'ai reçu » :
// crée la vraie Transaction INCOME (atomicité, anti double confirmation).
router.post('/:id/confirm-received', async (req, res) => {
  const body = parseOrThrow(expectedIncomeConfirmReceivedSchema, req.body);
  const result = await svc.confirmReceivedExpectedIncome(
    req.userId as string,
    req.params.id,
    body,
  );
  res.status(201).json(result);
});

export const expectedIncomesRouter = router;
