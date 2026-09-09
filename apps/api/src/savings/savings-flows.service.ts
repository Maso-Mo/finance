import { prisma } from '../db.js';
import { ApiError } from '../http-error.js';
import { getDashboard } from '../accounts/accounts.service.js';
import { toPublicTransfer } from '../transfers/transfers.service.js';
import { savingsPercentageTarget, toMoney } from '@finance/finance-core';
import type {
  AccountPublic,
  Currency,
  SavingsSuggestionConfirm,
  SavingsSuggestionConfirmResponse,
  SavingsSuggestionNextResponse,
  SavingsSuggestionPublic,
  SavingsWithdrawalCreate,
  SavingsWithdrawalMutationResponse,
} from '@finance/shared-types';
import { Prisma } from '../generated/prisma/client.js';

/**
 * FLUX ÉPARGNE COMPLETS (étape 10) :
 *  - PROPOSITIONS post-revenu réel (idempotentes : une par Transaction INCOME,
 *    « Ignorer » persistant) ;
 *  - RETRAIT réel de l'Épargne (jamais plus que le solde disponible).
 *
 * ⚠ Une proposition n'est JAMAIS de l'argent. Confirmer une proposition crée
 * EXACTEMENT UN AccountTransfer source → SAVINGS (lien plan éventuel) — jamais
 * de Transaction EXPENSE/INCOME parallèle, jamais de double comptage.
 */

export type TransactionLike = {
  id: string;
  amount: { toString(): string };
  description: string | null;
  occurredAt: Date | null;
  dateUnknown: boolean;
  accountUnknown: boolean;
  type: string;
  deletedAt: Date | null;
};

type SuggestionRow = {
  id: string;
  status: string;
  createdAt: Date;
  sourceAccountId: string | null;
  incomeTransactionId: string;
  incomeTransaction: TransactionLike;
};

/** Inclusions minimales d'une proposition pour sérialisation publique. */
const includeSuggestion = {
  incomeTransaction: {
    select: {
      id: true,
      amount: true,
      description: true,
      occurredAt: true,
      type: true,
      deletedAt: true,
      accountUnknown: true,
    },
  },
} as const;

/** « YYYY-MM-DD » d'un Date UTC neutre (midi UTC). */
function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Mois calendaire « YYYY-MM » du revenu (ou mois courant sans date). */
function incomeMonthKey(occurredAt: Date | null): string {
  if (occurredAt) {
    return occurredAt.toISOString().slice(0, 7);
  }
  return new Date().toISOString().slice(0, 7);
}

/**
 * Sérialisation publique d'une proposition : règle du mois du revenu, montant
 * proposé par défaut (FIXED / pourcentage × revenu / null sans plan) et source
 * probable (avec son solde COURANT).
 */
function toPublicSuggestion(
  row: SuggestionRow,
  accounts: AccountPublic[],
  plan: {
    mode: string;
    fixedAmount: { toString(): string } | null;
    percentage: { toString(): string } | null;
  } | null,
): SavingsSuggestionPublic {
  const income = row.incomeTransaction;
  const source = accounts.find(
    (account) => account.id === row.sourceAccountId,
  );

  let rule: SavingsSuggestionPublic['rule'] = null;
  let suggestedAmount: string | null = null;
  if (plan) {
    if (plan.mode === 'FIXED' && plan.fixedAmount) {
      rule = { mode: 'FIXED', fixedAmount: plan.fixedAmount.toString() };
      suggestedAmount = plan.fixedAmount.toString();
    } else if (plan.mode === 'PERCENTAGE' && plan.percentage) {
      rule = { mode: 'PERCENTAGE', percentage: plan.percentage.toString() };
      suggestedAmount = savingsPercentageTarget(
        income.amount.toString(),
        plan.percentage.toString(),
      ).toString();
    }
  }

  return {
    id: row.id,
    status: row.status as SavingsSuggestionPublic['status'],
    incomeTransactionId: income.id,
    income: {
      id: income.id,
      amount: income.amount.toString(),
      description: income.description,
      occurredAt: income.occurredAt ? dateKey(income.occurredAt) : null,
      // Pas de colonne `dateUnknown` sur Transaction : une date inconnue est
      // représentée par `occurredAt` null (aucune date inventée).
      dateUnknown: income.occurredAt === null,
      accountUnknown: income.accountUnknown,
    },
    sourceAccount: source
      ? { id: source.id, type: source.type, balance: source.balance }
      : null,
    rule,
    suggestedAmount,
    incomeMonth: incomeMonthKey(income.occurredAt),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Règle ACTIVE du mois (ou null). */
async function activePlanOfMonth(userId: string, month: string) {
  return prisma.monthlySavingsPlan.findFirst({
    where: { userId, month, deletedAt: null },
    select: { mode: true, fixedAmount: true, percentage: true },
  });
}

/**
 * Prochaine proposition PENDING (la plus ancienne d'abord), read-only.
 * Une proposition dont le revenu a été supprimé est ignorée (jamais affichée).
 */
export async function getNextSavingsSuggestion(
  userId: string,
): Promise<SavingsSuggestionNextResponse> {
  const row = await prisma.savingsSuggestion.findFirst({
    where: { userId, status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    include: includeSuggestion,
  });
  if (!row) {
    return { suggestion: null };
  }
  const income = row.incomeTransaction as unknown as TransactionLike;
  if (income.type !== 'INCOME' || income.deletedAt !== null) {
    // Revenu supprimé : la proposition n'est plus pertinente. Clôture propre.
    await prisma.savingsSuggestion.updateMany({
      where: { id: row.id, userId, status: 'PENDING' },
      data: { status: 'DISMISSED', resolvedAt: new Date() },
    });
    return { suggestion: null };
  }

  const [dashboard, plan] = await Promise.all([
    getDashboard(userId),
    activePlanOfMonth(userId, incomeMonthKey(income.occurredAt)),
  ]);

  return {
    suggestion: toPublicSuggestion(
      row as unknown as SuggestionRow,
      dashboard.accounts,
      plan as unknown as Parameters<typeof toPublicSuggestion>[2],
    ),
  };
}

/** « Ignorer » : la décision persiste (reload / re-login / retry). */
export async function dismissSavingsSuggestion(
  userId: string,
  suggestionId: string,
): Promise<SavingsSuggestionPublic> {
  const result = await prisma.savingsSuggestion.updateMany({
    where: { id: suggestionId, userId, status: 'PENDING' },
    data: { status: 'DISMISSED', resolvedAt: new Date() },
  });
  if (result.count !== 1) {
    throw new ApiError(409, 'This savings suggestion is not pending anymore.');
  }
  const row = await prisma.savingsSuggestion.findUniqueOrThrow({
    where: { id: suggestionId },
    include: includeSuggestion,
  });
  const dashboard = await getDashboard(userId);
  const plan = await activePlanOfMonth(
    userId,
    incomeMonthKey((row.incomeTransaction as unknown as TransactionLike).occurredAt),
  );
  return toPublicSuggestion(
    row as unknown as SuggestionRow,
    dashboard.accounts,
    plan as unknown as Parameters<typeof toPublicSuggestion>[2],
  );
}

/**
 * Confirme la proposition avec un montant : crée EXACTEMENT UN AccountTransfer
 * source → SAVINGS (jamais de Transaction EXPENSE/INCOME). Si un plan ACTIF
 * existe pour le mois du revenu, le Transfer est aussi lié au plan via une
 * SavingsContribution (le Transfer reste la source de vérité : aucun second
 * mouvement). ATOMIQUE et idempotent : la contrainte PENDING → CONFIRMED
 * garantit qu'un double-clic / retry ne crée jamais deux transferts.
 */
export async function confirmSavingsSuggestion(
  userId: string,
  suggestionId: string,
  input: SavingsSuggestionConfirm,
): Promise<SavingsSuggestionConfirmResponse> {
  // Plafond : jamais un solde source négatif. (Lecture avant transaction : la
  // création reste sérialisée par le claim PENDING → CONFIRMED ci-dessous.)
  const dashboard = await getDashboard(userId);

  const transfer = await prisma.$transaction(async (tx) => {
    const suggestion = await tx.savingsSuggestion.findFirst({
      where: { id: suggestionId, userId },
      select: {
        id: true,
        status: true,
        sourceAccountId: true,
        incomeTransaction: {
          select: {
            id: true,
            amount: true,
            occurredAt: true,
            type: true,
            deletedAt: true,
          },
        },
      },
    });
    if (!suggestion) {
      throw new ApiError(404, 'Savings suggestion not found.');
    }
    if (suggestion.status !== 'PENDING') {
      throw new ApiError(
        409,
        'This savings suggestion is not pending anymore (status: ' +
          suggestion.status +
          ').',
      );
    }
    const income = suggestion.incomeTransaction;
    if (!income || income.type !== 'INCOME' || income.deletedAt !== null) {
      throw new ApiError(
        409,
        'The income that triggered this suggestion is no longer active.',
      );
    }

    // Source : celle connue (allocation unique du revenu) ou choix explicite.
    let sourceAccountId = suggestion.sourceAccountId;
    if (input.sourceAccountId) {
      if (sourceAccountId && input.sourceAccountId !== sourceAccountId) {
        throw new ApiError(
          400,
          'The chosen source differs from the account that received this income.',
        );
      }
      sourceAccountId = input.sourceAccountId;
    }
    if (!sourceAccountId) {
      throw new ApiError(
        400,
        'Choose the account the savings come from (this income has no single known account).',
      );
    }

    const [user, savings, source] = await Promise.all([
      tx.user.findUnique({
        where: { id: userId },
        select: { currency: true },
      }),
      tx.account.findFirst({
        where: { userId, type: 'SAVINGS' },
        select: { id: true, currency: true },
      }),
      tx.account.findFirst({
        where: { id: sourceAccountId, userId },
        select: { id: true, type: true, currency: true },
      }),
    ]);
    if (!user) throw new ApiError(401, 'User not found.');
    if (!savings) throw new ApiError(404, 'Savings account not found.');
    if (!source) throw new ApiError(404, 'Source account not found.');
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

    const amount = toMoney(input.amount);
    if (amount.lte(0)) {
      throw new ApiError(400, 'The amount must be strictly positive.');
    }
    const sourceAvailable = dashboard.accounts.find(
      (account) => account.id === sourceAccountId,
    )?.balance;
    if (sourceAvailable !== undefined && amount.gt(sourceAvailable)) {
      throw new ApiError(
        400,
        'The amount exceeds the money actually available on the source account.',
      );
    }

    // Claim atomique PENDING → CONFIRMED AVANT toute création : la perdante
    // d'un double-clic voit status ≠ PENDING et ne crée AUCUN transfert.
    const claim = await tx.savingsSuggestion.updateMany({
      where: { id: suggestionId, userId, status: 'PENDING' },
      data: { status: 'CONFIRMED', resolvedAt: new Date() },
    });
    if (claim.count !== 1) {
      throw new ApiError(409, 'This savings suggestion was already confirmed.');
    }

    const occurredAtDate = income.occurredAt;
    const transfer = await tx.accountTransfer.create({
      data: {
        userId,
        sourceAccountId,
        destinationAccountId: savings.id,
        amount: input.amount,
        feeAmount: '0',
        currency: user.currency as Currency,
        occurredAt: occurredAtDate ? occurredAtDate : null,
        dateUnknown: occurredAtDate ? false : true,
        description: 'Épargne',
      },
      include: {
        sourceAccount: { select: { id: true, type: true } },
        destinationAccount: { select: { id: true, type: true } },
      },
    });

    // Lien éventuel au plan ACTIF du mois du revenu (jamais un 2e mouvement).
    const month = incomeMonthKey(income.occurredAt);
    const plan = await tx.monthlySavingsPlan.findFirst({
      where: { userId, month, deletedAt: null },
      select: { id: true },
    });
    if (plan) {
      await tx.savingsContribution.create({
        data: { savingsPlanId: plan.id, transferId: transfer.id },
      });
    }

    return transfer;
  });

  const [row, full] = await Promise.all([
    prisma.savingsSuggestion.findUniqueOrThrow({
      where: { id: suggestionId },
      include: includeSuggestion,
    }),
    prisma.accountTransfer.findUniqueOrThrow({
      where: { id: transfer.id },
      include: {
        sourceAccount: { select: { id: true, type: true } },
        destinationAccount: { select: { id: true, type: true } },
      },
    }),
  ]);
  const refreshedDashboard = await getDashboard(userId);
  const plan = await activePlanOfMonth(
    userId,
    incomeMonthKey((row.incomeTransaction as unknown as TransactionLike).occurredAt),
  );

  return {
    suggestion: toPublicSuggestion(
      row as unknown as SuggestionRow,
      refreshedDashboard.accounts,
      plan as unknown as Parameters<typeof toPublicSuggestion>[2],
    ),
    transfer: toPublicTransfer(
      full as unknown as Parameters<typeof toPublicTransfer>[0],
    ),
  };
}

/**
 * RETRAIT RÉEL de l'Épargne : un AccountTransfer SAVINGS → destination.
 *  - montant strictement positif ;
 *  - jamais plus que le solde Épargne disponible (montant + frais) ;
 *  - destination possédée et ≠ Épargne ;
 *  - aucune écriture avant confirmation explicite (cette fonction n'est
 *    appelée que par la route de confirmation du formulaire).
 */
export async function withdrawFromSavings(
  userId: string,
  input: SavingsWithdrawalCreate,
): Promise<SavingsWithdrawalMutationResponse> {
  const dashboard = await getDashboard(userId);
  const savings = dashboard.accounts.find(
    (account) => account.type === 'SAVINGS',
  );
  if (!savings) {
    throw new ApiError(404, 'Savings account not found.');
  }

  const fee = toMoney(input.feeAmount ?? '0');
  const amount = toMoney(input.amount);
  const total = amount.plus(fee);
  if (total.gt(savings.balance)) {
    throw new ApiError(
      400,
      'The withdrawal exceeds the savings balance actually available.',
    );
  }

  const destination = dashboard.accounts.find(
    (account) => account.id === input.destinationAccountId,
  );
  if (!destination) {
    throw new ApiError(404, 'Destination account not found.');
  }
  if (destination.type === 'SAVINGS') {
    throw new ApiError(
      400,
      'The destination account must differ from savings.',
    );
  }
  if (destination.currency !== savings.currency) {
    throw new ApiError(
      400,
      'Savings accounts must share the user’s main currency (V1).',
    );
  }

  const description =
    input.description && input.description.trim()
      ? input.description.trim()
      : null;
  const transfer = await prisma.accountTransfer.create({
    data: {
      userId,
      sourceAccountId: savings.id,
      destinationAccountId: input.destinationAccountId,
      amount: input.amount,
      feeAmount: input.feeAmount ?? '0',
      currency: destination.currency as Currency,
      occurredAt: input.occurredAt
        ? new Date(`${input.occurredAt}T12:00:00.000Z`)
        : null,
      dateUnknown: input.dateUnknown ?? false,
      description,
    },
    include: {
      sourceAccount: { select: { id: true, type: true } },
      destinationAccount: { select: { id: true, type: true } },
    },
  });

  return {
    transfer: toPublicTransfer(
      transfer as unknown as Parameters<typeof toPublicTransfer>[0],
    ),
  };
}

/**
 * Mémorise une proposition PENDING pour une Transaction INCOME réellement
 * reçue (appelé atomiquement à la création de la transaction). Une même
 * transaction ne peut jamais produire qu'UNE proposition (unique en base) :
 * rechargement / re-login / retry réseau ne créent AUCUN doublon.
 *
 * `sourceAccountId` = allocation unique du revenu (source connue) ou null
 * (compte inconnu / multi-comptes → l'utilisateur choisira à la confirmation).
 */
export async function queueSavingsSuggestion(
  tx: Prisma.TransactionClient,
  userId: string,
  incomeTransactionId: string,
  sourceAccountId: string | null,
): Promise<void> {
  await tx.savingsSuggestion.create({
    data: { userId, incomeTransactionId, sourceAccountId },
  });
}




