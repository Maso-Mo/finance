import { Router } from 'express';
import { z } from 'zod';
import { dateOnlySchema } from '@finance/shared-types';
import { parseOrThrow } from '../validation.js';
import { todayLocalISO } from '../dates.js';
import { getIncomeReminders } from './expected-incomes.service.js';

const router = Router();

const querySchema = z.object({
  // Jour LOCAL du navigateur (YYYY-MM-DD) : base de « aujourd'hui ».
  today: dateOnlySchema.optional(),
});

// GET /income-reminders → « Reçu ? » : en retard, à recevoir aujourd'hui,
// dans la période attendue, à venir. Read-only strict : aucune écriture,
// aucun changement de statut (un revenu reste PENDING sans action utilisateur).
router.get('/', async (req, res) => {
  const query = parseOrThrow(querySchema, req.query);
  res.json(
    await getIncomeReminders(
      req.userId as string,
      query.today ?? todayLocalISO(),
    ),
  );
});

export const incomeRemindersRouter = router;
