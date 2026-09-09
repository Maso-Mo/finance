import { Router } from 'express';
import {
  statementImportRequestSchema,
  statementPreviewRequestSchema,
} from '@finance/shared-types';
import { parseOrThrow } from '../validation.js';
import { importStatement, previewStatement } from './bank-statements.service.js';

const router = Router();

// Montées dans app.ts sous `/ingestion/bank-statements` APRÈS `requireAuth` :
// `req.userId` est donc toujours présent sur les routes protégées.

// POST /ingestion/bank-statements/preview → aperçu STRICTEMENT read-only du
// texte extrait localement (aucune écriture, aucun appel externe, pas de LLM).
router.post('/preview', async (req, res) => {
  const body = parseOrThrow(statementPreviewRequestSchema, req.body);
  res.json(await previewStatement(body));
});

// POST /ingestion/bank-statements/import → importe les lignes reconnues
// sélectionnées (indices du texte d'origine). Le serveur RE-PARSE le texte :
// le client ne peut pas inventer un montant/type. Idempotent (déduplication).
router.post('/import', async (req, res) => {
  const body = parseOrThrow(statementImportRequestSchema, req.body);
  res.status(201).json(
    await importStatement(req.userId as string, body),
  );
});

export const bankStatementsRouter = router;
