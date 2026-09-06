import { Router } from 'express';
import { z } from 'zod';
import { transferUpdateSchema } from '@finance/shared-types';
import { parseOrThrow } from '../validation.js';
import * as svc from './transfers.service.js';

const router = Router();

// Les routes sont montées dans app.ts sous `/transfers` APRÈS `requireAuth` :
// `req.userId` est donc toujours présent ici.

// Pagination simple : page (1-based) + limite raisonnable (max 50).
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// GET /transfers → historique des transferts ACTIFS de l'utilisateur (paginé).
// STRICTEMENT READ-ONLY : aucune écriture.
router.get('/', async (req, res) => {
  const query = parseOrThrow(listQuerySchema, req.query);
  res.json(
    await svc.getTransferLedger(
      req.userId as string,
      query.page,
      query.limit,
    ),
  );
});

// POST /transfers → enregistre un transfert RÉEL déjà effectué. Aucune
// Transaction EXPENSE/INCOME n'est créée (invariant absolu de l'étape 9).
router.post('/', async (req, res) => {
  const body = parseOrThrow(transferUpdateSchema, req.body);
  const transfer = await svc.createTransfer(req.userId as string, body);
  res.status(201).json({ transfer });
});

// PATCH /transfers/:id → modification atomique (remplacement complet) :
// source, destination, montant, frais, date, description.
router.patch('/:id', async (req, res) => {
  const body = parseOrThrow(transferUpdateSchema, req.body);
  const transfer = await svc.updateTransfer(
    req.userId as string,
    req.params.id,
    body,
  );
  res.json({ transfer });
});

// DELETE /transfers/:id → suppression LOGIQUE (deletedAt). Aucune Transaction
// touchée ; les soldes reviennent à leur état sans ce transfert.
router.delete('/:id', async (req, res) => {
  await svc.deleteTransfer(req.userId as string, req.params.id);
  res.status(204).end();
});

export const transfersRouter = router;
