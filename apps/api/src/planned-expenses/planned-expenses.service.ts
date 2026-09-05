import { prisma } from '../db.js';
import { ApiError } from '../http-error.js';
import { assertSystemCategory } from '../categories/categories.service.js';
import { dateInputToDate, dbDateToISO, todayLocalISO } from '../dates.js';
import { classifyPlannedReminder } from '@finance/finance-core';
import { createTransactionRecord } from '../transactions/transactions.service.js';
import { ensureOccurrencesForUser } from '../recurring-expenses/occurrences.service.js';
import type {
  Currency,
  PlannedExpenseConfirmPaid,
  PlannedExpenseCreate,
  PlannedExpensePublic,
  PlannedExpensesResponse,
  PlannedExpenseUpdate,
  TransactionPublic,
  TransactionUpsert,
} from '@finance/shared-types';

/**
 * Service des DÉPENSES FUTURES (étape 6) : ponctuelles et occurrences
 * récurrentes.
 *
 * ⚠ RÈGLE ABSOLUE : PENDING ≠ dépense réelle. Une dépense planifiée n'entre
 * dans AUCUN solde ni total tant qu'elle n'est pas confirmée (« Oui, payé »),
 * opération ATOMIQUE qui crée la vraie Transaction EXPENSE du journal existant
 * (étape 5) — jamais un second système de transactions.
 */

const includeCategory = { category: { select: { id: true, name: true } } };

type PlannedRow = {
  id: string;
  userId: string;
  amount: { toString(): string };
  currency: string;
  dueDate: Date;
  description: string | null;
  category: { id: string; name: string } | null;
  categoryUnknown: boolean;
  status: string;
  recurringRuleId: string | null;
  confirmedTransactionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Sérialisation publique d'une dépense planifiée (bucket dérivé). */
export function toPlannedPublic(
  row: PlannedRow,
  today?: string,
): PlannedExpensePublic {
  const dueDate = dbDateToISO(row.dueDate);
  const bucket = classifyPlannedReminder(
    dueDate,
    today ?? todayLocalISO(),
    row.status,
  );
  return {
    id: row.id,
    amount: row.amount.toString(),
    currency: row.currency as Currency,
    dueDate,
    description: row.description,
    category: row.category,
    categoryUnknown: row.categoryUnknown,
    status: row.status as PlannedExpensePublic['status'],
    recurringRuleId: row.recurringRuleId,
    confirmedTransactionId: row.confirmedTransactionId,
    bucket,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizedDescription(value: string | null | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

/** Jour de référence de maintenance AVANT lecture (rattrapage idempotent). */
export async function listPlannedExpenses(
  userId: string,
  today?: string,
): Promise<PlannedExpensesResponse> {
  // L'application reste correcte même si le cron n'a pas tourné depuis
  // plusieurs jours : la lecture rattrape les occurrences manquantes.
  await ensureOccurrencesForUser(userId, today);

  const rows = await prisma.plannedExpense.findMany({
    where: { userId },
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    include: includeCategory,
  });
  return { plannedExpenses: rows.map((row) => toPlannedPublic(row as PlannedRow, today)) };
}

/** Crée une dépense future PONCTUELLE (aucun compte, aucun impact solde). */
export async function createPlannedExpense(
  userId: string,
  input: PlannedExpenseCreate,
): Promise<PlannedExpensePublic> {
  await assertSystemCategory(input.categoryId);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currency: true },
  });
  if (!user) {
    throw new ApiError(401, 'User not found.');
  }

  const created = await prisma.plannedExpense.create({
    data: {
      userId,
      currency: user.currency as Currency,
      amount: input.amount,
      dueDate: dateInputToDate(input.dueDate),
      description: normalizedDescription(input.description),
      categoryId: input.categoryId ?? null,
      categoryUnknown: input.categoryUnknown === true,
    },
    include: includeCategory,
  });
  return toPlannedPublic(created as PlannedRow);
}

/**
 * Modifie une dépense planifiée PENDING (ponctuelle ou occurrence). Une
 * dépense déjà PAID / CANCELED / SKIPPED ne se modifie pas.
 */
export async function updatePlannedExpense(
  userId: string,
  plannedExpenseId: string,
  input: PlannedExpenseUpdate,
): Promise<PlannedExpensePublic> {
  const existing = await prisma.plannedExpense.findFirst({
    where: { id: plannedExpenseId, userId },
    select: { id: true, status: true },
  });
  if (!existing) {
    throw new ApiError(404, 'Planned expense not found.');
  }
  if (existing.status !== 'PENDING') {
    throw new ApiError(
      409,
      'A resolved planned expense cannot be modified (status: ' +
        existing.status +
        ').',
    );
  }
  if (input.categoryId !== undefined) {
    await assertSystemCategory(input.categoryId);
  }

  const data: {
    amount?: string;
    dueDate?: Date;
    description?: string | null;
    categoryId?: string | null;
    categoryUnknown?: boolean;
  } = {};
  if (input.amount !== undefined) {
    data.amount = input.amount;
  }
  if (input.dueDate !== undefined) {
    data.dueDate = dateInputToDate(input.dueDate);
  }
  if (input.description !== undefined) {
    data.description = normalizedDescription(input.description);
  }
  if (input.categoryUnknown === true) {
    data.categoryId = null;
    data.categoryUnknown = true;
  } else if (input.categoryId !== undefined) {
    data.categoryId = input.categoryId;
    data.categoryUnknown = false;
  }

  const result = await prisma.plannedExpense.updateMany({
    where: { id: plannedExpenseId, userId, status: 'PENDING' },
    data,
  });
  if (result.count === 0) {
    // Concurrence : confirmé/annulé entre la lecture et l'écriture.
    throw new ApiError(409, 'This planned expense is no longer pending.');
  }

  const row = await prisma.plannedExpense.findUniqueOrThrow({
    where: { id: plannedExpenseId },
    include: includeCategory,
  });
  return toPlannedPublic(row as PlannedRow);
}

/** Forme « TransactionUpsert » construite depuis le corps de confirmation. */
function toRealTransactionInput(
  body: PlannedExpenseConfirmPaid,
): TransactionUpsert {
  if (body.dateUnknown !== true && !body.occurredAt) {
    throw new ApiError(
      400,
      'Provide occurredAt or set dateUnknown: true.',
    );
  }
  if (body.categoryUnknown !== true && !body.categoryId) {
    throw new ApiError(
      400,
      'Provide categoryId or set categoryUnknown: true.',
    );
  }
  const input: TransactionUpsert = { type: 'EXPENSE', amount: body.amount };
  if (body.description) {
    input.description = body.description;
  }
  if (body.dateUnknown === true) {
    input.dateUnknown = true;
  } else {
    input.occurredAt = body.occurredAt;
  }
  if (body.accountUnknown === true) {
    input.accountUnknown = true;
  } else {
    input.allocations = body.allocations ?? [];
  }
  if (body.categoryUnknown === true) {
    input.categoryUnknown = true;
  } else {
    input.categoryId = body.categoryId;
  }
  return input;
}

/**
 * CONFIRMATION « Oui, payé » — ATOMIQUE.
 *
 * Dans UNE transaction Prisma :
 *  1. vérifier ownership + statut PENDING ;
 *  2. créer la vraie Transaction EXPENSE (+ ses allocations) via le service
 *     du journal existant (étape 5) ;
 *  3. marquer la PlannedExpense PAID + mémoriser confirmedTransactionId.
 *
 * En cas d'échec, TOUT est annulé. La double confirmation / les requêtes
 * concurrentes ne peuvent jamais produire deux Transactions actives : le
 * verrouillage de ligne du updateMany conditionnel sérialise les deux
 * requêtes ; la perdante voit status ≠ PENDING et rollback intégral.
 */
export async function confirmPaidPlannedExpense(
  userId: string,
  plannedExpenseId: string,
  body: PlannedExpenseConfirmPaid,
): Promise<{ plannedExpense: PlannedExpensePublic; transaction: TransactionPublic }> {
  const transaction = await prisma.$transaction(async (tx) => {
    const planned = await tx.plannedExpense.findFirst({
      where: { id: plannedExpenseId, userId },
      select: { status: true },
    });
    if (!planned) {
      throw new ApiError(404, 'Planned expense not found.');
    }
    if (planned.status !== 'PENDING') {
      throw new ApiError(
        409,
        'This planned expense is not pending anymore (status: ' +
          planned.status +
          ').',
      );
    }

    const real = await createTransactionRecord(
      tx,
      userId,
      toRealTransactionInput(body),
    );

    const claim = await tx.plannedExpense.updateMany({
      where: {
        id: plannedExpenseId,
        userId,
        status: 'PENDING',
        confirmedTransactionId: null,
      },
      data: { status: 'PAID', confirmedTransactionId: real.id },
    });
    if (claim.count !== 1) {
      // Concurrence : une autre confirmation a gagné → rollback intégral.
      throw new ApiError(
        409,
        'This planned expense was already confirmed as paid.',
      );
    }
    return real;
  });

  const row = await prisma.plannedExpense.findUniqueOrThrow({
    where: { id: plannedExpenseId },
    include: includeCategory,
  });
  return { plannedExpense: toPlannedPublic(row as PlannedRow), transaction };
}

/**
 * Transition résolue d'une PlannedExpense :
 *  - PENDING → CANCELED  (dépense ponctuelle annulée : « n'aura pas lieu ») ;
 *  - PENDING → SKIPPED   (occurrence récurrente ignorée pour CE mois-ci).
 * PAID ne peut jamais être « annulée » silencieusement (409). Une cible déjà
 * atteinte est un no-op idempotent (double clic / retry réseau sûrs).
 */
async function resolvePlannedExpense(
  userId: string,
  plannedExpenseId: string,
  target: 'CANCELED' | 'SKIPPED',
): Promise<PlannedExpensePublic> {
  const existing = await prisma.plannedExpense.findFirst({
    where: { id: plannedExpenseId, userId },
    select: { id: true, status: true },
  });
  if (!existing) {
    throw new ApiError(404, 'Planned expense not found.');
  }
  if (existing.status === 'PAID') {
    throw new ApiError(
      409,
      'A paid planned expense cannot be canceled or skipped. Delete the linked transaction first.',
    );
  }
  if (existing.status === target) {
    // Déjà résolu dans le même sens : idempotent.
    const row = await prisma.plannedExpense.findUniqueOrThrow({
      where: { id: plannedExpenseId },
      include: includeCategory,
    });
    return toPlannedPublic(row as PlannedRow);
  }
  if (existing.status !== 'PENDING') {
    throw new ApiError(
      409,
      'Invalid transition from status ' + existing.status + '.',
    );
  }
  const result = await prisma.plannedExpense.updateMany({
    where: { id: plannedExpenseId, userId, status: 'PENDING' },
    data: { status: target },
  });
  if (result.count !== 1) {
    throw new ApiError(409, 'This planned expense is no longer pending.');
  }
  const row = await prisma.plannedExpense.findUniqueOrThrow({
    where: { id: plannedExpenseId },
    include: includeCategory,
  });
  return toPlannedPublic(row as PlannedRow);
}

/** Annulation : ponctuelle → CANCELED ; occurrence récurrente → SKIPPED. */
export async function cancelPlannedExpense(
  userId: string,
  plannedExpenseId: string,
): Promise<PlannedExpensePublic> {
  const existing = await prisma.plannedExpense.findFirst({
    where: { id: plannedExpenseId, userId },
    select: { recurringRuleId: true },
  });
  if (!existing) {
    throw new ApiError(404, 'Planned expense not found.');
  }
  const target = existing.recurringRuleId ? 'SKIPPED' : 'CANCELED';
  return resolvePlannedExpense(userId, plannedExpenseId, target);
}

/** « Ignorer cette occurrence » (réservé aux occurrences récurrentes). */
export async function skipPlannedExpense(
  userId: string,
  plannedExpenseId: string,
): Promise<PlannedExpensePublic> {
  const existing = await prisma.plannedExpense.findFirst({
    where: { id: plannedExpenseId, userId },
    select: { recurringRuleId: true, status: true },
  });
  if (!existing) {
    throw new ApiError(404, 'Planned expense not found.');
  }
  if (existing.status === 'PAID') {
    throw new ApiError(
      409,
      'A paid planned expense cannot be skipped. Delete the linked transaction first.',
    );
  }
  if (!existing.recurringRuleId) {
    throw new ApiError(
      400,
      'Only occurrences of a recurring expense can be skipped.',
    );
  }
  return resolvePlannedExpense(userId, plannedExpenseId, 'SKIPPED');
}
