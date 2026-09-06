import { prisma } from '../db.js';
import { ApiError } from '../http-error.js';
import { todayLocalISO } from '../dates.js';
import {
  addMonths,
  budgetRemaining,
  budgetStatus,
  keyToMonth,
  spendingForecast,
  monthToKey,
  monthlySpent,
  spentByCategory,
} from '@finance/finance-core';
import type {
  Currency,
  GlobalBudgetLine,
  CategoryBudgetLine,
  MonthlyBudgetCreate,
  MonthlyBudgetPublic,
  MonthlyBudgetsResponse,
  MonthlyBudgetUpdate,
} from '@finance/shared-types';
import { assertSystemCategory } from '../categories/categories.service.js';
import { Prisma } from '../generated/prisma/client.js';

/**
 * Service des BUDGETS MENSUELS (étape 8).
 *
 * ⚠ RÈGLE ABSOLUE : un budget n'est PAS de l'argent.
 *  - il ne crée ni ne modifie JAMAIS une Transaction, un compte, un solde ou
 *    le Total disponible (aucune écriture hors de la table monthly_budgets) ;
 *  - le « dépensé » est TOUJOURS DÉRIVÉ en lecture du journal réel
 *    (Transactions EXPENSE actives du mois, source de vérité = étape 5) ;
 *  - le GET analytique est STRICTEMENT read-only.
 *
 * Unicité (défendue aussi au niveau base par index partiels) :
 *  - un budget GLOBAL maximum par (userId, month) ;
 *  - un budget par (userId, month, catégorie) maximum.
 */

type BudgetRow = {
  id: string;
  month: string;
  amount: { toString(): string };
  currency: string;
  categoryId: string | null;
  createdAt: Date;
  updatedAt: Date;
  category: { id: string; name: string } | null;
};

/** Ligne du journal réel considérée par les budgets (EXPENSE active). */
type ExpenseRow = {
  type: 'EXPENSE';
  amount: { toString(): string };
  categoryId: string | null;
};

export function toPublicBudget(row: BudgetRow): MonthlyBudgetPublic {
  return {
    id: row.id,
    month: row.month,
    amount: row.amount.toString(),
    currency: row.currency as Currency,
    category: row.category
      ? { id: row.category.id, name: row.category.name }
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Borne calendaire [début de mois, début du mois suivant) en UTC. */
function monthBoundaries(monthKey: string): { start: Date; end: Date } {
  const yearMonth = keyToMonth(monthKey);
  const next = addMonths(yearMonth, 1);
  return {
    start: new Date(`${monthKey}-01T00:00:00.000Z`),
    end: new Date(`${monthToKey(next)}-01T00:00:00.000Z`),
  };
}

/**
 * Dépenses RÉELLES du mois : Transactions EXPENSE ACTIVES (`deletedAt` null,
 * `occurredAt` dans le mois). Les revenus, dépenses planifiées PENDING et
 * revenus futurs PENDING ne sont jamais des dépenses réelles ici.
 */
async function monthExpenseRows(
  userId: string,
  monthKey: string,
): Promise<ExpenseRow[]> {
  const { start, end } = monthBoundaries(monthKey);
  const rows = await prisma.transaction.findMany({
    where: {
      userId,
      type: 'EXPENSE',
      deletedAt: null,
      occurredAt: { gte: start, lt: end },
    },
    select: { amount: true, categoryId: true },
    orderBy: { occurredAt: 'asc' },
  });
  return rows.map((row) => ({
    type: 'EXPENSE' as const,
    amount: row.amount,
    categoryId: row.categoryId,
  }));
}

/**
 * Vue analytique d'un mois (GET read-only). `today` (YYYY-MM-DD) est le jour
 * LOCAL du frontend, base de la prévision ; il ne modifie AUCUNE donnée.
 */
export async function getMonthlyBudgets(
  userId: string,
  monthKey: string,
  today?: string,
): Promise<MonthlyBudgetsResponse> {
  const referenceToday = today ?? todayLocalISO();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currency: true },
  });
  if (!user) {
    throw new ApiError(401, 'User not found.');
  }

  const rows = await prisma.monthlyBudget.findMany({
    where: { userId, month: monthKey },
    include: { category: { select: { id: true, name: true } } },
    orderBy: [{ categoryId: 'asc' }, { createdAt: 'asc' }],
  });

  const entries = await monthExpenseRows(userId, monthKey);
  const spentTotal = monthlySpent(entries);
  const spendingForecastTotal = spendingForecast(
    monthKey,
    referenceToday,
    spentTotal,
  );

  let globalBudget: GlobalBudgetLine | null = null;
  const categoryBudgets: CategoryBudgetLine[] = [];
  for (const row of rows) {
    const currency = row.currency as Currency;
    if (!row.categoryId || !row.category) {
      globalBudget = {
        id: row.id,
        month: row.month,
        amount: row.amount.toString(),
        currency,
        remaining: budgetRemaining(row.amount, spentTotal).toString(),
        status: budgetStatus(spentTotal, row.amount),
        spendingForecast: spendingForecastTotal.toString(),
      };
      continue;
    }
    const spentCategory = spentByCategory(entries, row.categoryId);
    categoryBudgets.push({
      id: row.id,
      month: row.month,
      amount: row.amount.toString(),
      currency,
      category: { id: row.category.id, name: row.category.name },
      spent: spentCategory.toString(),
      remaining: budgetRemaining(row.amount, spentCategory).toString(),
      status: budgetStatus(spentCategory, row.amount),
      spendingForecast: spendingForecast(monthKey, referenceToday, spentCategory).toString(),
    });
  }

  return {
    month: monthKey,
    today: referenceToday,
    currency: user.currency as Currency,
    spent: spentTotal.toString(),
    spendingForecast: spendingForecastTotal.toString(),
    globalBudget,
    categoryBudgets,
  };
}

/**
 * Vérifie l'absence de doublon (global OU catégorie) avant création. La
 * garantie DÉFINITIVE reste l'index unique partiel en base (cas de concurrence).
 */
async function assertNoDuplicate(
  userId: string,
  monthKey: string,
  categoryId: string | null,
): Promise<void> {
  const existing = await prisma.monthlyBudget.findFirst({
    where: { userId, month: monthKey, categoryId },
    select: { id: true },
  });
  if (existing) {
    throw new ApiError(
      409,
      categoryId
        ? 'A budget for this category already exists for this month.'
        : 'A global budget already exists for this month.',
    );
  }
}

/**
 * Crée un budget (global si `categoryId` absent, sinon budget de catégorie).
 * La devise est celle de l'utilisateur — jamais choisie ici. Aucun impact sur
 * le ledger : seule la table monthly_budgets est écrite.
 */
export async function createMonthlyBudget(
  userId: string,
  input: MonthlyBudgetCreate,
): Promise<MonthlyBudgetPublic> {
  const categoryId = input.categoryId ?? null;
  await assertSystemCategory(categoryId);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currency: true },
  });
  if (!user) {
    throw new ApiError(401, 'User not found.');
  }
  await assertNoDuplicate(userId, input.month, categoryId);

  try {
    const row = await prisma.monthlyBudget.create({
      data: {
        userId,
        month: input.month,
        amount: input.amount,
        currency: user.currency as Currency,
        categoryId,
      },
      include: { category: { select: { id: true, name: true } } },
    });
    return toPublicBudget(row as unknown as BudgetRow);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ApiError(
        409,
        categoryId
          ? 'A budget for this category already exists for this month.'
          : 'A global budget already exists for this month.',
      );
    }
    throw error;
  }
}

/** Modifie UNIQUEMENT la limite d'un budget existant (ownership requis). */
export async function updateMonthlyBudgetAmount(
  userId: string,
  budgetId: string,
  input: MonthlyBudgetUpdate,
): Promise<MonthlyBudgetPublic> {
  const result = await prisma.monthlyBudget.updateMany({
    where: { id: budgetId, userId },
    data: { amount: input.amount },
  });
  if (result.count === 0) {
    throw new ApiError(404, 'Budget not found.');
  }
  const row = await prisma.monthlyBudget.findUniqueOrThrow({
    where: { id: budgetId },
    include: { category: { select: { id: true, name: true } } },
  });
  return toPublicBudget(row as unknown as BudgetRow);
}

/** Supprime un budget (jamais une Transaction). Ownership requis. */
export async function deleteMonthlyBudget(
  userId: string,
  budgetId: string,
): Promise<void> {
  const result = await prisma.monthlyBudget.deleteMany({
    where: { id: budgetId, userId },
  });
  if (result.count === 0) {
    throw new ApiError(404, 'Budget not found.');
  }
}
