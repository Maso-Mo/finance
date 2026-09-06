import { prisma } from '../db.js';
import { ApiError } from '../http-error.js';
import { getDashboard } from '../accounts/accounts.service.js';
import { toPublicTransfer } from '../transfers/transfers.service.js';
import {
  savingsPercentageTarget,
  savingsProgressStatus,
  savingsRemaining,
  savingsTargetFixed,
  toMoney,
} from '@finance/finance-core';
import type {
  Currency,
  SavingsContributionCreate,
  SavingsContributionMutationResponse,
  SavingsContributionPublic,
  SavingsMonthView,
  SavingsPlanCreate,
  SavingsPlanPublic,
  SavingsPlanUpdate,
  SavingsPlanUpsert,
} from '@finance/shared-types';
import { addMonths, keyToMonth, monthToKey } from '@finance/finance-core';
import { Prisma } from '../generated/prisma/client.js';

/**
 * Service des PLANS D'ÉPARGNE MENSUELS (étape 10).
 *
 * ⚠ RÈGLE ABSOLUE : UN PLAN D'ÉPARGNE N'EST JAMAIS DE L'ARGENT.
 *  - un plan (même PERCENTAGE avec une cible élevée) ne modifie AUCUN solde,
 *    AUCUN Total disponible, AUCUNE Transaction, AUCUN budget ni forecast ;
 *  - le compte Épargne n'augmente QUE lorsqu'un vrai AccountTransfer vers
 *    SAVINGS est enregistré (création d'une SavingsContribution ATOMIQUE qui
 *    lie le Transfer au plan, ou transfert volontaire depuis la page
 *    transferts — jamais attribué silencieusement à un plan) ;
 *  - la cible PERCENTAGE est TOUJOURS DÉRIVÉE en lecture des Transactions
 *    INCOME actives du mois (jamais d'un ExpectedIncome PENDING, d'un
 *    transfert ou d'un ajustement) ;
 *  - GET STRICTEMENT read-only (aucune écriture cachée) ;
 *  - la suppression d'un plan (logique) n'annule JAMAIS ses Transfers réels.
 */

/** Forme d'un Transfer lié suffisante pour la sérialisation publique. */
type LinkedTransfer = {
  id: string;
  amount: { toString(): string };
  feeAmount: { toString(): string };
  currency: string;
  occurredAt: Date | null;
  dateUnknown: boolean;
  description: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  sourceAccount: { id: string; type: string };
  destinationAccount: { id: string; type: string };
};

type ContributionRow = {
  id: string;
  createdAt: Date;
  transfer: LinkedTransfer;
};

/** Sérialisation d'une contribution (le Transfer reste la source de vérité). */
export function toPublicContribution(
  row: ContributionRow,
): SavingsContributionPublic {
  return {
    id: row.id,
    transfer: toPublicTransfer(
      row.transfer as unknown as Parameters<typeof toPublicTransfer>[0],
    ),
    createdAt: row.createdAt.toISOString(),
  };
}

type PlanRow = {
  id: string;
  month: string;
  mode: string;
  fixedAmount: { toString(): string } | null;
  percentage: { toString(): string } | null;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
};

export function toPublicPlan(row: PlanRow): SavingsPlanPublic {
  return {
    id: row.id,
    month: row.month,
    mode: row.mode as SavingsPlanPublic['mode'],
    fixedAmount: row.fixedAmount ? row.fixedAmount.toString() : null,
    percentage: row.percentage ? row.percentage.toString() : null,
    currency: row.currency as Currency,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Inclusions d'un transfert lié (source + destination typées). */
const includeLinkedTransfer = {
  sourceAccount: { select: { id: true, type: true } },
  destinationAccount: { select: { id: true, type: true } },
} as const;

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
 * Revenus RÉELLEMENT reçus d'un mois : somme des Transactions INCOME ACTIVES
 * (`deletedAt` null) dont `occurredAt` tombe dans le mois. Un revenu dont la
 * date réelle est inconnue (`occurredAt` null) est EXCLU : impossible de
 * l'affecter de façon fiable à un mois. Jamais d'ExpectedIncome PENDING, de
 * Transfer ou d'Ajustement (les Transfer ne sont pas des revenus).
 */
async function monthlyEligibleIncome(
  userId: string,
  monthKey: string,
): Promise<string> {
  const { start, end } = monthBoundaries(monthKey);
  const rows = await prisma.transaction.aggregate({
    where: {
      userId,
      type: 'INCOME',
      deletedAt: null,
      occurredAt: { gte: start, lt: end },
    },
    _sum: { amount: true },
  });
  return (rows._sum.amount ?? '0').toString();
}
/**
 * Vue analytique d'un mois (GET read-only) : plan ACTIF éventuel + cible et
 * contribution DÉRIVÉES + solde réel du compte Épargne. Aucune écriture.
 */
export async function getSavingsMonthView(
  userId: string,
  monthKey: string,
): Promise<SavingsMonthView> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currency: true },
  });
  if (!user) {
    throw new ApiError(401, 'User not found.');
  }

  const [dashboard, plan] = await Promise.all([
    getDashboard(userId),
    prisma.monthlySavingsPlan.findFirst({
      where: { userId, month: monthKey, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      include: {
        contributions: {
          include: { transfer: { include: includeLinkedTransfer } },
        },
      },
    }),
  ]);

  const savingsAccount = dashboard.accounts.find((a) => a.type === 'SAVINGS');

  const base: SavingsMonthView = {
    month: monthKey,
    currency: user.currency as Currency,
    savingsAccount: savingsAccount
      ? { id: savingsAccount.id, balance: savingsAccount.balance }
      : null,
    plan: null,
    target: null,
    eligibleIncome: null,
    contributed: null,
    remaining: null,
    progress: null,
    contributions: [],
  };

  if (!plan) {
    return base;
  }

  // Cible DÉRIVÉE selon le mode (jamais stockée pour PERCENTAGE).
  let target: ReturnType<typeof toMoney>;
  let eligibleIncome: string | null = null;
  if (plan.mode === 'PERCENTAGE') {
    eligibleIncome = await monthlyEligibleIncome(userId, monthKey);
    const percentage = plan.percentage?.toString();
    if (!percentage) {
      throw new ApiError(500, 'Invalid PERCENTAGE savings plan (missing percentage).');
    }
    target = savingsPercentageTarget(eligibleIncome, percentage);
  } else {
    const fixedAmount = plan.fixedAmount?.toString();
    if (!fixedAmount) {
      throw new ApiError(500, 'Invalid FIXED savings plan (missing fixed amount).');
    }
    target = savingsTargetFixed(fixedAmount);
  }

  // Contributions ACTIVES uniquement (un Transfer soft-deleted cesse de
  // compter dans la progression — sa ligne reste traçable en base).
  const active = plan.contributions.filter((item) => item.transfer.deletedAt === null);
  const contributed = active.reduce(
    (total, item) => total.plus(toMoney(item.transfer.amount.toString())),
    toMoney('0'),
  );
  const remaining = savingsRemaining(target, contributed);

  return {
    month: monthKey,
    currency: user.currency as Currency,
    savingsAccount: savingsAccount
      ? { id: savingsAccount.id, balance: savingsAccount.balance }
      : null,
    plan: toPublicPlan(plan as unknown as PlanRow),
    target: target.toString(),
    eligibleIncome,
    contributed: contributed.toString(),
    remaining: remaining.toString(),
    progress: savingsProgressStatus({
      mode: plan.mode,
      target,
      contributed,
      eligibleIncome: eligibleIncome ?? '0',
    }),
    contributions: active.map((item) =>
      toPublicContribution(item as unknown as ContributionRow),
    ),
  };
}


/** Champs normalisés d'un plan (mode exclusif déjà validé par le schéma Zod). */
function planData(input: SavingsPlanUpsert) {
  return {
    month: input.month,
    mode: input.mode,
    fixedAmount: input.mode === 'FIXED' ? (input.fixedAmount as string) : null,
    percentage:
      input.mode === 'PERCENTAGE' ? (input.percentage as string) : null,
  };
}

/**
 * Crée un plan ACTIF. Garantie au niveau BASE : un seul plan actif par
 * (userId, month) grâce à l'index UNIQUE PARTIEL (userId, month) WHERE
 * deletedAt IS NULL — un doublon concurrent lève P2002 et devient un 409.
 */
export async function createSavingsPlan(
  userId: string,
  input: SavingsPlanCreate,
): Promise<SavingsPlanPublic> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currency: true },
  });
  if (!user) {
    throw new ApiError(401, 'User not found.');
  }
  try {
    const row = await prisma.monthlySavingsPlan.create({
      data: {
        ...planData(input),
        userId,
        currency: user.currency as Currency,
      },
    });
    return toPublicPlan(row as unknown as PlanRow);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ApiError(409, 'A savings plan already exists for this month.');
    }
    throw error;
  }
}

/**
 * Modifie un plan ACTIF (mode + cible). Le MOIS ne peut pas être déplacé ici ;
 * aucune modification n'altère jamais les Transfers réels déjà enregistrés.
 */
export async function updateSavingsPlan(
  userId: string,
  planId: string,
  input: SavingsPlanUpdate,
): Promise<SavingsPlanPublic> {
  const existing = await prisma.monthlySavingsPlan.findFirst({
    where: { id: planId, userId },
    select: { id: true, deletedAt: true, month: true },
  });
  if (!existing) {
    throw new ApiError(404, 'Savings plan not found.');
  }
  if (existing.deletedAt) {
    throw new ApiError(409, 'A deleted savings plan cannot be modified.');
  }
  if (input.month !== existing.month) {
    throw new ApiError(400, 'The month of a savings plan cannot be changed.');
  }
  const row = await prisma.monthlySavingsPlan.update({
    where: { id: planId },
    data: planData(input),
  });
  return toPublicPlan(row as unknown as PlanRow);
}

/**
 * Supprime LOGIQUEMENT un plan : il disparaît de l'UI, mais AUCUN AccountTransfer
 * réel n'est annulé (l'argent a réellement été transféré). Les contributions
 * restent traçables en base via le Transfer.
 */
export async function deleteSavingsPlan(
  userId: string,
  planId: string,
): Promise<void> {
  const result = await prisma.monthlySavingsPlan.updateMany({
    where: { id: planId, userId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  if (result.count === 0) {
    throw new ApiError(404, 'Savings plan not found.');
  }
}

/**
 * Enregistre une contribution RÉELLE à un plan : opération ATOMIQUE qui, dans
 * UNE transaction Prisma, (1) vérifie le plan ACTIF + ownership, (2) crée un
 * vrai AccountTransfer vers SAVINGS (source distincte, même devise), puis
 * (3) crée la SavingsContribution qui lie ce Transfer au plan.
 *
 * Jamais de Transaction EXPENSE/INCOME créée. Jamais de contribution
 * « orpheline » ni de Transfer sans lien si une étape échoue (rollback).
 */
export async function createSavingsContribution(
  userId: string,
  planId: string,
  input: SavingsContributionCreate,
): Promise<SavingsContributionMutationResponse> {
  const transfer = await prisma.$transaction(async (tx) => {
    const plan = await tx.monthlySavingsPlan.findFirst({
      where: { id: planId, userId, deletedAt: null },
      select: { id: true },
    });
    if (!plan) {
      throw new ApiError(404, 'Savings plan not found.');
    }

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { currency: true },
    });
    if (!user) {
      throw new ApiError(401, 'User not found.');
    }

    const [savings, source] = await Promise.all([
      tx.account.findFirst({
        where: { userId, type: 'SAVINGS' },
        select: { id: true, type: true, currency: true },
      }),
      tx.account.findFirst({
        where: { id: input.sourceAccountId, userId },
        select: { id: true, type: true, currency: true },
      }),
    ]);
    if (!savings) {
      throw new ApiError(404, 'Savings account not found.');
    }
    if (!source) {
      // Ni trouvé ni autorisé : réponse générique sans fuite d'existence.
      throw new ApiError(404, 'Source account not found.');
    }
    if (source.type === 'SAVINGS') {
      throw new ApiError(400, 'The source account must differ from savings.');
    }
    if (
      source.currency !== user.currency ||
      savings.currency !== user.currency
    ) {
      throw new ApiError(
        400,
        'Savings accounts must share the user’s main currency (V1).',
      );
    }

    // Le Transfer reste la SOURCE DE VÉRITÉ du mouvement réel (mêmes règles
    // que l'étape 9 : montant crédité sur la destination, frais en plus sur
    // la source, date réelle OU « je ne sais plus »).
    const description =
      input.description && input.description.trim()
        ? input.description.trim()
        : null;
    const transfer = await tx.accountTransfer.create({
      data: {
        userId,
        sourceAccountId: input.sourceAccountId,
        destinationAccountId: savings.id,
        amount: input.amount,
        feeAmount: input.feeAmount ?? '0',
        currency: user.currency as Currency,
        occurredAt: input.occurredAt
          ? new Date(`${input.occurredAt}T12:00:00.000Z`)
          : null,
        dateUnknown: input.dateUnknown ?? false,
        description,
      },
      include: includeLinkedTransfer,
    });

    await tx.savingsContribution.create({
      data: { savingsPlanId: planId, transferId: transfer.id },
    });

    return transfer;
  });

  const contributionRow = await prisma.savingsContribution.findUniqueOrThrow({
    where: { transferId: transfer.id },
    include: { transfer: { include: includeLinkedTransfer } },
  });

  return {
    contribution: toPublicContribution(
      contributionRow as unknown as ContributionRow,
    ),
  };
}
