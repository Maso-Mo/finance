import { Router } from 'express';
import {
  debtCreateSchema,
  debtSettlementCreateSchema,
  debtSettlementUpdateSchema,
  debtUpdateSchema,
} from '@finance/shared-types';
import { parseOrThrow } from '../validation.js';
import * as svc from './debts.service.js';

const router = Router();

// Les routes sont montées dans app.ts sous `/debts` APRÈS `requireAuth` :
// `req.userId` est donc toujours présent ici.

// GET /debts → toutes les dettes ACTIVES (« je dois » + « on me doit ») avec
// leur solde dérivé (remaining) et leur historique de règlements partiels.
router.get('/', async (req, res) => {
  const debts = await svc.listDebts(req.userId as string);
  res.json({ debts });
});

// POST /debts → nouvelle dette/créance. AUCUN impact comptable à la création.
router.post('/', async (req, res) => {
  const body = parseOrThrow(debtCreateSchema, req.body);
  const debt = await svc.createDebt(req.userId as string, body);
  res.status(201).json({ debt });
});

// PATCH /debts/:id → modification partielle (montant, nom, échéance…).
router.patch('/:id', async (req, res) => {
  const body = parseOrThrow(debtUpdateSchema, req.body);
  const debt = await svc.updateDebt(
    req.userId as string,
    req.params.id,
    body,
  );
  res.json({ debt });
});

// DELETE /debts/:id → suppression LOGIQUE (disparaît des vues, reste en base).
router.delete('/:id', async (req, res) => {
  await svc.deleteDebt(req.userId as string, req.params.id);
  res.status(204).end();
});

// POST /debts/:id/settlements → règlement partiel/total. Impact comptable :
//  - STANDARD : solde du compte uniquement (jamais de Transaction) ;
//  - INCOME_ADVANCE_RECEIVABLE : Transaction INCOME réelle créée atomiquement.
router.post('/:id/settlements', async (req, res) => {
  const body = parseOrThrow(debtSettlementCreateSchema, req.body);
  const result = await svc.createSettlement(
    req.userId as string,
    req.params.id,
    body,
  );
  res.status(201).json(result);
});

// PATCH /debts/:id/settlements/:settlementId → correction d'un règlement
// partiel (montant, compte, date). Les soldes dérivés se recalculent.
router.patch('/:id/settlements/:settlementId', async (req, res) => {
  const body = parseOrThrow(debtSettlementUpdateSchema, req.body);
  const result = await svc.updateSettlement(
    req.userId as string,
    req.params.id,
    req.params.settlementId,
    body,
  );
  res.json(result);
});

// DELETE /debts/:id/settlements/:settlementId → suppression LOGIQUE du
// règlement (l'impact sur le solde disparaît).
router.delete('/:id/settlements/:settlementId', async (req, res) => {
  await svc.deleteSettlement(
    req.userId as string,
    req.params.id,
    req.params.settlementId,
  );
  res.status(204).end();
});

export const debtsRouter = router;
