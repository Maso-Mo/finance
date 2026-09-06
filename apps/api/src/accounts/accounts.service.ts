import { prisma } from '../db.js';
import { ApiError } from '../http-error.js';
import {
  currentBalance,
  sumAvailableBalance,
  toMoney,
  transferNetFromTotals,
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
 *   + ajustements de solde (AccountAdjustment)
 *   + transferts internes actifs (entrants − sortants, fee inclus sur la
 *   source) — étape 9 (AccountTransfer).
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
  groups: { accountId: string | null; sum: string | null }[],
): Map<string, Money> {
  const map = new Map<string, Money>();
  for (const group of groups) {
    if (group.accountId !== null) {
      map.set(group.accountId, toMoney(group.sum ?? '0'));
    }
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
  // dépenses actives, ajustements (déjà signés), transferts actifs sortants
  // (débit = amount + fee) et entrants (crédit = amount). Agrégation groupBy :
  // on ne charge jamais tout l'historique des transferts en mémoire.
  // Dettes (étape 11) : règlements STANDARD actifs — crédités (+amount pour
  // OWED_TO_ME) et payés (−amount pour I_OWE). Les règlements de type AVANCE
  // sont EXCLUS ici : leur +compte est porté par la Transaction INCOME liée
  // (comptée dans `incomeGroups` ci-dessus), jamais par le règlement.
  const [
    incomeGroups,
    expenseGroups,
    adjustmentGroups,
    outgoingTransferGroups,
    incomingTransferGroups,
    repaymentsReceivedGroups,
    repaymentsPaidGroups,
  ] = await Promise.all([
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
    prisma.accountTransfer.groupBy({
      by: ['sourceAccountId'],
      where: { userId, deletedAt: null },
      _sum: { amount: true, feeAmount: true },
    }),
    prisma.accountTransfer.groupBy({
      by: ['destinationAccountId'],
      where: { userId, deletedAt: null },
      _sum: { amount: true },
    }),
    prisma.debtSettlement.groupBy({
      by: ['accountId'],
      where: {
        userId,
        deletedAt: null,
        accountId: { not: null },
        debt: {
          userId,
          deletedAt: null,
          kind: 'STANDARD',
          direction: 'OWED_TO_ME',
        },
      },
      _sum: { amount: true },
    }),
    prisma.debtSettlement.groupBy({
      by: ['accountId'],
      where: {
        userId,
        deletedAt: null,
        accountId: { not: null },
        debt: { userId, deletedAt: null, kind: 'STANDARD', direction: 'I_OWE' },
      },
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
  // Règlements de dettes STANDARD actifs : reçus (+amount) et payés (−amount).
  const repaymentsReceived = indexSum(
    repaymentsReceivedGroups.map((g) => ({
      accountId: g.accountId,
      sum: g._sum.amount?.toString() ?? '0',
    })),
  );
  const repaymentsPaid = indexSum(
    repaymentsPaidGroups.map((g) => ({
      accountId: g.accountId,
      sum: g._sum.amount?.toString() ?? '0',
    })),
  );

  // Délta agrégé des transferts actifs par compte (finance-core) :
  //  - sortant : le compte a été débité de Σ(amount + fee) ;
  //  - entrant : le compte a été crédité de Σ(amount).
  const outgoingDebits = new Map<string, Money>();
  for (const group of outgoingTransferGroups) {
    outgoingDebits.set(
      group.sourceAccountId,
      toMoney(group._sum.amount?.toString() ?? '0').plus(
        toMoney(group._sum.feeAmount?.toString() ?? '0'),
      ),
    );
  }
  const incomingCredits = indexSum(
    incomingTransferGroups.map((g) => ({
      accountId: g.destinationAccountId,
      sum: g._sum.amount?.toString() ?? '0',
    })),
  );

  const accounts: AccountPublic[] = rows.map((row) => {
    const starting = toMoney(row.initialBalance.toString());
    const net = (incomes.get(row.id) ?? toMoney('0')).minus(
      expenses.get(row.id) ?? toMoney('0'),
    );
    const transferNet = transferNetFromTotals(
      outgoingDebits.get(row.id) ?? '0',
      incomingCredits.get(row.id) ?? '0',
    );
    const repaymentsNet = (repaymentsReceived.get(row.id) ?? toMoney('0')).minus(
      repaymentsPaid.get(row.id) ?? toMoney('0'),
    );
    // currentBalance (initial + journal + ajustements) puis deltas transferts
    // et règlements de dettes (étape 11).
    const balance = currentBalance(
      starting,
      net,
      adjustments.get(row.id) ?? toMoney('0'),
    )
      .plus(transferNet)
      .plus(repaymentsNet);
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

  const [activeAllocations, adjustmentCount, activeTransferCount, activeSettlementCount] =
    await Promise.all([
      prisma.transactionAccountAllocation.count({
        where: { accountId, transaction: { userId, deletedAt: null } },
      }),
      prisma.accountAdjustment.count({ where: { accountId, userId } }),
      prisma.accountTransfer.count({
        where: {
          userId,
          deletedAt: null,
          OR: [
            { sourceAccountId: accountId },
            { destinationAccountId: accountId },
          ],
        },
      }),
      // Règlements de dettes actifs touchant CE compte (étape 11) : un solde
      // issu d'un remboursement ne redevient jamais un solde de départ.
      prisma.debtSettlement.count({
        where: { accountId, userId, deletedAt: null },
      }),
    ]);
  // Un « mouvement » = transaction active, transfert actif, règlement de dette
  // actif ou ajustement déjà présent. Dès qu'il existe un mouvement, le solde
  // de départ ne se modifie plus : la déclaration d'un solde réel crée un
  // AccountAdjustment.
  const hasMovement =
    activeAllocations > 0 ||
    adjustmentCount > 0 ||
    activeTransferCount > 0 ||
    activeSettlementCount > 0;

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

