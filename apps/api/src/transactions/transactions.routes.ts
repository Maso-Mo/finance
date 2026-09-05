import { Router } from 'express';
import { transactionCreateSchema } from '@finance/shared-types';
import { parseOrThrow } from '../validation.js';
import * as svc from './transactions.service.js';

const router = Router();

// Les routes sont montées dans app.ts sous `/accounts` APRÈS `requireAuth` :
// `req.userId` est donc toujours présent ici.

// GET /accounts/:accountId/transactions → journal du compte (compte avec
// solde dérivé + opérations + totaux revenus/dépenses).
router.get('/:accountId/transactions', async (req, res) => {
  const ledger = await svc.getAccountLedger(
    req.userId as string,
    req.params.accountId,
  );
  res.json(ledger);
});

// POST /accounts/:accountId/transactions → nouvelle dépense ou revenu (201).
router.post('/:accountId/transactions', async (req, res) => {
  const body = parseOrThrow(transactionCreateSchema, req.body);
  const transaction = await svc.createAccountTransaction(
    req.userId as string,
    req.params.accountId,
    body,
  );
  res.status(201).json({ transaction });
});

// DELETE /accounts/:accountId/transactions/:transactionId → suppression
// (correction d'une saisie erronée).
router.delete('/:accountId/transactions/:transactionId', async (req, res) => {
  await svc.deleteAccountTransaction(
    req.userId as string,
    req.params.accountId,
    req.params.transactionId,
  );
  res.status(204).end();
});

export const transactionsRouter = router;
