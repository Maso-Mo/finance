import { prisma } from '../db.js';
import { ApiError } from '../http-error.js';
import { assertSystemCategory } from '../categories/categories.service.js';
import { dateInputToDate, dbDateToISO, todayLocalISO } from '../dates.js';
import { syncRuleOccurrences } from './occurrences.service.js';
import type {
  Currency,
  RecurringExpenseCreate,
  RecurringExpensePublic,
  RecurringExpensesResponse,
  RecurringExpenseUpdate,
} from '@finance/shared-types';

/**
 * Service des DÉPENSES MENSUELLES RÉCURRENTES (V1 : mensuel uniquement).
 *
 * La règle n'est PAS une dépense : elle décrit « Internet — 80 000 Ar tous les
 * 5 du mois » et génère des occurrences (PlannedExpense) via occurrences.service.
 * Une modification n'affecte que les occurrences FUTURES non résolues : une
 * occurrence PAID / SKIPPED / CANCELED n'est jamais réécrite.
 */

const categorySelect = { id: true, name: true } as const;

type RuleRow = {
  id: string;
  userId: string;
  amount: { toString(): string };
  currency: string;
  dayOfMonth: number;
  categoryId: string | null;
  categoryUnknown: boolean;
  description: string | null;
  startDate: Date;
  endDate: Date | null;
  isActive: boolean;
  category: { id: string; name: string } | null;
  createdAt: Date;
  updatedAt: Date;
};

function toPublic(
  row: RuleRow,
  pendingOccurrences: number,
): RecurringExpensePublic {
  return {
    id: row.id,
    amount: row.amount.toString(),
    currency: row.currency as Currency,
    dayOfMonth: row.dayOfMonth,
    description: row.description,
    category: row.category,
    categoryUnknown: row.categoryUnknown,
    startDate: dbDateToISO(row.startDate),
    endDate: row.endDate ? dbDateToISO(row.endDate) : null,
    isActive: row.isActive,
    pendingOccurrences,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizedDescription(value: string | null | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

async function pendingCountByRule(userId: string): Promise<Map<string, number>> {
  const groups = await prisma.plannedExpense.groupBy({
    by: ['recurringRuleId'],
    where: {
      userId,
      recurringRuleId: { not: null },
      status: 'PENDING',
    },
    _count: { _all: true },
  });
  return new Map(
    groups.map((g) => [g.recurringRuleId as string, g._count._all]),
  );
}

export async function listRecurringExpenses(
  userId: string,
): Promise<RecurringExpensesResponse> {
  const [rows, pendingCounts] = await Promise.all([
    prisma.recurringExpenseRule.findMany({
      where: { userId },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
      include: { category: { select: categorySelect } },
    }),
    pendingCountByRule(userId),
  ]);
  return {
    recurringExpenses: rows.map((row) =>
      toPublic(row as unknown as RuleRow, pendingCounts.get(row.id) ?? 0),
    ),
  };
}


export async function createRecurringExpense(
  userId: string,
  input: RecurringExpenseCreate,
): Promise<RecurringExpensePublic> {
  await assertSystemCategory(input.categoryId);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currency: true },
  });
  if (!user) {
    throw new ApiError(401, 'User not found.');
  }

  const endDate = input.endDate ? dateInputToDate(input.endDate) : null;
  const rule = await prisma.$transaction(async (tx) => {
    const created = await tx.recurringExpenseRule.create({
      data: {
        userId,
        currency: user.currency as Currency,
        amount: input.amount,
        dayOfMonth: input.dayOfMonth,
        categoryId: input.categoryId ?? null,
        categoryUnknown: input.categoryUnknown === true,
        description: normalizedDescription(input.description),
        startDate: dateInputToDate(input.startDate),
        endDate,
      },
    });
    await syncRuleOccurrences(tx, created, todayLocalISO());
    return created;
  });

  const row = await prisma.recurringExpenseRule.findUniqueOrThrow({
    where: { id: rule.id },
    include: { category: { select: categorySelect } },
  });
  const pending = await prisma.plannedExpense.count({
    where: { recurringRuleId: rule.id, status: 'PENDING' },
  });
  return toPublic(row as unknown as RuleRow, pending);
}

/**
 * Modifie une règle. Les occurrences PENDING sont resynchronisées proprement
 * (montant/jour/catégorie) dans la même transaction ; les occurrences résolues
 * (PAID / SKIPPED / CANCELED) restent INTACTES. Désactivation ⇒ plus aucune
 * génération et annulation propre des PENDING futures.
 */
export async function updateRecurringExpense(
  userId: string,
  ruleId: string,
  input: RecurringExpenseUpdate,
): Promise<RecurringExpensePublic> {
  const existing = await prisma.recurringExpenseRule.findFirst({
    where: { id: ruleId, userId },
    include: { category: { select: categorySelect } },
  });
  if (!existing) {
    // Ni trouvée ni autorisée : réponse générique.
    throw new ApiError(404, 'Recurring expense not found.');
  }
  if (input.categoryId !== undefined) {
    await assertSystemCategory(input.categoryId);
  }

  // Catégorie « inconnue » explicite ⇒ on efface toute catégorie connue.
  const categoryUnknown =
    input.categoryUnknown !== undefined
      ? input.categoryUnknown
      : input.categoryId !== undefined
        ? false
        : existing.categoryUnknown;
  const categoryId =
    categoryUnknown || input.categoryId === undefined
      ? input.categoryId !== undefined
        ? null
        : existing.categoryId
      : input.categoryId;

  const startDate = input.startDate
    ? dateInputToDate(input.startDate)
    : existing.startDate;
  const endDate =
    input.endDate !== undefined
      ? input.endDate
        ? dateInputToDate(input.endDate)
        : null
      : existing.endDate;
  if (endDate && endDate.getTime() < startDate.getTime()) {
    throw new ApiError(400, 'endDate must not be before startDate.');
  }

  const isActive = input.isActive ?? existing.isActive;

  await prisma.$transaction(async (tx) => {
    const rule = await tx.recurringExpenseRule.update({
      where: { id: ruleId },
      data: {
        amount: input.amount ?? existing.amount,
        dayOfMonth: input.dayOfMonth ?? existing.dayOfMonth,
        categoryId,
        categoryUnknown,
        description:
          input.description !== undefined
            ? normalizedDescription(input.description)
            : existing.description,
        startDate,
        endDate,
        isActive,
      },
    });
    if (isActive) {
      await syncRuleOccurrences(tx, rule, todayLocalISO());
    } else {
      await tx.plannedExpense.updateMany({
        where: { recurringRuleId: ruleId, status: 'PENDING' },
        data: { status: 'CANCELED' },
      });
    }
    return rule;
  });

  const row = await prisma.recurringExpenseRule.findUniqueOrThrow({
    where: { id: ruleId },
    include: { category: { select: categorySelect } },
  });
  const pending = await prisma.plannedExpense.count({
    where: { recurringRuleId: ruleId, status: 'PENDING' },
  });
  return toPublic(row as unknown as RuleRow, pending);
}

/**
 * « Désactiver / supprimer » une récurrence : on n'efface PAS l'historique
 * (occurrences PAID/SKIPPED/CANCELED conservées). La règle passe isActive=false
 * et ses occurrences PENDING restantes sont annulées proprement.
 */
export async function deactivateRecurringExpense(
  userId: string,
  ruleId: string,
): Promise<void> {
  const existing = await prisma.recurringExpenseRule.findFirst({
    where: { id: ruleId, userId },
    select: { id: true },
  });
  if (!existing) {
    throw new ApiError(404, 'Recurring expense not found.');
  }
  await prisma.$transaction([
    prisma.recurringExpenseRule.update({
      where: { id: ruleId },
      data: { isActive: false },
    }),
    prisma.plannedExpense.updateMany({
      where: { recurringRuleId: ruleId, status: 'PENDING' },
      data: { status: 'CANCELED' },
    }),
  ]);
}

