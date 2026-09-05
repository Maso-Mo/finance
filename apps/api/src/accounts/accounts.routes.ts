import { Router } from 'express';
import { accountBalanceUpdateSchema } from '@finance/shared-types';
import { parseOrThrow } from '../validation.js';
import * as svc from './accounts.service.js';

const router = Router();

// Les routes sont montées dans app.ts sous `/accounts` APRÈS `requireAuth` :
// `req.userId` est donc toujours présent ici.

// GET /accounts → dashboard (devise + six comptes + total disponible).
router.get('/', async (req, res) => {
  res.json(await svc.getDashboard(req.userId as string));
});

// PATCH /accounts/:id → mise à jour du solde initial manuel.
router.patch('/:id', async (req, res) => {
  const body = parseOrThrow(accountBalanceUpdateSchema, req.body);
  const result = await svc.updateInitialBalance(
    req.userId as string,
    req.params.id,
    body.initialBalance,
  );
  res.json(result);
});

export const accountsRouter = router;
