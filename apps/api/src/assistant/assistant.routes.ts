import { Router } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { assistantMessageRequestSchema } from '@finance/shared-types';
import { parseOrThrow } from '../validation.js';
import { assistantConfig } from './config.js';
import { assistantMessage } from './service.js';
import { confirmProposal, cancelProposal, getProposal } from './proposals.js';

/**
 * Routes de l'assistant IA (étape 13) — protégées par auth, sauf le statut.
 *
 * Règles :
 *  - GET strictement read-only ;
 *  - POST /message peut créer un AssistantDraft / une AssistantActionProposal
 *    (tables assistant, jamais une écriture financière) ;
 *  - POST /proposals/:id/confirm est la SEULE voie vers une écriture
 *    financière, et uniquement après confirmation explicite ;
 *  - POST /proposals/:id/confirm n'accepte AUCUNE donnée financière
 *    remplaçable : le payload vient de la proposition persistée.
 */

const router = Router();

function tooManyRequests(_req: Request, res: Response): void {
  res.status(429).json({ error: 'Trop de requêtes. Réessaie dans un instant.' });
}

// Rate limit dédié (anti-spam / coûts API accidentels). Fenêtre courte et
// limite élevée : ne gêne pas l'utilisation normale quotidienne.
const assistantMessageLimiter = rateLimit({
  windowMs: assistantConfig.rateLimitWindowMs,
  limit: assistantConfig.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooManyRequests,
  keyGenerator: (req) =>
    req.userId ? `assistant:${req.userId}` : ipKeyGenerator(req.ip ?? ''),
});

// POST /assistant/message — le cœur conversationnel (auth + rate limit).
router.post('/message', assistantMessageLimiter, async (req, res) => {
  const body = parseOrThrow(assistantMessageRequestSchema, req.body);
  const response = await assistantMessage(req.userId as string, body);
  res.json(response);
});

// GET /assistant/proposals/:id — read-only (status + résumé, jamais payload).
router.get('/proposals/:id', async (req, res) => {
  const proposal = await getProposal(req.userId as string, req.params.id);
  res.json({ proposal });
});

// POST /assistant/proposals/:id/confirm — confirmation explicite et atomique.
router.post('/proposals/:id/confirm', async (req, res) => {
  const result = await confirmProposal(req.userId as string, req.params.id);
  res.json(result);
});

// POST /assistant/proposals/:id/cancel — aucune donnée financière modifiée.
router.post('/proposals/:id/cancel', async (req, res) => {
  const proposal = await cancelProposal(req.userId as string, req.params.id);
  res.json({ proposal });
});

export const assistantRouter = router;
