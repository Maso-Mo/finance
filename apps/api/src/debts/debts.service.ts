import { prisma } from '../db.js';
import { ApiError } from '../http-error.js';
import { dbDateToISO, dateInputToDate, todayLocalISO } from '../dates.js';
import { createTransactionRecord } from '../transactions/transactions.service.js';
import {
  debtRemaining,
  debtSettledAmount,
  debtStatus,
  isDebtOverpayment,
  toMoney,
} from '@finance/finance-core';
import type { Money } from '@finance/finance-core';
import type {
  AccountType,
  Currency,
  DebtCreate,
  DebtDirection,
  DebtKind,
  DebtPublic,
  DebtSettlementCreate,
  DebtSettlementPublic,
  DebtSettlementUpdate,
  DebtUpdate,
  TransactionUpsert,
} from '@finance/shared-types';
import { Prisma } from '../generated/prisma/client.js';

/**
 * DETTES / CRÉANCES / RÈGLEMENTS (étape 11) — API.
 *
 * Invariants défendus ici (en plus du schéma partagé) :
 *  - le RESTANT est TOUJOURS dérivé (jamais stocké) ;
 *  - Σ règlements actifs <= originalAmount : défendu TRANSACTIONNELLEMENT par
 *    un verrou ligne (`SELECT … FOR UPDATE` sur la dette) avant tout calcul —
 *    jamais un simple CHECK SQL (qui ne peut pas lire les autres lignes) ;
 *  - un règlement STANDARD n'impacte QUE le solde du compte : AUCUNE
 *    Transaction EXPENSE/INCOME créée, aucun budget/spent/forecast touché ;
 *  - un règlement de type AVANCE (`INCOME_ADVANCE_RECEIVABLE`, réservé à
 *    OWED_TO_ME) n'impacte PAS le solde par lui-même : le +compte est porté
 *    par une Transaction INCOME RÉELLE liée ATOMIQUEMENT (`linkedTransactionId`
 *    UNIQUE en base → aucun double comptage possible) ;
 *  - la modification/annulation de cette Transaction INCOME est REFUSÉE dans
 *    le module transactions : elle ne se gère QUE via le module dettes
 *    (PATCH miroir sur la Transaction, DELETE → suppression logique des DEUX).
 *
 * Tous les montants stockés restent POSITIFS ; la DIRECTION porte le sens.
 */

type SettlementAccount = { id: string; type: string };

/** Ligne de règlement telle que renvoyée par Prisma (relations incluses). */
type SettlementRow = {
  id: string;
  amount: { toString(): string };
  currency: string;
  account: SettlementAccount | null;
  accountUnknown: boolean;
  occurredAt: Date | null;
  dateUnknown: boolean;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Ligne de dette avec ses règlements ACTIFS (relations incluses). */
type DebtRow = {
  id: string;
  direction: string;
  kind: string;
  currency: string;
  originalAmount: { toString(): string };
  counterpartyName: string | null;
  description: string | null;
  dueDate: Date | null;
  dueDateUnknown: boolean;
  createdAt: Date;
  updatedAt: Date;
  settlements: SettlementRow[];
};

// Inclusions systématiques : règlements ACTIFS du plus ancien au plus récent.
const DEBT_INCLUDE: Prisma.DebtInclude = {
  settlements: {
    where: { deletedAt: null },
    orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
    include: { account: { select: { id: true, type: true } } },
  },
};

/** Jour « YYYY-MM-DD » → Date UTC à midi (neutre) pour une colonne TIMESTAMP. */
function settlementDayToDate(value: string): Date {
  return new Date(`${value}T12:00:00.000Z`);
}

// --- Sérialisation (montants Decimal → chaînes exactes) ---

function toPublicSettlement(row: SettlementRow): DebtSettlementPublic {
  return {
    id: row.id,
    amount: row.amount.toString(),
    currency: row.currency as Currency,
    account: row.account
      ? { id: row.account.id, type: row.account.type as AccountType }
      : null,
    accountUnknown: row.accountUnknown,
    occurredAt: row.occurredAt ? row.occurredAt.toISOString().slice(0, 10) : null,
    dateUnknown: row.dateUnknown,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPublicDebt(row: DebtRow): DebtPublic {
  const settled = debtSettledAmount(
    row.settlements.map((settlement) => settlement.amount.toString()),
  );
  const remaining = debtRemaining(row.originalAmount.toString(), settled);
  const dueDate = row.dueDate && !row.dueDateUnknown ? dbDateToISO(row.dueDate) : null;
  return {
    id: row.id,
    direction: row.direction as DebtDirection,
    kind: row.kind as DebtKind,
    currency: row.currency as Currency,
    originalAmount: row.originalAmount.toString(),
    settledAmount: settled.toString(),
    remaining: remaining.toString(),
    counterpartyName: row.counterpartyName,
    description: row.description,
    dueDate,
    dueDateUnknown: row.dueDateUnknown,
    temporalStatus: debtStatus(remaining, dueDate, todayLocalISO()),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    settlements: row.settlements.map(toPublicSettlement),
  };
}

// --- Lecture d'une dette active (avec son historique de règlements) ---

async function fetchActiveDebt(
  db: Prisma.TransactionClient,
  userId: string,
  debtId: string,
): Promise<DebtRow | null> {
  const row = await db.debt.findFirst({
    where: { id: debtId, userId, deletedAt: null },
    include: DEBT_INCLUDE,
  });
  return (row ?? null) as unknown as DebtRow | null;
}

async function fetchActiveSettlement(
  db: Prisma.TransactionClient,
  userId: string,
  debtId: string,
  settlementId: string,
): Promise<
  | (SettlementRow & { linkedTransactionId: string | null })
  | null
> {
  const row = await db.debtSettlement.findFirst({
    where: { id: settlementId, debtId, userId, deletedAt: null },
    include: { account: { select: { id: true, type: true } } },
  });
  return (row ?? null) as (SettlementRow & {
    linkedTransactionId: string | null;
  }) | null;
}

/**
 * Verrouille la ligne de la dette pour la durée de la transaction courante :
 * deux créations/modifications de règlements CONCURRENTES se sérialisent, et
 * chaque transaction relit les règlements actifs APRÈS avoir acquis le verrou.
 * → le sur-remboursement reste impossible même en cas de course.
 */
async function lockDebtRow(
  db: Prisma.TransactionClient,
  debtId: string,
): Promise<void> {
  await db.$queryRaw`SELECT "id" FROM "debts" WHERE "id" = CAST(${debtId} AS uuid) FOR UPDATE`;
}

/** Σ des règlements ACTIFS (Money exact) — exclut optionnellement un id. */
async function activeSettledSum(
  db: Prisma.TransactionClient,
  debtId: string,
  excludeSettlementId?: string,
): Promise<Money> {
  const rows = await db.debtSettlement.findMany({
    where: { debtId, deletedAt: null },
    select: { id: true, amount: true },
  });
  return debtSettledAmount(
    rows
      .filter((row) => row.id !== excludeSettlementId)
      .map((row) => row.amount.toString()),
  );
}

/** Le compte référencé par un règlement doit appartenir à l'utilisateur. */
async function assertAccountOwned(
  db: Prisma.TransactionClient,
  userId: string,
  accountId: string | null | undefined,
): Promise<void> {
  if (!accountId) {
    return;
  }
  const row = await db.account.findFirst({
    where: { id: accountId, userId },
    select: { id: true },
  });
  if (!row) {
    throw new ApiError(404, 'Account not found.');
  }
}

/** Dette active + verrou, sinon 404. À appeler avant TOUT calcul de solde. */
async function lockOwnedDebt(
  db: Prisma.TransactionClient,
  userId: string,
  debtId: string,
): Promise<{ direction: string; kind: string; originalAmount: string }> {
  const debt = await db.debt.findFirst({
    where: { id: debtId, userId, deletedAt: null },
    select: {
      id: true,
      direction: true,
      kind: true,
      originalAmount: true,
    },
  });
  if (!debt) {
    throw new ApiError(404, 'Debt not found.');
  }
  await lockDebtRow(db, debt.id);
  return {
    direction: debt.direction,
    kind: debt.kind,
    originalAmount: debt.originalAmount.toString(),
  };
}

// --- Liste / création / modification / suppression d'une DETTE ---

export async function listDebts(userId: string): Promise<DebtPublic[]> {
  const rows = await prisma.debt.findMany({
    where: { userId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: DEBT_INCLUDE,
  });
  return (rows as unknown as DebtRow[]).map(toPublicDebt);
}

export async function createDebt(
  userId: string,
  input: DebtCreate,
): Promise<DebtPublic> {
  const debt = await prisma.debt.create({
    data: {
      userId,
      direction: input.direction,
      kind: input.kind ?? 'STANDARD',
      originalAmount: input.originalAmount,
      counterpartyName: input.counterpartyName?.trim()
        ? input.counterpartyName.trim()
        : null,
      description: input.description?.trim() ? input.description.trim() : null,
      dueDate: input.dueDate ? dateInputToDate(input.dueDate) : null,
      dueDateUnknown: input.dueDateUnknown ?? false,
    },
    include: DEBT_INCLUDE,
  });
  return toPublicDebt(debt as unknown as DebtRow);
}

/**
 * Modification partielle d'une dette. `originalAmount` peut être baissé
 * jusqu'au montant déjà réglé inclus (jamais en dessous : la dette ne peut
 * pas devenir « négative » par rapport à ses règlements actifs).
 */
export async function updateDebt(
  userId: string,
  debtId: string,
  input: DebtUpdate,
): Promise<DebtPublic> {
  return prisma.$transaction(async (tx) => {
    await lockOwnedDebt(tx, userId, debtId);

    const data: Record<string, unknown> = {};
    if (input.originalAmount !== undefined) {
      // Le verrou empêche un règlement concurrent de modifier la somme réglée
      // entre la lecture ci-dessous et l'écriture.
      const settled = await activeSettledSum(tx, debtId);
      if (toMoney(input.originalAmount).lt(settled)) {
        throw new ApiError(
          400,
          'New original amount cannot be lower than the already settled amount.',
        );
      }
      data.originalAmount = input.originalAmount;
    }
    if (input.counterpartyName !== undefined) {
      data.counterpartyName = input.counterpartyName?.trim()
        ? input.counterpartyName.trim()
        : null;
    }
    if (input.description !== undefined) {
      data.description = input.description?.trim()
        ? input.description.trim()
        : null;
    }
    if (input.dueDateUnknown === true) {
      data.dueDate = null;
      data.dueDateUnknown = true;
    } else if (input.dueDate !== undefined) {
      data.dueDate = input.dueDate ? dateInputToDate(input.dueDate) : null;
      data.dueDateUnknown = false;
    }

    const debt = await tx.debt.update({
      where: { id: debtId },
      data,
      include: DEBT_INCLUDE,
    });
    return toPublicDebt(debt as unknown as DebtRow);
  });
}

/**
 * Suppression LOGIQUE d'une dette. La dette disparaît des vues et n'impacte
 * plus rien. Si un règlement de type AVANCE était lié à une Transaction
 * INCOME, celle-ci est supprimée logiquement elle aussi (la suppression d'une
 * avance passe toujours par le module dettes).
 */
export async function deleteDebt(userId: string, debtId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockOwnedDebt(tx, userId, debtId);
    const now = new Date();
    const settlements = await tx.debtSettlement.findMany({
      where: { debtId, userId, deletedAt: null },
      select: { linkedTransactionId: true },
    });
    for (const settlement of settlements) {
      if (settlement.linkedTransactionId) {
        await tx.transaction.updateMany({
          where: {
            id: settlement.linkedTransactionId,
            userId,
            deletedAt: null,
          },
          data: { deletedAt: now },
        });
      }
    }
    const result = await tx.debt.updateMany({
      where: { id: debtId, userId, deletedAt: null },
      data: { deletedAt: now },
    });
    if (result.count === 0) {
      throw new ApiError(404, 'Debt not found.');
    }
  });
}
// --- RÈGLEMENTS (création / modification / suppression) ---

/** État effectif d'un règlement après fusion d'un PATCH partiel. */
type SettlementState = {
  amount: string;
  description: string | null;
  accountId: string | null;
  accountUnknown: boolean;
  occurredAt: Date | null;
  dateUnknown: boolean;
};

/**
 * Fusionne un PATCH partiel dans l'état courant puis revalide la cohérence
 * finale (compte précis XOR inconnu explicite ; date réelle XOR inconnue).
 */
function mergeSettlementPatch(
  existing: {
    amount: { toString(): string };
    description: string | null;
    account: { id: string; type: string } | null;
    accountUnknown: boolean;
    occurredAt: Date | null;
    dateUnknown: boolean;
  },
  input: DebtSettlementUpdate,
): SettlementState {
  const description =
    input.description !== undefined
      ? input.description?.trim()
        ? input.description.trim()
        : null
      : existing.description;

  // Compte : les trois cas possibles du PATCH.
  let accountId = existing.account?.id ?? null;
  let accountUnknown = existing.accountUnknown;
  if (input.accountId !== undefined && input.accountId !== null) {
    accountId = input.accountId;
    accountUnknown = false;
  }
  if (input.accountUnknown === true) {
    accountUnknown = true;
    accountId = null;
  }
  if (!accountId && !accountUnknown) {
    throw new ApiError(400, 'Provide accountId or set accountUnknown: true.');
  }

  // Date : jour réel, « je ne sais plus », ou état courant conservé.
  let occurredAt = existing.occurredAt;
  let dateUnknown = existing.dateUnknown;
  if (input.occurredAt !== undefined && input.occurredAt !== null) {
    occurredAt = settlementDayToDate(input.occurredAt);
    dateUnknown = false;
  }
  if (input.dateUnknown === true) {
    dateUnknown = true;
    occurredAt = null;
  }
  if (!occurredAt && !dateUnknown) {
    throw new ApiError(400, 'Provide occurredAt or set dateUnknown: true.');
  }

  return {
    amount: input.amount ?? existing.amount.toString(),
    description,
    accountId,
    accountUnknown,
    occurredAt,
    dateUnknown,
  };
}

/** Transaction INCOME réelle créée à l'occasion d'un règlement de type AVANCE. */
function advanceTransactionInput(input: DebtSettlementCreate): TransactionUpsert {
  const accountKnown =
    (input.accountUnknown ?? false) === false && input.accountId != null;
  return {
    type: 'INCOME',
    amount: input.amount,
    description: input.description?.trim() ? input.description.trim() : undefined,
    occurredAt: input.occurredAt ?? undefined,
    dateUnknown: input.dateUnknown ?? false,
    accountUnknown: !accountKnown,
    allocations:
      accountKnown && input.accountId
        ? [{ accountId: input.accountId, amount: input.amount }]
        : [],
  };
}

/** Transaction INCOME réelle liée à une avance — PATCH EN MIROIR. */
async function mirrorAdvanceTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  linkedTransactionId: string,
  state: SettlementState,
): Promise<void> {
  const transaction = await tx.transaction.findFirst({
    where: { id: linkedTransactionId, userId },
    select: { id: true },
  });
  if (!transaction) {
    throw new ApiError(
      409,
      'The income linked to this advance no longer exists.',
    );
  }
  await tx.transaction.update({
    where: { id: linkedTransactionId },
    data: {
      amount: state.amount,
      description: state.description?.trim() ? state.description.trim() : null,
      occurredAt: state.occurredAt,
      accountUnknown: state.accountUnknown,
    },
  });
  await tx.transactionAccountAllocation.deleteMany({
    where: { transactionId: linkedTransactionId },
  });
  if (state.accountId && !state.accountUnknown) {
    await tx.transactionAccountAllocation.create({
      data: {
        transactionId: linkedTransactionId,
        accountId: state.accountId,
        amount: state.amount,
      },
    });
  }
}

export async function createSettlement(
  userId: string,
  debtId: string,
  input: DebtSettlementCreate,
): Promise<{ debt: DebtPublic; settlement: DebtSettlementPublic }> {
  return prisma.$transaction(async (tx) => {
    const debt = await lockOwnedDebt(tx, userId, debtId);
    await assertAccountOwned(
      tx,
      userId,
      input.accountUnknown ? null : input.accountId,
    );
    const settled = await activeSettledSum(tx, debtId);
    if (isDebtOverpayment(debt.originalAmount, settled, input.amount)) {
      throw new ApiError(
        400,
        'Settlement exceeds the remaining debt: overpayment is not allowed.',
      );
    }

    const description = input.description?.trim() ? input.description.trim() : null;
    const created = await tx.debtSettlement.create({
      data: {
        debtId,
        userId,
        amount: input.amount,
        accountId: input.accountUnknown ? null : input.accountId,
        accountUnknown: input.accountUnknown ?? false,
        occurredAt: input.occurredAt ? settlementDayToDate(input.occurredAt) : null,
        dateUnknown: input.dateUnknown ?? false,
        description,
      },
      include: { account: { select: { id: true, type: true } } },
    });

    // AVANCE (OWED_TO_ME, kind INCOME_ADVANCE_RECEIVABLE) : la Transaction
    // INCOME réelle porte le +compte — jamais le règlement. ATOMIQUE : si la
    // création de la Transaction échoue, le règlement n'existe pas non plus.
    if (debt.kind === 'INCOME_ADVANCE_RECEIVABLE') {
      const transaction = await createTransactionRecord(
        tx,
        userId,
        advanceTransactionInput(input),
        // Règlement « avance » : ce +compte n'est PAS un revenu nouveau à
        // épargner (remboursement d'une créance déjà comptée). Aucune
        // proposition d'épargne ne doit être créée pour cette Transaction.
        { skipSavingsSuggestion: true },
      );
      await tx.debtSettlement.update({
        where: { id: created.id },
        data: { linkedTransactionId: transaction.id },
      });
    }

    const debtRow = await fetchActiveDebt(tx, userId, debtId);
    return {
      debt: toPublicDebt(debtRow as unknown as DebtRow),
      settlement: toPublicSettlement(created as SettlementRow),
    };
  });
}

export async function updateSettlement(
  userId: string,
  debtId: string,
  settlementId: string,
  input: DebtSettlementUpdate,
): Promise<{ debt: DebtPublic; settlement: DebtSettlementPublic }> {
  return prisma.$transaction(async (tx) => {
    const debt = await lockOwnedDebt(tx, userId, debtId);
    const existing = await fetchActiveSettlement(
      tx,
      userId,
      debtId,
      settlementId,
    );
    if (!existing) {
      throw new ApiError(404, 'Settlement not found.');
    }
    const state = mergeSettlementPatch(existing, input);
    await assertAccountOwned(tx, userId, state.accountId);
    const settled = await activeSettledSum(tx, debtId, settlementId);
    if (isDebtOverpayment(debt.originalAmount, settled, state.amount)) {
      throw new ApiError(
        400,
        'Settlement exceeds the remaining debt: overpayment is not allowed.',
      );
    }

    const updated = await tx.debtSettlement.update({
      where: { id: settlementId },
      data: {
        amount: state.amount,
        description: state.description,
        accountId: state.accountId,
        accountUnknown: state.accountUnknown,
        occurredAt: state.occurredAt,
        dateUnknown: state.dateUnknown,
      },
      include: { account: { select: { id: true, type: true } } },
    });

    // Avance : la Transaction INCOME liée est mise à jour EN MIROIR (jamais
    // d'écart entre le règlement et le revenu réel qui porte le +compte).
    if (existing.linkedTransactionId) {
      await mirrorAdvanceTransaction(
        tx,
        userId,
        existing.linkedTransactionId,
        state,
      );
    }

    const debtRow = await fetchActiveDebt(tx, userId, debtId);
    return {
      debt: toPublicDebt(debtRow as unknown as DebtRow),
      settlement: toPublicSettlement(updated as SettlementRow),
    };
  });
}

/** Suppression LOGIQUE d'un règlement. Pour une avance, la Transaction INCOME
 * liée est supprimée elle aussi : plus aucun impact sur les soldes. */
export async function deleteSettlement(
  userId: string,
  debtId: string,
  settlementId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockOwnedDebt(tx, userId, debtId);
    const existing = await tx.debtSettlement.findFirst({
      where: { id: settlementId, debtId, userId },
      select: { deletedAt: true, linkedTransactionId: true },
    });
    if (!existing || existing.deletedAt) {
      throw new ApiError(404, 'Settlement not found.');
    }
    const now = new Date();
    await tx.debtSettlement.updateMany({
      where: { id: settlementId, userId },
      data: { deletedAt: now },
    });
    if (existing.linkedTransactionId) {
      await tx.transaction.updateMany({
        where: { id: existing.linkedTransactionId, userId, deletedAt: null },
        data: { deletedAt: now },
      });
    }
  });
}

