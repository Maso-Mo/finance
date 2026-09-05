import { prisma } from '../db.js';
import { ApiError } from '../http-error.js';
import {
  currentBalance,
  netFlow,
  toMoney,
  transactionTotals,
  type Money,
} from '@finance/finance-core';
import type {
  AccountLedgerResponse,
  AccountPublic,
  Currency,
  TransactionCreate,
  TransactionPublic,
} from '@finance/shared-types';

/**
 * Service des transactions (journal dépenses/revenus) — étape 5.
 *
 * Règle métier : le solde d'un compte est DÉRIVÉ en lecture
 * (solde de départ + revenus − dépenses). Les montants sont stockés positifs
 * dans le sens de l'opération (`type`) ; le signe n'est appliqué qu'au moment
 * du calcul (finance-core). Tous les montants sortent en chaîne exacte.
 *
 * Tous les accès sont filtrés par userId authentifié : une transaction ne peut
 * jamais être lue/créée/supprimée que par le propriétaire du compte.
 */

type AccountRow = {
  id: string;
  type: string;
  currency: string;
  initialBalance: { toString(): string };
};

type TransactionRow = {
  id: string;
  accountId: string;
  userId: string;
  type: string;
  amount: { toString(): string };
  description: string | null;
  occurredAt: Date;
};

function toPublicAccount(account: AccountRow, balance: Money): AccountPublic {
  return {
    id: account.id,
    type: account.type as AccountPublic['type'],
    currency: account.currency as AccountPublic['currency'],
    initialBalance: account.initialBalance.toString(),
    balance: balance.toString(),
  };
}

function toPublicTransaction(row: TransactionRow): TransactionPublic {
  return {
    id: row.id,
    accountId: row.accountId,
    type: row.type as TransactionPublic['type'],
    amount: row.amount.toString(),
    description: row.description,
    // L'opération est stockée à midi UTC : extraire la date revient au jour
    // exact saisi par l'utilisateur, sans décalage de fuseau.
    occurredAt: row.occurredAt.toISOString().slice(0, 10),
  };
}

/** Jour "YYYY-MM-DD" saisi par l'utilisateur → Date UTC à midi (neutre). */
function occurredAtToDate(value: string): Date {
  return new Date(`${value}T12:00:00.000Z`);
}

/**
 * Flux net (revenus − dépenses, en Decimal) par compte pour un utilisateur.
 * Agrégation SQL unique (groupBy) : évite de charger toutes les lignes du
 * journal pour calculer les soldes du dashboard.
 */
export async function getAccountNetFlows(
  userId: string,
): Promise<Map<string, Money>> {
  const groups = await prisma.transaction.groupBy({
    by: ['accountId', 'type'],
    where: { userId },
    _sum: { amount: true },
  });

  const flows = new Map<string, Money>();
  for (const group of groups) {
    const delta = netFlow([
      { type: group.type, amount: group._sum.amount?.toString() ?? '0' },
    ]);
    const previous = flows.get(group.accountId);
    flows.set(group.accountId, previous ? previous.plus(delta) : delta);
  }
  return flows;
}

/** Journal complet d'un compte (compte + opérations + totaux par sens). */
export async function getAccountLedger(
  userId: string,
  accountId: string,
): Promise<AccountLedgerResponse> {
  const account = await prisma.account.findFirst({
    where: { id: accountId, userId },
  });
  if (!account) {
    throw new ApiError(404, 'Account not found.');
  }

  const rows = await prisma.transaction.findMany({
    where: { accountId, userId },
    orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
  });

  const transactions = rows.map(toPublicTransaction);
  const entries = rows.map((row) => ({
    type: row.type,
    amount: row.amount.toString(),
  }));
  const totals = transactionTotals(entries);
  const balance = currentBalance(account.initialBalance.toString(), entries);

  return {
    account: toPublicAccount(
      {
        id: account.id,
        type: account.type,
        currency: account.currency as Currency,
        initialBalance: account.initialBalance,
      },
      balance,
    ),
    transactions,
    totals: {
      incomes: totals.incomes.toString(),
      expenses: totals.expenses.toString(),
    },
  };
}

/** Crée une opération (dépense/revenu) sur un compte du propriétaire. */
export async function createAccountTransaction(
  userId: string,
  accountId: string,
  input: TransactionCreate,
): Promise<TransactionPublic> {
  const account = await prisma.account.findFirst({
    where: { id: accountId, userId },
    select: { id: true },
  });
  if (!account) {
    throw new ApiError(404, 'Account not found.');
  }

  const today = new Date().toISOString().slice(0, 10);
  const row = await prisma.transaction.create({
    data: {
      userId,
      accountId,
      type: input.type,
      amount: input.amount,
      description: input.description ?? null,
      occurredAt: occurredAtToDate(input.occurredAt ?? today),
    },
  });
  return toPublicTransaction(row);
}

/** Supprime une opération du compte (correction d'une saisie erronée). */
export async function deleteAccountTransaction(
  userId: string,
  accountId: string,
  transactionId: string,
): Promise<void> {
  const result = await prisma.transaction.deleteMany({
    where: { id: transactionId, accountId, userId },
  });
  if (result.count === 0) {
    // Ni trouvée ni autorisée : réponse générique, sans fuite d'existence.
    throw new ApiError(404, 'Transaction not found.');
  }
}
