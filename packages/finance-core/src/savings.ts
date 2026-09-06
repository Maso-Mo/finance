import Decimal from 'decimal.js';
import { toMoney, type Money, type MoneyInput } from './money.js';

/**
 * ÉPARGNE MENSUELLE PLANIFIÉE (étape 10) — finance-core.
 *
 * ⚠ RÈGLE ABSOLUE : UN PLAN D'ÉPARGNE N'EST JAMAIS DE L'ARGENT.
 *  - il ne modifie AUCUN solde ni Total disponible : seul un vrai
 *    AccountTransfer vers le compte SAVINGS augmente le solde Épargne ;
 *  - une « contribution » au plan = le montant (hors frais) d'un
 *    AccountTransfer RÉEL vers SAVINGS, explicitement lié au plan.
 *
 * Cible d'un plan :
 *  - FIXED      : fixedAmount (positif, exact) ;
 *  - PERCENTAGE : TOUJOURS DÉRIVÉE = pourcentage des revenus RÉELLEMENT reçus
 *    du mois (Transactions INCOME actives). Ne se base JAMAIS sur un
 *    ExpectedIncome PENDING, un transfert, un ajustement ou une prévision.
 *
 * Arrondi monétaire centralisé : la cible PERCENTAGE est arrondie à 2
 * décimales (convention NUMERIC(20,2)), règle unique web + api + mobile.
 *
 * Fonctions pures : sans Prisma, PostgreSQL, Express ni React.
 */
export const SAVINGS_MODE_FIXED = 'FIXED';
export const SAVINGS_MODE_PERCENTAGE = 'PERCENTAGE';

/** Cible d'un plan FIXED : la valeur fixée, positive, exacte. */
export function savingsTargetFixed(fixedAmount: MoneyInput): Money {
  return toMoney(fixedAmount);
}

/**
 * Cible d'un plan PERCENTAGE :
 *   revenus réellement reçus du mois × pourcentage / 100,
 * arrondie à 2 décimales (jamais de flottant naïf).
 */
export function savingsPercentageTarget(
  eligibleIncome: MoneyInput,
  percentage: MoneyInput,
): Money {
  const income = toMoney(eligibleIncome);
  const percent = toMoney(percentage);
  if (percent.lte(0) || percent.gt(100)) {
    throw new RangeError('Savings percentage must be between 0 (exclusive) and 100.');
  }
  return income
    .mul(percent)
    .div(100)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Σ des contributions au plan = Σ des AccountTransfer.amount liés et ACTIFS. */
export function savingsContributionTotal(
  contributionAmounts: readonly MoneyInput[],
): Money {
  return contributionAmounts.reduce<Money>(
    (total, amount) => total.plus(toMoney(amount)),
    new Decimal(0),
  );
}

/**
 * Reste à épargner = cible − déjà contribué. Peut devenir négatif
 * (dépassement d'objectif) — la valeur métier n'est JAMAIS clampée à zéro.
 */
export function savingsRemaining(
  target: MoneyInput,
  contributed: MoneyInput,
): Money {
  return toMoney(target).minus(toMoney(contributed));
}

/** Statut DÉRIVÉ (jamais stocké) de la progression d'un plan. */
export type SavingsProgressStatus =
  | 'IN_PROGRESS'
  | 'REACHED'
  | 'NO_INCOME_YET';

/**
 * Statut simple dérivé :
 *  - PERCENTAGE avec aucun revenu reçu et rien encore épargné →
 *    'NO_INCOME_YET' (« en attente de revenus reçus ce mois-ci » — un
 *    affichage « objectif atteint » pour 0/0 serait trompeur) ;
 *  - sinon 'REACHED' dès que contribué >= cible ; sinon 'IN_PROGRESS'.
 */
export function savingsProgressStatus(options: {
  mode: string;
  target: MoneyInput;
  contributed: MoneyInput;
  eligibleIncome: MoneyInput;
}): SavingsProgressStatus {
  const { mode, target, contributed, eligibleIncome } = options;
  const contributedValue = toMoney(contributed);
  const targetValue = toMoney(target);

  if (
    mode === SAVINGS_MODE_PERCENTAGE &&
    toMoney(eligibleIncome).isZero() &&
    contributedValue.isZero()
  ) {
    return 'NO_INCOME_YET';
  }
  return contributedValue.gte(targetValue) ? 'REACHED' : 'IN_PROGRESS';
}
