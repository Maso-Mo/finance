import { Router } from 'express';
import {
  savingsSuggestionConfirmSchema,
  savingsWithdrawalCreateSchema,
} from '@finance/shared-types';
import { parseOrThrow } from '../validation.js';
import * as flows from './savings-flows.service.js';

const router = Router();

// Montées dans app.ts sous `/savings` APRÈS `requireAuth` : `req.userId` est
// donc toujours présent ici.

// GET /savings/suggestions/next → prochaine PROPOSITION post-revenu encore
// PENDING (la plus ancienne d'abord). STRICTEMENT read-only : aucun effet de
// bord, aucune écriture, aucun transfert créé.
router.get('/suggestions/next', async (req, res) => {
  res.json(await flows.getNextSavingsSuggestion(req.userId as string));
});

// POST /savings/suggestions/:id/dismiss → « Ignorer » : la décision PERSISTE
// (reload / re-login / retry réseau ne réaffichent jamais la proposition).
router.post('/suggestions/:id/dismiss', async (req, res) => {
  res.json(
    await flows.dismissSavingsSuggestion(
      req.userId as string,
      req.params.id,
    ),
  );
});

// POST /savings/suggestions/:id/confirm → confirmation explicite : crée
// EXACTEMENT UN AccountTransfer source → SAVINGS (lien plan éventuel). Jamais
// de Transaction EXPENSE/INCOME parallèle. ATOMIQUE + idempotent.
router.post('/suggestions/:id/confirm', async (req, res) => {
  const body = parseOrThrow(savingsSuggestionConfirmSchema, req.body);
  res.json(
    await flows.confirmSavingsSuggestion(
      req.userId as string,
      req.params.id,
      body,
    ),
  );
});

// POST /savings/withdrawals → retrait RÉEL de l'Épargne après confirmation
// du formulaire (montant > 0, jamais plus que le solde Épargne disponible,
// destination valide et possédée). Aucune écriture avant cette confirmation.
router.post('/withdrawals', async (req, res) => {
  const body = parseOrThrow(savingsWithdrawalCreateSchema, req.body);
  res.status(201).json(
    await flows.withdrawFromSavings(req.userId as string, body),
  );
});

export const savingsFlowsRouter = router;
