import { prisma } from '../db.js';
import { ApiError } from '../http-error.js';
import { sumAvailableBalance, type BalanceEntry } from '@finance/finance-core';
import type { AccountPublic, Currency } from '@finance/shared-types';

/**
 * Service des comptes financiers V1.
 * Tous les accès sont filtrés par userId authentifié : un utilisateur ne peut
 * jamais lire/modifier un compte qui ne lui appartient pas.
 *
 * Représentation monétaire exacte : le Decimal Prisma est converti en chaîne
 * à la frontière (jamais de number flottant), puis les calculs de total
 * utilisent finance-core (decimal.js).
 */

type AccountRow = {
  id: string;
  type: string;
  currency: string;
  initialBalance: { toString(): string };
};

function toPublic(account: AccountRow): AccountPublic {
  return {
    id: account.id,
    type: account.type as AccountPublic['type'],
    currency: account.currency as AccountPublic['currency'],
    initialBalance: account.initialBalance.toString(),
  };
}

async function requireUserCurrency(userId: string): Promise<Currency> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currency: true },
  });
  if (!user) {
    throw new ApiError(401, 'User not found.');
  }
  return user.currency;
}

export async function getDashboard(userId: string): Promise<{
  currency: Currency;
  accounts: AccountPublic[];
  totalAvailable: string;
}> {
  const currency = await requireUserCurrency(userId);
  const rows = await prisma.account.findMany({
    where: { userId },
    orderBy: { type: 'asc' },
  });

  const entries: BalanceEntry[] = rows.map((row) => ({
    type: row.type,
    balance: row.initialBalance.toString(),
  }));
  const total = sumAvailableBalance(entries);

  return {
    currency,
    accounts: rows.map(toPublic),
    totalAvailable: total.toString(),
  };
}

export async function updateInitialBalance(
  userId: string,
  accountId: string,
  value: string,
): Promise<{ account: AccountPublic; totalAvailable: string }> {
  const result = await prisma.account.updateMany({
    where: { id: accountId, userId },
    data: { initialBalance: value },
  });
  if (result.count === 0) {
    // Ni trouvé ni autorisé (on ne divulgue pas l'existence d'un compte tiers).
    throw new ApiError(404, 'Account not found.');
  }

  const dashboard = await getDashboard(userId);
  const account = dashboard.accounts.find((a) => a.id === accountId);
  return { account: account as AccountPublic, totalAvailable: dashboard.totalAvailable };
}

/**
 * Change la devise principale de l'espace utilisateur et l'applique de façon
 * cohérente à tous ses comptes standards (V1 : aucun solde significatif).
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
