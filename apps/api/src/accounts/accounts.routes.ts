import { Router } from 'express';
import { accountTargetBalanceSchema } from '@finance/shared-types';
import { parseOrThrow } from '../validation.js';
import * as svc from './accounts.service.js';

const router = Router();

// Les routes sont montées dans app.ts sous `/accounts` APRÈS `requireAuth` :
// `req.userId` est donc toujours présent ici.

// GET /accounts → dashboard (devise + six comptes + total disponible).
router.get('/', async (req, res) => {
  res.json(await svc.getDashboard(req.userId as string));
});

// PATCH /accounts/:id → saisie du solde CIBLE (« je veux que le solde connu
// devienne X »). Le backend décide : initialBalance (aucun mouvement) ou
// AccountAdjustment (correction) — cf. accounts.service.
router.patch('/:id', async (req, res) => {
  const body = parseOrThrow(accountTargetBalanceSchema, req.body);
  const result = await svc.setAccountTargetBalance(
    req.userId as string,
    req.params.id,
    body.targetBalance,
  );
  res.json(result);
});

export const accountsRouter = router;
