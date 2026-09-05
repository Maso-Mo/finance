import 'dotenv/config';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { appConfig, corsConfig } from './config.js';
import { ApiError } from './http-error.js';
import { prisma } from './db.js';
import { authRouter } from './auth/auth.routes.js';
import { requireAuth } from './auth/middleware.js';
import { parseOrThrow } from './validation.js';
import { currencyPreferenceSchema } from '@finance/shared-types';
import { accountsRouter } from './accounts/accounts.routes.js';
import { updateUserCurrency } from './accounts/accounts.service.js';

/**
 * Construction de l'application Express (sans démarrage réseau).
 * Indexée dans index.ts (démarrage) et réutilisable dans les tests.
 */
export const app = express();

// Headers de sécurité (HSTS, X-Content-Type-Options, etc.).
app.use(helmet());

// CORS : origine explicite du frontend + credentials (jamais "*" avec credentials).
app.use(
  cors({
    origin: corsConfig.origin,
    credentials: true,
  }),
);

app.use(express.json());
app.use(cookieParser());

// Santé technique : distingue API fonctionnelle / base accessible.
app.get('/health', async (_req, res) => {
  let database: { connected: boolean; latencyMs: number | null } = {
    connected: false,
    latencyMs: null,
  };

  try {
    const startedAt = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    database = { connected: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    console.error('[health] database check failed:', error);
    database = { connected: false, latencyMs: null };
  }

  res.status(database.connected ? 200 : 503).json({
    status: database.connected ? 'ok' : 'degraded',
    service: '@finance/api',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    database,
  });
});

// Routes d'authentification.
app.use('/auth', authRouter);

// Comptes financiers (protégés par access JWT).
app.use('/accounts', requireAuth, accountsRouter);

// Préférence de devise principale de l'utilisateur (protégée).
app.patch('/me/preferences', requireAuth, async (req, res) => {
  const { currency } = parseOrThrow(currencyPreferenceSchema, req.body);
  await updateUserCurrency(req.userId as string, currency);
  res.status(204).end();
});

// 404 JSON.
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Gestion centralisée des erreurs.
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const bodyParserStatus =
    err &&
    typeof err === 'object' &&
    typeof (err as { status?: unknown }).status === 'number'
      ? (err as { status: number }).status
      : 0;

  const status =
    err instanceof ApiError
      ? err.status
      : bodyParserStatus >= 400 && bodyParserStatus < 500
        ? bodyParserStatus
        : 500;

  const message =
    err instanceof ApiError
      ? err.message
      : status < 500 &&
          err &&
          typeof err === 'object' &&
          typeof (err as { message?: unknown }).message === 'string'
        ? ((err as { message: string }).message as string)
        : 'Internal server error.';

  if (status >= 500) {
    console.error('[error]', err);
  }

  res.status(status).json({ error: message });
};
app.use(errorHandler);

export { appConfig };
