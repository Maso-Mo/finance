import { prisma } from '../db.js';
import { ApiError } from '../http-error.js';
import {
  currentBalance,
  sumAvailableBalance,
  toMoney,
  type Money,
} from '@finance/finance-core';
import type { AccountPublic, Currency } from '@finance/shared-types';

/**
 * Service des comptes financiers V1.
 * Tous les accès sont filtrés par userId authentifié : un utilisateur ne peut
 * jamais lire/modifier un compte qui ne lui appartient pas.
 *
 * Solde courant DÉRIVÉ (jamais stocké) :
 *   initialBalance + revenus actifs alloués − dépenses actives allouées
 *   + ajustements de solde (AccountAdjustment).
 *
 * ⚠ Décision backend : quand l'utilisateur déclare « je veux que le solde
 * connu devienne X », le serveur choisit :
 *   - aucun mouvement actif sur le compte → mise à jour d'initialBalance ;
 *   - au moins un mouvement → création d'un AccountAdjustment (correction),
 *     sans jamais toucher l'historique des transactions.
 *
 * Représentation monétaire exacte : Decimal Prisma → chaîne à la frontière,
 * puis finance-core (decimal.js) pour les calculs (jamais de flottant).
 */

type AccountRow = {
  id: string;
  type: string;
  currency: string;
  initialBalance: { toString(): string };
};

function toPublic(account: AccountRow, balance: Money): AccountPublic {
  return {
    id: account.id,
    type: account.type as AccountPublic['type'],
    currency: account.currency as AccountPublic['currency'],
    initialBalance: account.initialBalance.toString(),
    balance: balance.toString(),
  };
}

/** Convertit une agrégation groupBy (par compte) en Map compte → Decimal. */
function indexSum(
  groups: { accountId: string; sum: string | null }[],
): Map<string, Money> {
  const map = new Map<string, Money>();
  for (const group of groups) {
    map.set(group.accountId, toMoney(group.sum ?? '0'));
  }
  return map;
}

export async function getDashboard(userId: string): Promise<{
  currency: Currency;
  accounts: AccountPublic[];
  totalAvailable: string;
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currency: true },
  });
  if (!user) {
    throw new ApiError(401, 'User not found.');
  }

  const rows = await prisma.account.findMany({
    where: { userId },
    orderBy: { type: 'asc' },
  });

  // Sommes exactes en base (NUMERIC), par compte et par nature : revenus actifs,
  // dépenses actives, ajustements (déjà signés).
  const [incomeGroups, expenseGroups, adjustmentGroups] = await Promise.all([
    prisma.transactionAccountAllocation.groupBy({
      by: ['accountId'],
      where: { transaction: { userId, type: 'INCOME', deletedAt: null } },
      _sum: { amount: true },
    }),
    prisma.transactionAccountAllocation.groupBy({
      by: ['accountId'],
      where: { transaction: { userId, type: 'EXPENSE', deletedAt: null } },
      _sum: { amount: true },
    }),
    prisma.accountAdjustment.groupBy({
      by: ['accountId'],
      where: { userId },
      _sum: { amount: true },
    }),
  ]);

  const incomes = indexSum(
    incomeGroups.map((g) => ({
      accountId: g.accountId,
      sum: g._sum.amount?.toString() ?? '0',
    })),
  );
  const expenses = indexSum(
    expenseGroups.map((g) => ({
      accountId: g.accountId,
      sum: g._sum.amount?.toString() ?? '0',
    })),
  );
  const adjustments = indexSum(
    adjustmentGroups.map((g) => ({
      accountId: g.accountId,
      sum: g._sum.amount?.toString() ?? '0',
    })),
  );

  const accounts: AccountPublic[] = rows.map((row) => {
    const starting = toMoney(row.initialBalance.toString());
    const net = (incomes.get(row.id) ?? toMoney('0')).minus(
      expenses.get(row.id) ?? toMoney('0'),
    );
    const balance = currentBalance(
      starting,
      net,
      adjustments.get(row.id) ?? toMoney('0'),
    );
    return toPublic(row, balance);
  });

  const totalAvailable = sumAvailableBalance(
    accounts.map((account) => ({
      type: account.type,
      balance: account.balance,
    })),
  );

  return {
    currency: user.currency as Currency,
    accounts,
    totalAvailable: totalAvailable.toString(),
  };
}

/**
 * « Je veux que le solde connu de ce compte devienne `targetBalance`. »
 * Le backend décide initialBalance vs AccountAdjustment (voir en-tête).
 */
export async function setAccountTargetBalance(
  userId: string,
  accountId: string,
  targetBalance: string,
): Promise<{ account: AccountPublic; totalAvailable: string }> {
  const account = await prisma.account.findFirst({
    where: { id: accountId, userId },
    select: { id: true },
  });
  if (!account) {
    // Ni trouvé ni autorisé : réponse générique sans fuite d'existence.
    throw new ApiError(404, 'Account not found.');
  }

  const [activeAllocations, adjustmentCount] = await Promise.all([
    prisma.transactionAccountAllocation.count({
      where: { accountId, transaction: { userId, deletedAt: null } },
    }),
    prisma.accountAdjustment.count({ where: { accountId, userId } }),
  ]);
  const hasMovement = activeAllocations > 0 || adjustmentCount > 0;

  if (!hasMovement) {
    // Aucun mouvement : le solde de départ reste modifiable directement.
    await prisma.account.update({
      where: { id: accountId },
      data: { initialBalance: targetBalance },
    });
  } else {
    // Au moins un mouvement : on enregistre une CORRECTION de solde (jamais
    // une transaction, jamais une retouche d'historique).
    const dashboard = await getDashboard(userId);
    const current = dashboard.accounts.find((a) => a.id === accountId);
    if (!current) {
      throw new ApiError(404, 'Account not found.');
    }
    const delta = toMoney(targetBalance).minus(toMoney(current.balance));
    if (!delta.isZero()) {
      await prisma.accountAdjustment.create({
        data: { userId, accountId, amount: delta.toString() },
      });
    }
  }

  const fresh = await getDashboard(userId);
  const accountOut = fresh.accounts.find((a) => a.id === accountId);
  return {
    account: accountOut as AccountPublic,
    totalAvailable: fresh.totalAvailable,
  };
}

/**
 * Change la devise principale de l'espace utilisateur et l'applique de façon
 * cohérente à tous ses comptes standards (V1).
 */
export async function updateUserCurrency(
  userId: string,
  currency: Currency,
): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { currency } }),
    prisma.account.updateMany({ where: { userId }, data: { currency } }),
  ]);
}

