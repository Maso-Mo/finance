import { Router } from 'express';
import express from 'express';
import {
  statementImportRequestSchema,
  statementPreviewRequestSchema,
} from '@finance/shared-types';
import { ApiError } from '../http-error.js';
import { parseOrThrow } from '../validation.js';
import {
  extractPdfText,
  looksLikePdf,
} from './pdf.js';
import { importStatement, previewStatement } from './bank-statements.service.js';

const router = Router();

// Montées dans app.ts sous `/ingestion/bank-statements` APRÈS `requireAuth` :
// `req.userId` est donc toujours présent sur les routes protégées.

// POST /ingestion/bank-statements/preview → aperçu STRICTEMENT read-only du
// texte extrait localement (aucune écriture, aucun appel externe, pas de LLM).
// Les lignes déjà importées chez l'utilisateur sont signalées (déduplication
// visible AVANT l'import).
router.post('/preview', async (req, res) => {
  const body = parseOrThrow(statementPreviewRequestSchema, req.body);
  res.json(await previewStatement(req.userId as string, body));
});

// POST /ingestion/bank-statements/extract → extraction de TEXTE d'un PDF
// (corps brut application/pdf), 100 % locale (FlateDecode + Tj/TJ). Aucune
// écriture. Un PDF illisible est refusé — jamais de texte deviné.
const rawBody = express.raw({ type: () => true, limit: '12mb' });
router.post('/extract', rawBody, async (req, res) => {
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const contentType = String(req.headers['content-type'] ?? '');
  if (contentType.includes('text/plain')) {
    res.json({ text: buffer.toString('utf8') });
    return;
  }
  if (!looksLikePdf(buffer)) {
    throw new ApiError(400, 'Le fichier n’est pas un PDF exploitable.');
  }
  res.json({ text: extractPdfText(buffer) });
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
