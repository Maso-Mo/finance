import { z } from 'zod';
import { prisma } from '../db.js';
import { getDashboard } from '../accounts/accounts.service.js';
import { getMonthEndFinancialForecast } from '../forecast/forecast.service.js';
import { getMonthlyBudgets } from '../budgets/budgets.service.js';
import type { AccountType } from '@finance/shared-types';

/**
 * Registry des OUTILS READ-ONLY de l'assistant (étape 13).
 *
 * ⚠ SÉCURITÉ :
 *  - chaque outil reçoit `ToolContext` (userId INJECTÉ par l'auth backend) et
 *    n'accepte JAMAIS de userId en provenance du modèle ;
 *  - aucun outil n'écrit : uniquement des lectures Prisma agrégées/paginées ;
 *  - les arguments sont validés par un schéma Zod dédié AVANT exécution ;
 *  - le volume renvoyé est BORNE (agrégats + échantillons limités), jamais un
 *    dump complet de l'historique.
 */

export interface ToolContext {
  userId: string;
  /** Jour local du frontend (YYYY-MM-DD), référence temporelle. */
  today: string;
  /** Mois calendaire « YYYY-MM » contenant `today`. */
  monthKey: string;
}

export interface AssistantTool {
  name: string;
  /** Description FR courte envoyée au modèle (il choisit quoi appeler). */
  description: string;
  /** Schéma Zod des arguments (peut être vide). */
  argsSchema: z.ZodType<unknown>;
  handler: (ctx: ToolContext, args: unknown) => Promise<unknown>;
}

/** Libellé FR d'un type de compte (résumés lisibles). */
const ACCOUNT_LABELS: Record<AccountType, string> = {
  BANK: 'Banque',
  MVOLA: 'MVola',
  ORANGE_MONEY: 'Orange Money',
  AIRTEL_MONEY: 'Airtel Money',
  CASH: 'Cash',
  SAVINGS: 'Épargne',
};

function money(value: unknown): string {
  return (value as { toString(): string }).toString();
}

/** Bornes UTC d'un mois calendaire pour les filtres Prisma. */
function monthBounds(monthKey: string): { gte: Date; lt: Date } {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const gte = new Date(Date.UTC(year, month - 1, 1));
  const lt = new Date(Date.UTC(year, month, 1));
  return { gte, lt };
}

/** Résolution code OU nom exact d'une catégorie système (insensible à la casse). */
export async function findCategoryIdByRef(ref: string): Promise<{
  id: string;
  code: string;
  name: string;
} | null> {
  const normalized = ref.trim();
  if (!normalized) {
    return null;
  }
  const rows = await prisma.category.findMany({
    where: { isSystem: true },
    select: { id: true, code: true, name: true },
  });
  const needle = normalized.toLowerCase();
  const byCode = rows.find((c) => c.code.toLowerCase() === needle);
  if (byCode) {
    return byCode;
  }
  return rows.find((c) => c.name.toLowerCase() === needle) ?? null;
}

/** Liste système (code + nom) — pour le prompt (le modèle ne voit jamais d'uuid). */
export async function listCategoryRefs(): Promise<{ code: string; name: string }[]> {
  const rows = await prisma.category.findMany({
    where: { isSystem: true },
    select: { code: true, name: true },
    orderBy: { name: 'asc' },
  });
  return rows;
}

/** Schémas d'arguments réutilisés. */
const limitSchema = z.coerce.number().int().min(1).max(10).default(5);
const monthOptSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Invalid month. Expected YYYY-MM.')
  .optional();

export const tools: AssistantTool[] = [
  {
    name: 'get_accounts_summary',
    description:
      "Soldes courants de tous les comptes (types: BANK, MVOLA, ORANGE_MONEY, AIRTEL_MONEY, CASH, SAVINGS), Total disponible (épargne EXCLUE) et devise. Aucun argument.",
    argsSchema: z.object({}),
    handler: async (ctx) => {
      const dashboard = await getDashboard(ctx.userId);
      return {
        currency: dashboard.currency,
        accounts: dashboard.accounts.map((account) => ({
          type: account.type,
          label: ACCOUNT_LABELS[account.type as AccountType],
          balance: money(account.balance),
        })),
        totalAvailable: money(dashboard.totalAvailable),
        note: 'Le Total disponible exclut toujours l’épargne.',
      };
    },
  },
  {
    name: 'get_categories',
    description:
      "Catégories de dépense disponibles (code stable + libellé). Utilise le code ou le libellé comme categoryRef. Aucun argument.",
    argsSchema: z.object({}),
    handler: async () => ({ categories: await listCategoryRefs() }),
  },
  {
    name: 'list_transactions',
    description:
      "Transactions ACTIVES du journal. Filtres facultatifs : type (EXPENSE/INCOME), month (YYYY-MM), categoryRef (code/libellé), amountMin/amountMax, descriptionSubstring. Renvoie agrégats + échantillon limité AVEC ids (cibles de modification/suppression).",
    argsSchema: z.object({
      type: z.enum(['EXPENSE', 'INCOME']).optional(),
      month: monthOptSchema,
      categoryRef: z.string().trim().min(1).max(60).optional(),
      amountMin: z.string().regex(/^\d+(\.\d{1,2})?$/, 'amountMin must be a non-negative decimal.').optional(),
      amountMax: z.string().regex(/^\d+(\.\d{1,2})?$/, 'amountMax must be a non-negative decimal.').optional(),
      descriptionSubstring: z.string().trim().min(1).max(80).optional(),
      limit: limitSchema,
    }),
    handler: async (ctx, raw) => {
      const args = raw as {
        type?: 'EXPENSE' | 'INCOME';
        month?: string;
        categoryRef?: string;
        amountMin?: string;
        amountMax?: string;
        descriptionSubstring?: string;
        limit: number;
      };
      const where: Record<string, unknown> = { userId: ctx.userId, deletedAt: null };
      if (args.type) where.type = args.type;
      if (args.categoryRef) {
        const category = await findCategoryIdByRef(args.categoryRef);
        if (!category) {
          return { error: `Catégorie inconnue : ${args.categoryRef}.`, count: 0, totalAmount: '0', sample: [] };
        }
        where.categoryId = category.id;
      }
      if (args.month) where.occurredAt = monthBounds(args.month);
      if (args.amountMin !== undefined || args.amountMax !== undefined) {
        where.amount = {
          ...(args.amountMin ? { gte: args.amountMin } : {}),
          ...(args.amountMax ? { lte: args.amountMax } : {}),
        };
      }
      if (args.descriptionSubstring) {
        where.description = { contains: args.descriptionSubstring, mode: 'insensitive' };
      }

      const [rows, aggregate] = await Promise.all([
        prisma.transaction.findMany({
          where,
          include: {
            category: { select: { code: true, name: true } },
            allocations: { include: { account: { select: { type: true } } } },
          },
          orderBy: [{ occurredAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
          take: args.limit,
        }),
        prisma.transaction.aggregate({ where, _sum: { amount: true }, _count: true }),
      ]);

      const sample = rows.map((row) => ({
        id: row.id,
        type: row.type,
        amount: money(row.amount),
        occurredAt: row.occurredAt ? row.occurredAt.toISOString().slice(0, 10) : null,
        dateUnknown: row.occurredAt === null,
        accountUnknown: row.accountUnknown,
        category: row.category ? row.category.name : row.categoryUnknown ? 'Inconnue' : null,
        description: row.description,
        accounts: row.allocations.length ? row.allocations.map((a) => a.account.type) : [],
      }));
      return { count: aggregate._count, totalAmount: aggregate._sum.amount ? money(aggregate._sum.amount) : '0', sample };
    },
  },

  {
    name: 'get_planned_expenses',
    description:
      "Dépenses futures/récurrentes. Filtres facultatifs : status (PENDING/PAID/CANCELED/SKIPPED), limit. Renvoie échantillon avec ids + totaux PENDING (dont en retard par rapport à aujourd'hui).",
    argsSchema: z.object({ status: z.enum(['PENDING', 'PAID', 'CANCELED', 'SKIPPED']).optional(), limit: limitSchema }),
    handler: async (ctx, raw) => {
      const args = raw as { status?: 'PENDING' | 'PAID' | 'CANCELED' | 'SKIPPED'; limit: number };
      const where: Record<string, unknown> = { userId: ctx.userId };
      if (args.status) where.status = args.status;
      const [rows, pendingAggregate, overdueRows] = await Promise.all([
        prisma.plannedExpense.findMany({
          where,
          include: { category: { select: { name: true } } },
          orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
          take: args.limit,
        }),
        prisma.plannedExpense.aggregate({
          where: { userId: ctx.userId, status: 'PENDING' },
          _sum: { amount: true },
          _count: true,
        }),
        prisma.plannedExpense.findMany({
          where: { userId: ctx.userId, status: 'PENDING', dueDate: { lt: new Date(`${ctx.today}T00:00:00.000Z`) } },
          select: { amount: true },
        }),
      ]);
      const overdueTotal = overdueRows.reduce((sum, row) => sum + Number(money(row.amount)), 0);
      return {
        today: ctx.today,
        pendingCount: pendingAggregate._count,
        pendingTotal: pendingAggregate._sum.amount ? money(pendingAggregate._sum.amount) : '0',
        overdueCount: overdueRows.length,
        overdueTotal: String(overdueTotal),
        sample: rows.map((row) => ({
          id: row.id,
          amount: money(row.amount),
          dueDate: row.dueDate.toISOString().slice(0, 10),
          status: row.status,
          category: row.category ? row.category.name : row.categoryUnknown ? 'Inconnue' : null,
          description: row.description,
        })),
      };
    },
  },
  {
    name: 'get_expected_incomes',
    description:
      "Revenus futurs attendus. Filtres facultatifs : certainty (CONFIRMED/UNCERTAIN), status (PENDING/RECEIVED/CANCELED), limit. Renvoie ids, certitude, statut, fenêtre temporelle et totaux PENDING CONFIRMED / UNCERTAIN séparés.",
    argsSchema: z.object({
      certainty: z.enum(['CONFIRMED', 'UNCERTAIN']).optional(),
      status: z.enum(['PENDING', 'RECEIVED', 'CANCELED']).optional(),
      limit: limitSchema,
    }),
    handler: async (ctx, raw) => {
      const args = raw as { certainty?: 'CONFIRMED' | 'UNCERTAIN'; status?: 'PENDING' | 'RECEIVED' | 'CANCELED'; limit: number };
      const where: Record<string, unknown> = { userId: ctx.userId };
      if (args.certainty) where.certainty = args.certainty;
      if (args.status) where.status = args.status;
      const [rows, confirmed, uncertain] = await Promise.all([
        prisma.expectedIncome.findMany({
          where,
          orderBy: [{ expectedDate: 'asc' }, { createdAt: 'asc' }],
          take: args.limit,
        }),
        prisma.expectedIncome.aggregate({
          where: { userId: ctx.userId, status: 'PENDING', certainty: 'CONFIRMED' },
          _sum: { amount: true },
        }),
        prisma.expectedIncome.aggregate({
          where: { userId: ctx.userId, status: 'PENDING', certainty: 'UNCERTAIN' },
          _sum: { amount: true },
        }),
      ]);
      return {
        today: ctx.today,
        confirmedPendingTotal: confirmed._sum.amount ? money(confirmed._sum.amount) : '0',
        uncertainPendingTotal: uncertain._sum.amount ? money(uncertain._sum.amount) : '0',
        note: 'Les revenus UNCERTAIN ne sont JAMAIS garantis et n’entrent jamais dans le calcul principal.',
        sample: rows.map((row) => ({
          id: row.id,
          amount: money(row.amount),
          certainty: row.certainty,
          status: row.status,
          expectedDate: row.expectedDate ? row.expectedDate.toISOString().slice(0, 10) : null,
          windowStart: row.windowStart ? row.windowStart.toISOString().slice(0, 10) : null,
          windowEnd: row.windowEnd ? row.windowEnd.toISOString().slice(0, 10) : null,
          description: row.description,
        })),
      };
    },
  },
  {
    name: 'get_budget_summary',
    description:
      "Budget(s) d'un mois (YYYY-MM, défaut mois courant) : dépensé réel, prévision, budget global et budgets par catégorie (status VERT/DEPASSE). Read-only.",
    argsSchema: z.object({ month: monthOptSchema }),
    handler: async (ctx, raw) => {
      const args = raw as { month?: string };
      const view = await getMonthlyBudgets(ctx.userId, args.month ?? ctx.monthKey, ctx.today);
      return {
        month: view.month,
        currency: view.currency,
        spent: view.spent,
        spendingForecast: view.spendingForecast,
        globalBudget: view.globalBudget,
        categoryBudgets: view.categoryBudgets.map((b) => ({
          category: b.category.name,
          amount: b.amount,
          spent: b.spent,
          remaining: b.remaining,
          status: b.status,
          id: b.id,
        })),
      };
    },
  },
  {
    name: 'get_financial_forecast',
    description:
      "Prévision financière de fin de mois (mois courant) : availableToday, dépenses prévues restantes, revenus CONFIRMÉS attendus, revenus INCERTAINS (séparés, jamais garantis), monthEndAvailableForecast (peut être négatif). Utilise pour les questions d'achat/affordability.",
    argsSchema: z.object({}),
    handler: async (ctx) => getMonthEndFinancialForecast(ctx.userId, ctx.today),
  },

  {
    name: 'get_savings_summary',
    description:
      "Épargne d'un mois (YYYY-MM, défaut mois courant) : solde du compte Épargne, plan ACTIF éventuel (id/month/mode/cible), contribution dérivée, restant, progression. Le plan n'est JAMAIS de l'argent.",
    argsSchema: z.object({ month: monthOptSchema }),
    handler: async (ctx, raw) => {
      const args = raw as { month?: string };
      const monthKey = args.month ?? ctx.monthKey;
      const [user, dashboard, plan] = await Promise.all([
        prisma.user.findUnique({ where: { id: ctx.userId }, select: { currency: true } }),
        getDashboard(ctx.userId),
        prisma.monthlySavingsPlan.findFirst({
          where: { userId: ctx.userId, month: monthKey, deletedAt: null },
          include: { contributions: { include: { transfer: { select: { id: true, amount: true, deletedAt: true } } } } },
        }),
      ]);
      const savingsAccount = dashboard.accounts.find((a) => a.type === 'SAVINGS');
      if (!plan) {
        return {
          month: monthKey,
          currency: user?.currency ?? 'MGA',
          savingsAccount: savingsAccount ? { id: savingsAccount.id, balance: savingsAccount.balance } : null,
          plan: null,
          note: 'Aucun plan actif pour ce mois. Créer un plan ne déplace aucun argent.',
        };
      }
      const active = plan.contributions.filter((c) => c.transfer.deletedAt === null);
      const contributed = active.reduce((sum, c) => sum + Number(c.transfer.amount.toString()), 0);
      const target = plan.mode === 'FIXED' ? plan.fixedAmount?.toString() ?? null : null;
      return {
        month: monthKey,
        currency: user?.currency ?? 'MGA',
        savingsAccount: savingsAccount ? { id: savingsAccount.id, balance: savingsAccount.balance } : null,
        plan: {
          id: plan.id,
          mode: plan.mode,
          fixedAmount: plan.fixedAmount?.toString() ?? null,
          percentage: plan.percentage?.toString() ?? null,
        },
        target,
        contributed: String(contributed),
        remaining: target !== null ? String(Number(target) - contributed) : null,
        contributionsCount: active.length,
      };
    },
  },
  {
    name: 'get_debts_summary',
    description:
      "Dettes/créances actives : direction (I_OWE = je dois / OWED_TO_ME = on me doit), kind (STANDARD ou avance EXPLICITE), restant dérivé, échéance, statut temporel. Renvoie ids (cibles de règlement).",
    argsSchema: z.object({ direction: z.enum(['I_OWE', 'OWED_TO_ME']).optional() }),
    handler: async (ctx, raw) => {
      const args = raw as { direction?: 'I_OWE' | 'OWED_TO_ME' };
      const rows = await prisma.debt.findMany({
        where: { userId: ctx.userId, deletedAt: null, ...(args.direction ? { direction: args.direction } : {}) },
        include: { settlements: { where: { deletedAt: null }, select: { amount: true } } },
        orderBy: { createdAt: 'desc' },
      });
      const debts = rows.map((debt) => {
        const settled = debt.settlements.reduce((sum, s) => sum + Number(s.amount.toString()), 0);
        const remaining = Math.max(0, Number(debt.originalAmount.toString()) - settled);
        const dueDate = debt.dueDate ? debt.dueDate.toISOString().slice(0, 10) : null;
        const settledAmount = settled >= Number(debt.originalAmount.toString());
        const temporalStatus = settledAmount
          ? 'SETTLED'
          : dueDate && dueDate < ctx.today && !debt.dueDateUnknown
            ? 'OVERDUE'
            : 'OPEN';
        return {
          id: debt.id,
          direction: debt.direction,
          kind: debt.kind,
          originalAmount: money(debt.originalAmount),
          settledAmount: String(settled),
          remaining: String(remaining),
          counterpartyName: debt.counterpartyName,
          description: debt.description,
          dueDate,
          dueDateUnknown: debt.dueDateUnknown,
          temporalStatus,
        };
      });
      const sum = (items: typeof debts) => items.reduce((s, d) => s + Number(d.remaining), 0);
      return {
        today: ctx.today,
        debts,
        totals: {
          iOwe: String(sum(debts.filter((d) => d.direction === 'I_OWE'))),
          owedToMe: String(sum(debts.filter((d) => d.direction === 'OWED_TO_ME'))),
        },
      };
    },
  },
  {
    name: 'get_transfers_summary',
    description:
      "Transferts internes récents (source → destination, montant, frais, date, description). Aucune Transaction EXPENSE/INCOME n'est jamais impliquée.",
    argsSchema: z.object({ limit: limitSchema }),
    handler: async (ctx, raw) => {
      const args = raw as { limit: number };
      const [rows, count] = await Promise.all([
        prisma.accountTransfer.findMany({
          where: { userId: ctx.userId, deletedAt: null },
          include: {
            sourceAccount: { select: { type: true } },
            destinationAccount: { select: { type: true } },
          },
          orderBy: [{ occurredAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
          take: args.limit,
        }),
        prisma.accountTransfer.count({ where: { userId: ctx.userId, deletedAt: null } }),
      ]);
      return {
        count,
        sample: rows.map((row) => ({
          id: row.id,
          source: row.sourceAccount.type,
          destination: row.destinationAccount.type,
          amount: money(row.amount),
          feeAmount: money(row.feeAmount),
          occurredAt: row.occurredAt ? row.occurredAt.toISOString().slice(0, 10) : null,
          dateUnknown: row.dateUnknown,
          description: row.description,
        })),
      };
    },
  },
  {
    name: 'get_notifications_summary',
    description:
      "Notifications du centre interne (rappel à vérifier). Lire via cet outil ne marque RIEN comme lu et ne déclenche aucune écriture.",
    argsSchema: z.object({ unreadOnly: z.boolean().optional(), limit: limitSchema }),
    handler: async (ctx, raw) => {
      const args = raw as { unreadOnly?: boolean; limit: number };
      const rows = await prisma.appNotification.findMany({
        where: { userId: ctx.userId, ...(args.unreadOnly ? { isRead: false } : {}) },
        orderBy: { createdAt: 'desc' },
        take: args.limit,
        select: { id: true, type: true, title: true, body: true, isRead: true, localDate: true, route: true },
      });
      return {
        today: ctx.today,
        sample: rows.map((row) => ({
          id: row.id,
          type: row.type,
          title: row.title,
          body: row.body,
          isRead: row.isRead,
          localDate: row.localDate.toISOString().slice(0, 10),
          route: row.route,
        })),
      };
    },
  },
];




