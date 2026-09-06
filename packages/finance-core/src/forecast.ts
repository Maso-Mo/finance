import Decimal from 'decimal.js';
import { toMoney, type Money, type MoneyInput } from './money.js';

/**
 * PRÉVISION FINANCIÈRE DE FIN DE MOIS (étape 8.1) — finance-core.
 *
 * ⚠ Distinction STRICTE avec la prévision de DÉPENSES (budget.ts /
 * `spendingForecast`) :
 *  - `spendingForecast`  = projection statistique des DÉPENSES RÉELLES du mois
 *    (moyenne quotidienne × jours), indépendante des comptes ;
 *  - les fonctions ci-dessous calculent la PRÉVISION DE DISPONIBLE EN FIN DE
 *    MOIS : une prévision de SOLDE, qui combine le réel ET les engagements/
 *    revenus futurs encore PENDING.
 *
 * Règles absolues (toutes les fonctions sont PURES, sans Prisma/Express/React) :
 *  - une PlannedExpense PENDING encore due à l'horizon est une SORTIE prévue ;
 *    une PlannedExpense PAID a déjà créé une vraie Transaction EXPENSE (déjà
 *    dans `availableToday`) : on ne la soustrait JAMAIS une seconde fois ;
 *  - un ExpectedIncome CONFIRMED PENDING attendu à l'horizon est une ENTRÉE
 *    prévue ; un ExpectedIncome RECEIVED a déjà créé une vraie Transaction
 *    INCOME (déjà dans `availableToday`) : on ne l'ajoute JAMAIS deux fois ;
 *  - un ExpectedIncome UNCERTAIN (même PENDING) n'entre JAMAIS dans la
 *    prévision principale : il est exposé séparément (`uncertainIncomePotential`),
 *    sans jamais être présenté comme garanti.
 *
 * Formule V1 (mois COURANT uniquement, `today` injecté) :
 *   monthEndAvailableForecast =
 *     availableToday - pendingPlannedExpensesTotal + confirmedExpectedIncomeTotal
 *
 * Le résultat peut être NÉGATIF et n'est JAMAIS clampé à zéro.
 */

/** Ligne minimale d'une PlannedExpense pour le calcul (indépendante de Prisma). */
export interface PlannedExpenseForecastLike {
  /** 'PENDING' | 'PAID' | 'CANCELED' | 'SKIPPED'. */
  status: string;
  /** Jour calendaire « YYYY-MM-DD » de l'échéance. */
  dueDate: string;
  amount: MoneyInput;
}

/** Ligne minimale d'un ExpectedIncome pour le calcul (indépendante de Prisma). */
export interface ExpectedIncomeForecastLike {
  /** 'CONFIRMED' | 'UNCERTAIN'. */
  certainty: string;
  /** 'PENDING' | 'RECEIVED' | 'CANCELED'. */
  status: string;
  /** Une SEULE forme est active (invariant métier) : date exacte OU plage. */
  expectedDate?: string | null;
  windowEnd?: string | null;
  amount: MoneyInput;
}

/**
 * Dépenses futures RESTANT À PAYER à l'horizon `monthEndDate` (inclus) :
 * Σ des montants des lignes PENDING dont `dueDate <= monthEndDate`.
 *  - PAID / CANCELED / SKIPPED sont exclus (leur sortie est déjà réglée,
 *    annulée ou explicitement ignorée) ;
 *  - une échéance PENDING en RETARD (dueDate passée) reste une obligation non
 *    résolue : elle est donc bien incluse tant qu'elle est due à l'horizon.
 */
export function pendingPlannedExpensesTotal(
  entries: readonly PlannedExpenseForecastLike[],
  monthEndDate: string,
): Money {
  return entries.reduce<Money>((total, entry) => {
    if (entry.status !== 'PENDING' || entry.dueDate > monthEndDate) {
      return total;
    }
    return total.plus(toMoney(entry.amount));
  }, new Decimal(0));
}

/**
 * Un ExpectedIncome PENDING est-il attendu AU PLUS TARD à `monthEndDate` ?
 *  - date EXACTE → expectedDate <= monthEndDate ;
 *  - PLAGE       → on utilise la borne de fin windowEnd (jamais une date
 *    arbitraire de la plage) : windowEnd <= monthEndDate.
 * Un revenu dont la fenêtre peut légalement déborder après le mois n'est pas
 * considéré comme garanti avant la fin du mois.
 */
function incomeArrivesByMonthEnd(
  entry: ExpectedIncomeForecastLike,
  monthEndDate: string,
): boolean {
  if (entry.status !== 'PENDING') {
    return false;
  }
  if (entry.expectedDate != null && entry.expectedDate <= monthEndDate) {
    return true;
  }
  if (entry.windowEnd != null && entry.windowEnd <= monthEndDate) {
    return true;
  }
  return false;
}

/** Totaux attendus à l'horizon, séparés par CERTITUDE (toujours montants positifs). */
export interface ExpectedIncomeTotalsByMonthEnd {
  /** Σ des ExpectedIncome CONFIRMED PENDING attendus à l'horizon. */
  confirmed: Money;
  /** Σ des ExpectedIncome UNCERTAIN PENDING attendus à l'horizon (potentiel, non garanti). */
  uncertain: Money;
}

/**
 * Répartit les revenus futurs PENDING attendus à l'horizon `monthEndDate` :
 *  - CONFIRMED → dans `confirmed` (entre dans la prévision principale) ;
 *  - UNCERTAIN → dans `uncertain` (potentiel séparé, JAMAIS dans la prévision).
 * RECEIVED et CANCELED sont toujours exclus (déjà reflétés ou annulés).
 */
export function expectedIncomeTotalsByMonthEnd(
  entries: readonly ExpectedIncomeForecastLike[],
  monthEndDate: string,
): ExpectedIncomeTotalsByMonthEnd {
  return entries.reduce<ExpectedIncomeTotalsByMonthEnd>(
    (totals, entry) => {
      if (!incomeArrivesByMonthEnd(entry, monthEndDate)) {
        return totals;
      }
      const value = toMoney(entry.amount);
      if (entry.certainty === 'CONFIRMED') {
        return { confirmed: totals.confirmed.plus(value), uncertain: totals.uncertain };
      }
      return { confirmed: totals.confirmed, uncertain: totals.uncertain.plus(value) };
    },
    { confirmed: new Decimal(0), uncertain: new Decimal(0) },
  );
}

/** Entrées pures de la formule principale. */
export interface MonthEndAvailableForecastInput {
  /** Total disponible ACTUEL (Épargne exclue), toujours dérivé du ledger. */
  availableToday: MoneyInput;
  /** Σ des PlannedExpense PENDING dues à l'horizon (sorties futures). */
  pendingPlannedExpensesTotal: MoneyInput;
  /** Σ des ExpectedIncome CONFIRMED PENDING attendus à l'horizon. */
  confirmedExpectedIncomeTotal: MoneyInput;
}


/**
 * PRÉVISION DE DISPONIBLE EN FIN DE MOIS — formule V1 exacte (decimal.js) :
 *   availableToday − pendingPlannedExpensesTotal + confirmedExpectedIncomeTotal
 * Le résultat peut être NÉGATIF ; il n'est JAMAIS clampé à zéro.
 */
export function monthEndAvailableForecast(
  input: MonthEndAvailableForecastInput,
): Money {
  return toMoney(input.availableToday)
    .minus(toMoney(input.pendingPlannedExpensesTotal))
    .plus(toMoney(input.confirmedExpectedIncomeTotal));
}

/** Entrées du breakdown complet (formule + revenus incertains séparés). */
export interface MonthEndFinancialBreakdownInput extends MonthEndAvailableForecastInput {
  /** Σ des ExpectedIncome UNCERTAIN PENDING attendus à l'horizon. */
  uncertainIncomePotential: MoneyInput;
}

/** Ventilation complète et sans ambiguïté de la prévision financière du mois. */
export interface MonthEndFinancialBreakdown {
  availableToday: Money;
  pendingPlannedExpensesTotal: Money;
  confirmedExpectedIncomeTotal: Money;
  uncertainIncomePotential: Money;
  monthEndAvailableForecast: Money;
}

/**
 * Ventilation explicite de la prévision financière de fin de mois : chaque
 * composant est exposé séparément (montants DECIMAL exacts), y compris les
 * revenus INCERTAINS qui ne participent jamais au résultat principal.
 */
export function monthEndFinancialBreakdown(
  input: MonthEndFinancialBreakdownInput,
): MonthEndFinancialBreakdown {
  const forecast = monthEndAvailableForecast(input);
  return {
    availableToday: toMoney(input.availableToday),
    pendingPlannedExpensesTotal: toMoney(input.pendingPlannedExpensesTotal),
    confirmedExpectedIncomeTotal: toMoney(input.confirmedExpectedIncomeTotal),
    uncertainIncomePotential: toMoney(input.uncertainIncomePotential),
    monthEndAvailableForecast: forecast,
  };
}
