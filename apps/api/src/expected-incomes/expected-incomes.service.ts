import { prisma } from '../db.js';
import { ApiError } from '../http-error.js';
import { dateInputToDate, dbDateToISO, todayLocalISO } from '../dates.js';
import {
  classifyExpectedIncomeByDate,
  classifyExpectedIncomeByWindow,
  expectedIncomeStartDate,
  expectedIncomeTimingIsValid,
} from '@finance/finance-core';
import {
  createTransactionRecord,
  includeLedger,
  toPublicTransaction,
} from '../transactions/transactions.service.js';
import type {
  Currency,
  ExpectedIncomeConfirmReceived,
  ExpectedIncomeCreate,
  ExpectedIncomePublic,
  ExpectedIncomeUpdate,
  ExpectedIncomesResponse,
  IncomeRemindersResponse,
  TransactionPublic,
  TransactionUpsert,
} from '@finance/shared-types';

/**
 * Service des REVENUS FUTURS (étape 7).
 *
 * ⚠ RÈGLE ABSOLUE : PENDING ≠ argent reçu. Un revenu futur CONFIRMED comme
 * UNCERTAIN n'entre dans AUCUN solde ni Total disponible tant qu'il n'est pas
 * confirmé (« Oui, je l'ai reçu »), opération ATOMIQUE qui crée la vraie
 * Transaction INCOME du journal existant (étape 5) — jamais un second système
 * de transactions.
 *
 * Temporellement, UNE seule forme est active (date exacte OU plage start/end) ;
 * le système n'invente jamais une date exacte dans une plage. Les GET sont
 * STRICTEMENT read-only (aucune écriture cachée).
 */

type ReceivedTransactionLike = {
  category: { id: string; name: string } | null;
  allocations: {
    amount: { toString(): string };
    account: { id: string; type: string };
  }[];
} | null;

/** Forme minimale d'une ligne ExpectedIncome (avec sa Transaction liée). */
type IncomeRowLike = {
  id: string;
  amount: { toString(): string };
  currency: string;
  certainty: string;
  status: string;
  description: string | null;
  expectedDate: Date | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  receivedTransactionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  receivedTransaction?: ReceivedTransactionLike;
};

/** Inclusion de la Transaction INCOME réelle (pour les revenus RECEIVED). */
const includeReceived = {
  receivedTransaction: { include: includeLedger },
} as const;

function normalizedDescription(value: string | null | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

/** Sérialisation publique (reminderBucket dérivé pour un PENDING). */
export function toExpectedIncomePublic(
  row: IncomeRowLike,
  today?: string,
): ExpectedIncomePublic {
  const referenceToday = today ?? todayLocalISO();
  const expectedDate = row.expectedDate ? dbDateToISO(row.expectedDate) : null;
  const windowStart = row.windowStart ? dbDateToISO(row.windowStart) : null;
  const windowEnd = row.windowEnd ? dbDateToISO(row.windowEnd) : null;

  let reminderBucket: ExpectedIncomePublic['reminderBucket'] = null;
  if (row.status === 'PENDING') {
    if (expectedDate) {
      reminderBucket = classifyExpectedIncomeByDate(
        expectedDate,
        referenceToday,
        row.status,
      );
    } else if (windowStart && windowEnd) {
      reminderBucket = classifyExpectedIncomeByWindow(
        windowStart,
        windowEnd,
        referenceToday,
        row.status,
      );
    }
  }

  return {
    id: row.id,
    amount: row.amount.toString(),
    currency: row.currency as Currency,
    certainty: row.certainty as ExpectedIncomePublic['certainty'],
    status: row.status as ExpectedIncomePublic['status'],
    description: row.description,
    expectedDate,
    windowStart,
    windowEnd,
    receivedTransactionId: row.receivedTransactionId,
    reminderBucket,
    receivedTransaction: row.receivedTransaction
      ? toPublicTransaction(
          row.receivedTransaction as unknown as Parameters<
            typeof toPublicTransaction
          >[0],
        )
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
/** Champs temporels de la forme active (exacte OU plage) → stockage DATE. */
function timingToData(input: {
  expectedDate?: string;
  windowStart?: string;
  windowEnd?: string;
}): {
  expectedDate: Date | null;
  windowStart: Date | null;
  windowEnd: Date | null;
} {
  if (input.expectedDate !== undefined) {
    return {
      expectedDate: dateInputToDate(input.expectedDate),
      windowStart: null,
      windowEnd: null,
    };
  }
  return {
    expectedDate: null,
    windowStart: input.windowStart
      ? dateInputToDate(input.windowStart)
      : null,
    windowEnd: input.windowEnd ? dateInputToDate(input.windowEnd) : null,
  };
}

/**
 * Liste des revenus futurs de l'utilisateur (tous statuts), tri stable :
 * premier jour pertinent croissant, puis createdAt, puis id.
 *
 * STRICTEMENT READ-ONLY : aucune écriture Prisma possible depuis cette route.
 */
export async function listExpectedIncomes(
  userId: string,
  today?: string,
): Promise<ExpectedIncomesResponse> {
  const referenceToday = today ?? todayLocalISO();
  const rows = await prisma.expectedIncome.findMany({
    where: { userId },
    include: includeReceived,
    orderBy: { createdAt: 'asc' },
  });

  const items = rows.map((row) =>
    toExpectedIncomePublic(row as unknown as IncomeRowLike, referenceToday),
  );
  // Tri chronologique STABLE du plus proche au plus lointain ; le premier jour
  // pertinent est la date exacte ou windowStart (jamais une date inventée).
  items.sort((a, b) => {
    const startA = expectedIncomeStartDate(a);
    const startB = expectedIncomeStartDate(b);
    if (startA !== null && startB !== null && startA !== startB) {
      return startA < startB ? -1 : 1;
    }
    if (startA === null && startB !== null) return -1;
    if (startA !== null && startB === null) return 1;
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? -1 : 1;
    }
    return a.id < b.id ? -1 : 1;
  });

  return { today: referenceToday, expectedIncomes: items };
}

/**
 * Crée un revenu futur PENDING (aucun compte, aucun impact solde). La devise
 * est celle de l'utilisateur, comme pour les dépenses planifiées.
 */
export async function createExpectedIncome(
  userId: string,
  input: ExpectedIncomeCreate,
): Promise<ExpectedIncomePublic> {
  if (!expectedIncomeTimingIsValid(input)) {
    throw new ApiError(
      400,
      'Provide either a single expectedDate OR a window (windowStart + windowEnd), never both.',
    );
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currency: true },
  });
  if (!user) {
    throw new ApiError(401, 'User not found.');
  }

  const created = await prisma.expectedIncome.create({
    data: {
      userId,
      currency: user.currency as Currency,
      amount: input.amount,
      certainty: input.certainty,
      description: normalizedDescription(input.description),
      ...timingToData(input),
    },
    include: includeReceived,
  });
  return toExpectedIncomePublic(created as unknown as IncomeRowLike);
}

/** Édite un revenu futur encore PENDING (remplacement complet des champs). */
export async function updateExpectedIncome(
  userId: string,
  expectedIncomeId: string,
  input: ExpectedIncomeUpdate,
): Promise<ExpectedIncomePublic> {
  if (!expectedIncomeTimingIsValid(input)) {
    throw new ApiError(
      400,
      'Provide either a single expectedDate OR a window (windowStart + windowEnd), never both.',
    );
  }
  const existing = await prisma.expectedIncome.findFirst({
    where: { id: expectedIncomeId, userId },
    select: { id: true, status: true },
  });
  if (!existing) {
    throw new ApiError(404, 'Expected income not found.');
  }
  if (existing.status !== 'PENDING') {
    throw new ApiError(
      409,
      'A resolved expected income cannot be modified (status: ' +
        existing.status +
        ').',
    );
  }

  const result = await prisma.expectedIncome.updateMany({
    where: { id: expectedIncomeId, userId, status: 'PENDING' },
    data: {
      amount: input.amount,
      certainty: input.certainty,
      description: normalizedDescription(input.description),
      ...timingToData(input),
    },
  });
  if (result.count === 0) {
    // Concurrence : confirmé/annulé entre la lecture et l'écriture.
    throw new ApiError(409, 'This expected income is no longer pending.');
  }

  const row = await prisma.expectedIncome.findUniqueOrThrow({
    where: { id: expectedIncomeId },
    include: includeReceived,
  });
  return toExpectedIncomePublic(row as unknown as IncomeRowLike);
}
/**
 * Annulation d'un revenu futur PENDING → CANCELED. Un revenu déjà RECEIVED ne
 * peut pas être annulé silencieusement (il faut d'abord supprimer la
 * Transaction réelle liée). CANCELED déjà atteint = no-op idempotent.
 */
export async function cancelExpectedIncome(
  userId: string,
  expectedIncomeId: string,
): Promise<ExpectedIncomePublic> {
  const existing = await prisma.expectedIncome.findFirst({
    where: { id: expectedIncomeId, userId },
    select: { id: true, status: true },
  });
  if (!existing) {
    throw new ApiError(404, 'Expected income not found.');
  }
  if (existing.status === 'RECEIVED') {
    throw new ApiError(
      409,
      'A received expected income cannot be canceled. Delete the linked transaction first.',
    );
  }
  if (existing.status === 'CANCELED') {
    // Double clic / retry réseau : déjà annulé, réponse cohérente.
    const row = await prisma.expectedIncome.findUniqueOrThrow({
      where: { id: expectedIncomeId },
      include: includeReceived,
    });
    return toExpectedIncomePublic(row as unknown as IncomeRowLike);
  }

  const result = await prisma.expectedIncome.updateMany({
    where: { id: expectedIncomeId, userId, status: 'PENDING' },
    data: { status: 'CANCELED' },
  });
  if (result.count !== 1) {
    throw new ApiError(409, 'This expected income is no longer pending.');
  }
  const row = await prisma.expectedIncome.findUniqueOrThrow({
    where: { id: expectedIncomeId },
    include: includeReceived,
  });
  return toExpectedIncomePublic(row as unknown as IncomeRowLike);
}

/** Forme « TransactionUpsert INCOME » construite depuis le corps de réception. */
function toRealIncomeTransactionInput(
  body: ExpectedIncomeConfirmReceived,
): TransactionUpsert {
  if (body.dateUnknown !== true && !body.occurredAt) {
    throw new ApiError(400, 'Provide occurredAt or set dateUnknown: true.');
  }
  const input: TransactionUpsert = { type: 'INCOME', amount: body.amount };
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
  return input;
}

/**
 * CONFIRMATION « Oui, je l'ai reçu » — ATOMIQUE.
 *
 * Dans UNE transaction Prisma :
 *  1. vérifier ownership + statut PENDING ;
 *  2. créer la vraie Transaction INCOME (+ ses allocations) via le service du
 *     journal existant (étape 5) ;
 *  3. marquer l'ExpectedIncome RECEIVED + mémoriser receivedTransactionId.
 *
 * En cas d'échec, TOUT est annulé. La double confirmation / les requêtes
 * concurrentes ne peuvent jamais produire deux Transactions actives : le
 * `receivedTransactionId UNIQUE` (contrainte base) et le updateMany
 * conditionnel sérialisent les requêtes ; la perdante voit status ≠ PENDING
 * et effectue un rollback intégral.
 */
export async function confirmReceivedExpectedIncome(
  userId: string,
  expectedIncomeId: string,
  body: ExpectedIncomeConfirmReceived,
): Promise<{ expectedIncome: ExpectedIncomePublic; transaction: TransactionPublic }> {
  const transaction = await prisma.$transaction(async (tx) => {
    const expected = await tx.expectedIncome.findFirst({
      where: { id: expectedIncomeId, userId },
      select: { status: true },
    });
    if (!expected) {
      throw new ApiError(404, 'Expected income not found.');
    }
    if (expected.status !== 'PENDING') {
      throw new ApiError(
        409,
        'This expected income is not pending anymore (status: ' +
          expected.status +
          ').',
      );
    }

    const real = await createTransactionRecord(
      tx,
      userId,
      toRealIncomeTransactionInput(body),
    );

    const claim = await tx.expectedIncome.updateMany({
      where: {
        id: expectedIncomeId,
        userId,
        status: 'PENDING',
        receivedTransactionId: null,
      },
      data: { status: 'RECEIVED', receivedTransactionId: real.id },
    });
    if (claim.count !== 1) {
      // Concurrence : une autre confirmation a gagné → rollback intégral.
      throw new ApiError(
        409,
        'This expected income was already confirmed as received.',
      );
    }
    return real;
  });

  const row = await prisma.expectedIncome.findUniqueOrThrow({
    where: { id: expectedIncomeId },
    include: includeReceived,
  });
  return {
    expectedIncome: toExpectedIncomePublic(row as unknown as IncomeRowLike),
    transaction,
  };
}
/**
 * Rappels internes « Reçu ? » (V1, read-only) : revenus PENDING répartis par
 * catégorie temporelle DÉRIVÉE (jamais stockée, jamais choisie pour
 * l'utilisateur). Aucune écriture Prisma possible depuis cette route : un
 * revenu reste PENDING jusqu'à une action utilisateur explicite.
 */
export async function getIncomeReminders(
  userId: string,
  today?: string,
): Promise<IncomeRemindersResponse> {
  const referenceToday = today ?? todayLocalISO();
  const rows = await prisma.expectedIncome.findMany({
    where: { userId, status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
  });

  const items = rows
    .map((row) =>
      toExpectedIncomePublic(row as unknown as IncomeRowLike, referenceToday),
    )
    .filter(
      (item): item is ExpectedIncomePublic & { reminderBucket: NonNullable<ExpectedIncomePublic['reminderBucket']> } =>
        item.reminderBucket !== null,
    )
    // Tri chronologique stable du plus proche au plus lointain.
    .sort((a, b) => {
      const startA = expectedIncomeStartDate(a);
      const startB = expectedIncomeStartDate(b);
      if (startA !== null && startB !== null && startA !== startB) {
        return startA < startB ? -1 : 1;
      }
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? -1 : 1;
      }
      return a.id < b.id ? -1 : 1;
    });

  const overdue: ExpectedIncomePublic[] = [];
  const dueToday: ExpectedIncomePublic[] = [];
  const inWindow: ExpectedIncomePublic[] = [];
  const upcoming: ExpectedIncomePublic[] = [];
  for (const item of items) {
    if (item.reminderBucket === 'overdue') overdue.push(item);
    else if (item.reminderBucket === 'dueToday') dueToday.push(item);
    else if (item.reminderBucket === 'inWindow') inWindow.push(item);
    else upcoming.push(item);
  }

  return { today: referenceToday, overdue, dueToday, inWindow, upcoming };
}
