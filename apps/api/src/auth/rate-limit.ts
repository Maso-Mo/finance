import { rateLimit } from 'express-rate-limit';
import type { Request, Response } from 'express';

/**
 * Rate limiting (mémoire, mono-instance).
 * DOCUMENTATION IMPORTANTE : ce limiteur vit en mémoire dans le process.
 * Si l'application devient multi-instance (plusieurs workers/nœuds), il faudra
 * un stockage partagé (ex. Redis). Pour la V1 mono-instance, c'est suffisant.
 */

function tooManyRequests(_req: Request, res: Response): void {
  res.status(429).json({ error: 'Too many requests. Please try again later.' });
}

// Inscription & connexion : par IP, 20 tentatives / 15 min.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooManyRequests,
});

// Refresh : par IP, 100 appels / 15 min.
export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooManyRequests,
});
