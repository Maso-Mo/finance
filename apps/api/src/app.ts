import { accountingRouter } from './accounting/accounting.routes.js';
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
import { getOnboardingStatus, completeOnboarding } from './onboarding/onboarding.service.js';
import { analyticsRouter } from './analytics/analytics.routes.js';
import { categoriesRouter } from './categories/categories.routes.js';
import { transactionsRouter } from './transactions/transactions.routes.js';
import { plannedExpensesRouter } from './planned-expenses/planned-expenses.routes.js';
import { recurringExpensesRouter } from './recurring-expenses/recurring-expenses.routes.js';
import { remindersRouter } from './reminders/reminders.routes.js';
import { expectedIncomesRouter } from './expected-incomes/expected-incomes.routes.js';
import { incomeRemindersRouter } from './expected-incomes/income-reminders.routes.js';
import { budgetsRouter } from './budgets/budgets.routes.js';
import { transfersRouter } from './transfers/transfers.routes.js';
import { debtsRouter } from './debts/debts.routes.js';
import { forecastRouter } from './forecast/forecast.routes.js';
import { savingsPlansRouter } from './savings/savings.routes.js';
import { bankStatementsRouter } from './ingestion/bank-statements.routes.js';
import {
  notificationsRouter,
  notificationPreferencesRouter,
  pushSubscriptionsRouter,
} from './notifications/notifications.routes.js';
import { assistantRouter } from './assistant/assistant.routes.js';
import { assistantStatus } from './assistant/service.js';

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
    origin: (origin, callback) => {
      if (!origin || corsConfig.origin.includes(origin)) callback(null, true);
      else callback(new ApiError(403, 'Origin not allowed.'));
    },
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

// Catégories système (protégées).
app.use('/categories', requireAuth, categoriesRouter);

// Journal GLOBAL de transactions de l'utilisateur (protégé) : liste paginée,
// création multi-comptes, modification atomique, suppression logique.
app.use('/transactions', requireAuth, transactionsRouter);

// Dépenses futures ponctuelles (étape 6) : PENDING = aucun impact financier.
app.use('/planned-expenses', requireAuth, plannedExpensesRouter);

// Dépenses mensuelles récurrentes (étape 6) : génèrent des occurrences.
app.use('/recurring-expenses', requireAuth, recurringExpensesRouter);

// Rappels internes « Payé ? » (étape 6) : en retard / aujourd'hui / à venir.
app.use('/reminders', requireAuth, remindersRouter);

// Revenus futurs (étape 7) : PENDING = aucun impact financier (CONFIRMED
// comme UNCERTAIN). La réception réelle crée une Transaction INCOME.
app.use('/expected-incomes', requireAuth, expectedIncomesRouter);

// Rappels internes « Reçu ? » (étape 7) : read-only strict, états dérivés.
app.use('/income-reminders', requireAuth, incomeRemindersRouter);

// Budgets mensuels (étape 8) : limites analytiques — aucun impact ledger.
app.use('/budgets', requireAuth, budgetsRouter);

// Prévision FINANCIÈRE de fin de mois (correctif 8.1) : mois courant, GET
// strictement read-only — comptes + PlannedExpense + ExpectedIncome, jamais
// une écriture. À distinguer du spendingForecast de /budgets (dépenses).
app.use('/forecast', requireAuth, forecastRouter);

// Analytique lecture seule du tableau de bord (graphiques) : calculs dérivés
// du journal réel. GET strictement read-only — aucune écriture, aucun statut.
app.use('/analytics', requireAuth, analyticsRouter);
app.use('/accounting', requireAuth, accountingRouter);

// Transferts internes RÉELS entre les comptes de l'utilisateur (étape 9) :
// un modèle DÉDIÉ — JAMAIS une « dépense source + revenu destination ». GET
// strictement read-only ; POST/PATCH/DELETE ne créent/modifient/suppriment
// AUCUNE Transaction EXPENSE/INCOME.
app.use('/transfers', requireAuth, transfersRouter);

// Plans d'épargne mensuels (étape 10) : limites/objectifs analytiques — jamais
// de l'argent. Seule une contribution (AccountTransfer RÉEL vers SAVINGS)
// modifie le solde Épargne. GET strictement read-only.
app.use('/savings-plans', requireAuth, savingsPlansRouter);

// Ingestion LOCALE de relevés (fondation V1) : PREVIEW strictement read-only ;
// IMPORT re-parse le texte soumis, déduplique (idempotent) et n'enregistre
// que des lignes « compte/catégorie inconnus » — 100 % local, sans LLM.
app.use('/ingestion/bank-statements', requireAuth, bankStatementsRouter);

// Dettes et créances (étape 11) : « je dois » / « on me doit » + règlements
// partiels. Un règlement STANDARD n'impacte QUE le solde du compte (jamais
// une Transaction EXPENSE/INCOME, jamais un budget). Seule une dette qualifiée
// EXPLICITEMENT « avance » (OWED_TO_ME) crée une vraie Transaction INCOME
// liée, atomiquement, via ce module.
app.use('/debts', requireAuth, debtsRouter);

// Notifications WEB (étape 12) : centre interne persistant + Web Push.
// GET strictement read-only ; PATCH/POST/DELETE = mutations explicites de
// l'utilisateur (marquer lu, préférences, abonnements navigateur). Aucune
// écriture financière déclenchée par ces routes.
app.use('/notifications', requireAuth, notificationsRouter);
app.use('/notification-preferences', requireAuth, notificationPreferencesRouter);
app.use('/push-subscriptions', requireAuth, pushSubscriptionsRouter);

// Statut de l'assistant IA : PUBLIC, aucune donnée sensible ni secret. Mode
// dégradé documenté : sans configuration AI_* → { available: false }.
app.get('/assistant/status', async (_req, res) => {
  res.json(await assistantStatus());
});

// Assistant IA (étape 13) : le reste des routes est protégé par auth.
// POST /message ne crée que des Draft/Proposal ; POST confirm est la SEULE
// voie vers une écriture financière, après confirmation explicite.
app.use('/assistant', requireAuth, assistantRouter);

// Préférence de devise principale de l'utilisateur (protégée).
app.patch('/me/preferences', requireAuth, async (req, res) => {
  const { currency } = parseOrThrow(currencyPreferenceSchema, req.body);
  await updateUserCurrency(req.userId as string, currency);
  res.status(204).end();
});

// Prise en main guidée (onboarding) — état PERSISTANT minimal, protégé.
// GET  strictement read-only ; POST ne touche à AUCUNE donnée financière.
app.get('/me/onboarding', requireAuth, async (req, res) => {
  res.json(await getOnboardingStatus(req.userId as string));
});
app.post('/me/onboarding/complete', requireAuth, async (req, res) => {
  res.json(await completeOnboarding(req.userId as string));
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
