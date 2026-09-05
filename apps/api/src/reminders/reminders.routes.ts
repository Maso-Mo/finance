import { Router } from 'express';
import { z } from 'zod';
import { dateOnlySchema } from '@finance/shared-types';
import { parseOrThrow } from '../validation.js';
import { todayLocalISO } from '../dates.js';
import { getReminders } from './reminders.service.js';

const router = Router();

const querySchema = z.object({
  // Jour LOCAL du navigateur (YYYY-MM-DD) : base de « aujourd'hui ».
  today: dateOnlySchema.optional(),
});

// GET /reminders → « Payé ? » : en retard, dues aujourd'hui, bientôt dues.
// Read-only : aucune écriture, aucun solde modifié.
router.get('/', async (req, res) => {
  const query = parseOrThrow(querySchema, req.query);
  res.json(await getReminders(req.userId as string, query.today ?? todayLocalISO()));
});

export const remindersRouter = router;
