import { prisma } from '../db.js';
import { ApiError } from '../http-error.js';
import { allocationsMatchTotal } from '@finance/finance-core';
import type {
  AccountType,
  TransactionPublic,
  TransactionsResponse,
  TransactionType,
  TransactionUpsert,
} from '@finance/shared-types';

/**
 * Service des transactions — journal GLOBAL d'un utilisateur (étape 5).
 *
 * Modèle : une transaction appartient à un utilisateur et est ventilée en
 * allocations (zéro si compte inconnu, une ou plusieurs sinon). Le solde d'un
 * compte est toujours DÉRIVÉ (jamais stocké) : cf. accounts.service.
 *
 * Règles (défendues côté serveur, après validation Zod partagée) :
 *  - chaque accountId d'une allocation doit appartenir à l'utilisateur ;
 *  - chaque categoryId doit être une catégorie système valide ;
 *  - allocations connues ⇒ Σ allocations = montant EXACTEMENT (decimal.js) ;
 *  - PATCH = remplacement atomique complet (transaction Prisma) ;
 *  - DELETE = suppression LOGIQUE (deletedAt) ; une ligne supprimée ne se
 *    modifie plus, n'apparaît plus dans l'historique, n'impacte plus les soldes.
 *
 * ⚠ TRANSFERTS : jamais une « dépense source + revenu destination ». Un
 * transfert sera un type d'opération spécifique plus tard — PAS ici.
 */

/** Inclusions systématiques pour sérialiser une transaction publique. */
const includeLedger = {
  category: { select: { id: true, name: true } },
  allocations: {
    include: { account: { select: { id: true, type: true } } },
  },
} as const;

/** Forme structurale d'une ligne de transaction avec ses relations. */
type TransactionRow = {
  id: string;
  type: string;
  amount: { toString(): string };
  description: string | null;
  occurredAt: Date | null;
  accountUnknown: boolean;
  categoryUnknown: boolean;
  category: { id: string; name: string } | null;
  allocations: {
    amount: { toString(): string };
    account: { id: string; type: string };
  }[];
  createdAt: Date;
  updatedAt: Date;
};

/** Jour "YYYY-MM-DD" saisi par l'utilisateur → Date UTC à midi (neutre). */
function occurredAtToDate(value: string): Date {
  return new Date(`${value}T12:00:00.000Z`);
}

function toPublicTransaction(row: TransactionRow): TransactionPublic {
  return {
    id: row.id,
    type: row.type as TransactionType,
    amount: row.amount.toString(),
    description: row.description,
    occurredAt: row.occurredAt
      ? row.occurredAt.toISOString().slice(0, 10)
      : null,
    accountUnknown: row.accountUnknown,
    categoryUnknown: row.categoryUnknown,
    category: row.category
      ? { id: row.category.id, name: row.category.name }
      : null,
    allocations: row.allocations.map((allocation) => ({
      accountId: allocation.account.id,
      accountType: allocation.account.type as AccountType,
      amount: allocation.amount.toString(),
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Champs de la transaction (hors allocations) normalisés pour l'écriture. */
function transactionData(userId: string, input: TransactionUpsert) {
  const isExpense = input.type === 'EXPENSE';
  return {
    userId,
    type: input.type,
    amount: input.amount,
    description: input.description?.trim() ? input.description.trim() : null,
    occurredAt: input.occurredAt ? occurredAtToDate(input.occurredAt) : null,
    categoryId: isExpense ? (input.categoryId ?? null) : null,
    categoryUnknown: isExpense ? (input.categoryUnknown ?? false) : false,
    accountUnknown: input.accountUnknown ?? false,
  };
}

/** Chaque compte alloué doit appartenir à l'utilisateur (sinon 404 générique). */
async function assertAccountsOwned(
  userId: string,
  allocations: { accountId: string }[],
): Promise<void> {
  if (allocations.length === 0) {
    return;
  }
  const ids = allocations.map((allocation) => allocation.accountId);
  const rows = await prisma.account.findMany({
    where: { id: { in: ids }, userId },
    select: { id: true },
  });
  if (rows.length !== ids.length) {
    throw new ApiError(404, 'Account not found.');
  }
}

/** Une catégorie référencée doit exister parmi les catégories système. */
async function assertCategoryAllowed(
  categoryId: string | undefined,
): Promise<void> {
  if (!categoryId) {
    return;
  }
  const row = await prisma.category.findFirst({
    where: { id: categoryId, isSystem: true },
    select: { id: true },
  });
  if (!row) {
    throw new ApiError(400, 'Invalid category.');
  }
}

/**
 * Historique GLOBAL paginé de l'utilisateur (transactions ACTIVES uniquement).
 * Tri stable : date la plus récente d'abord, date inconnue en dernier
 * (`occurredAt` null), puis createdAt desc, puis id asc.
 */
export async function getTransactionLedger(
  userId: string,
  page: number,
  limit: number,
): Promise<TransactionsResponse> {
  const where = { userId, deletedAt: null };
  const [rows, total, incomeAggregate, expenseAggregate] = await Promise.all([
    prisma.transaction.findMany({
      where,
      include: includeLedger,
      orderBy: [
        { occurredAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
        { id: 'asc' },
      ],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.transaction.count({ where }),
    prisma.transaction.aggregate({
      where: { ...where, type: 'INCOME' },
      _sum: { amount: true },
    }),
    prisma.transaction.aggregate({
      where: { ...where, type: 'EXPENSE' },
      _sum: { amount: true },
    }),
  ]);

  return {
    transactions: rows.map(toPublicTransaction),
    page,
    limit,
    hasMore: page * limit < total,
    totals: {
      incomes: incomeAggregate._sum.amount?.toString() ?? '0',
      expenses: expenseAggregate._sum.amount?.toString() ?? '0',
    },
  };
}

/** Crée une transaction + ses allocations de façon atomique. */
export async function createTransaction(
  userId: string,
  input: TransactionUpsert,
): Promise<TransactionPublic> {
  const allocations = input.allocations ?? [];
  await assertAccountsOwned(userId, allocations);
  await assertCategoryAllowed(input.categoryId);

  // Allocations connues ⇒ somme = montant EXACTEMENT (decimal.js).
  if (!(input.accountUnknown ?? false)) {
    const match = allocationsMatchTotal(input.amount, allocations);
    if (!match) {
      throw new ApiError(
        400,
        'Allocations must sum exactly to the transaction amount.',
      );
    }
  }

  const row = await prisma.transaction.create({
    data: {
      ...transactionData(userId, input),
      allocations:
        input.accountUnknown === true || allocations.length === 0
          ? undefined
          : {
              create: allocations.map((allocation) => ({
                accountId: allocation.accountId,
                amount: allocation.amount,
              })),
            },
    },
    include: includeLedger,
  });
  return toPublicTransaction(row);
}


/**
 * Modifie une transaction de façon ATOMIQUE (transaction Prisma) : le nouvel
 * état remplace l'ancien (montant, date, catégorie, description, allocations,
 * compte inconnu/connu). Les anciennes allocations sont retirées : seul le
 * nouvel état influence les soldes.
 */
export async function updateTransaction(
  userId: string,
  transactionId: string,
  input: TransactionUpsert,
): Promise<TransactionPublic> {
  const existing = await prisma.transaction.findFirst({
    where: { id: transactionId, userId },
    select: { id: true, deletedAt: true },
  });
  if (!existing) {
    throw new ApiError(404, 'Transaction not found.');
  }
  if (existing.deletedAt) {
    throw new ApiError(409, 'A deleted transaction cannot be modified.');
  }

  const allocations = input.allocations ?? [];
  await assertAccountsOwned(userId, allocations);
  await assertCategoryAllowed(input.categoryId);
  if (!(input.accountUnknown ?? false)) {
    const match = allocationsMatchTotal(input.amount, allocations);
    if (!match) {
      throw new ApiError(
        400,
        'Allocations must sum exactly to the transaction amount.',
      );
    }
  }

  await prisma.$transaction([
    prisma.transaction.update({
      where: { id: transactionId },
      data: transactionData(userId, input),
    }),
    prisma.transactionAccountAllocation.deleteMany({
      where: { transactionId },
    }),
    // Nouvel état : zéro allocation (compte inconnu) ou remplacement complet.
    ...(input.accountUnknown === true || allocations.length === 0
      ? []
      : [
          prisma.transactionAccountAllocation.createMany({
            data: allocations.map((allocation) => ({
              transactionId,
              accountId: allocation.accountId,
              amount: allocation.amount,
            })),
          }),
        ]),
  ]);

  const row = await prisma.transaction.findUniqueOrThrow({
    where: { id: transactionId },
    include: includeLedger,
  });
  return toPublicTransaction(row);
}

/** Suppression LOGIQUE : la ligne reste en base (deletedAt), plus d'impact. */
export async function deleteTransaction(
  userId: string,
  transactionId: string,
): Promise<void> {
  const result = await prisma.transaction.updateMany({
    where: { id: transactionId, userId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  if (result.count === 0) {
    // Ni trouvée, ni autorisée, ni déjà supprimée : réponse générique.
    throw new ApiError(404, 'Transaction not found.');
  }
}

