import { Router } from 'express';
import { z } from 'zod';
import { transactionUpdateSchema } from '@finance/shared-types';
import { parseOrThrow } from '../validation.js';
import * as svc from './transactions.service.js';

const router = Router();

// Les routes sont montées dans app.ts sous `/transactions` APRÈS `requireAuth` :
// `req.userId` est donc toujours présent ici.

// Pagination simple : page (1-based) + limite raisonnable (max 50).
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// GET /transactions → historique GLOBAL de l'utilisateur (actif, paginé).
router.get('/', async (req, res) => {
  const query = parseOrThrow(listQuerySchema, req.query);
  res.json(
    await svc.getTransactionLedger(
      req.userId as string,
      query.page,
      query.limit,
    ),
  );
});

// POST /transactions → nouvelle dépense ou revenu (multi-comptes possible).
router.post('/', async (req, res) => {
  const body = parseOrThrow(transactionUpdateSchema, req.body);
  const transaction = await svc.createTransaction(
    req.userId as string,
    body,
  );
  res.status(201).json({ transaction });
});

// PATCH /transactions/:id → modification atomique (remplacement complet).
router.patch('/:id', async (req, res) => {
  const body = parseOrThrow(transactionUpdateSchema, req.body);
  const transaction = await svc.updateTransaction(
    req.userId as string,
    req.params.id,
    body,
  );
  res.json({ transaction });
});

// DELETE /transactions/:id → suppression LOGIQUE (deletedAt).
router.delete('/:id', async (req, res) => {
  await svc.deleteTransaction(req.userId as string, req.params.id);
  res.status(204).end();
});

export const transactionsRouter = router;
