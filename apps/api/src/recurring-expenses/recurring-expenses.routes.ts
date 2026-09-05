import { Router } from 'express';
import {
  recurringExpenseCreateSchema,
  recurringExpenseUpdateSchema,
} from '@finance/shared-types';
import { parseOrThrow } from '../validation.js';
import * as svc from './recurring-expenses.service.js';

const router = Router();

// Les routes sont montées dans app.ts sous `/recurring-expenses` APRÈS
// `requireAuth` : `req.userId` est donc toujours présent ici.

// GET /recurring-expenses → règles de l'utilisateur (avec occurrences PENDING).
router.get('/', async (req, res) => {
  res.json(await svc.listRecurringExpenses(req.userId as string));
});

// POST /recurring-expenses → nouvelle dépense mensuelle + génération des
// occurrences (mois courant + 3 mois suivants).
router.post('/', async (req, res) => {
  const body = parseOrThrow(recurringExpenseCreateSchema, req.body);
  const recurringExpense = await svc.createRecurringExpense(
    req.userId as string,
    body,
  );
  res.status(201).json({ recurringExpense });
});

// PATCH /recurring-expenses/:id → édition (occurrences futures non résolues).
router.patch('/:id', async (req, res) => {
  const body = parseOrThrow(recurringExpenseUpdateSchema, req.body);
  const recurringExpense = await svc.updateRecurringExpense(
    req.userId as string,
    req.params.id,
    body,
  );
  res.json({ recurringExpense });
});

// DELETE /recurring-expenses/:id → désactivation (historique conservé).
router.delete('/:id', async (req, res) => {
  await svc.deactivateRecurringExpense(req.userId as string, req.params.id);
  res.status(204).end();
});

export const recurringExpensesRouter = router;
