import { Router } from 'express';
import { z } from 'zod';
import {
  dateOnlySchema,
  monthKeySchema,
  monthlyBudgetCreateSchema,
  monthlyBudgetUpdateSchema,
} from '@finance/shared-types';
import { parseOrThrow } from '../validation.js';
import * as svc from './budgets.service.js';

const router = Router();

// Les routes sont montées dans app.ts sous `/budgets` APRÈS `requireAuth` :
// `req.userId` est donc toujours présent ici.

const listQuerySchema = z.object({
  // Mois calendaire « YYYY-MM » : jamais d'instant UTC.
  month: monthKeySchema,
  // Jour LOCAL du frontend (YYYY-MM-DD) pour dériver la prévision. Strictement
  // read-only : il ne peut en aucun cas modifier des données.
  today: dateOnlySchema.optional(),
});

// GET /budgets?month=YYYY-MM[&today=YYYY-MM-DD] → vue analytique du mois :
// budgets + spent/remaining/status/forecast. STRICTEMENT READ-ONLY.
router.get('/', async (req, res) => {
  const query = parseOrThrow(listQuerySchema, req.query);
  res.json(
    await svc.getMonthlyBudgets(
      req.userId as string,
      query.month,
      query.today,
    ),
  );
});

// POST /budgets → crée un budget global (sans categoryId) ou par catégorie.
router.post('/', async (req, res) => {
  const body = parseOrThrow(monthlyBudgetCreateSchema, req.body);
  const budget = await svc.createMonthlyBudget(req.userId as string, body);
  res.status(201).json({ budget });
});

// PATCH /budgets/:id → modifie le MONTANT limite d'un budget (jamais le mois
// ni la catégorie : on supprime et on recrée si besoin).
router.patch('/:id', async (req, res) => {
  const body = parseOrThrow(monthlyBudgetUpdateSchema, req.body);
  const budget = await svc.updateMonthlyBudgetAmount(
    req.userId as string,
    req.params.id,
    body,
  );
  res.json({ budget });
});

// DELETE /budgets/:id → supprime le budget (aucune Transaction touchée).
router.delete('/:id', async (req, res) => {
  await svc.deleteMonthlyBudget(req.userId as string, req.params.id);
  res.status(204).end();
});

export const budgetsRouter = router;
