import Decimal from 'decimal.js';
import { toMoney, type Money, type MoneyInput } from './money.js';
import { daysInMonth, keyToMonth } from './calendar.js';

/**
 * Budgets mensuels (étape 8) — finance-core.
 *
 * ⚠ Un budget est une RÈGLE ANALYTIQUE (limite / objectif). Il n'est JAMAIS
 * de l'argent : il ne crée ni ne modifie de Transaction, ne touche à aucun
 * compte, solde ou Total disponible. Le « montant dépensé » est TOUJOURS
 * DÉRIVÉ du journal réel des Transactions EXPENSE actives (jamais stocké).
 *
 * Toutes les fonctions sont PURES : elles prennent les lignes du journal,
 * les montants et les dates en entrée et ne dépendent jamais de la date
 * réelle de la machine (`today` est injecté).
 *
 * Mois : clé textuelle « YYYY-MM » (le calendrier reste la seule autorité —
 * voir calendar.ts). Une transaction appartient au mois de son `occurredAt`
 * (jour calendaire), une transaction soft-deleted est ignorée, une
 * Transaction INCOME ne compte jamais comme dépense.
 */

export type BudgetStatus = 'VERT' | 'DEPASSE';

/** Ligne minimale du journal prise en compte par les budgets. */
export interface BudgetExpenseLike {
  type: string;
  amount: MoneyInput;
  /** Date de suppression logique : présente ⇒ ligne ignorée. */
  deletedAt?: unknown;
}

export interface BudgetExpenseByCategoryLike extends BudgetExpenseLike {
  /** null = catégorie inconnue (« je ne sais plus ») ou revenu : jamais compté. */
  categoryId: string | null;
}

function isActiveExpense(entry: BudgetExpenseLike): boolean {
  return entry.type === 'EXPENSE' && entry.deletedAt == null;
}

/**
 * Statut binaire volontairement simple :
 *  - VERT     : dépensé ≤ budget ;
 *  - DÉPASSÉ  : dépensé > budget.
 * Aucun statut intermédiaire (warning, orange, …) en V1.
 */
export function budgetStatus(spent: MoneyInput, budget: MoneyInput): BudgetStatus {
  return toMoney(spent).gt(toMoney(budget)) ? 'DEPASSE' : 'VERT';
}

/**
 * Restant = budget − dépensé. Peut être NÉGATIF quand le budget est dépassé
 * (ex. budget 200 000, dépensé 245 000 ⇒ −45 000).
 */
export function budgetRemaining(budget: MoneyInput, spent: MoneyInput): Money {
  return toMoney(budget).minus(toMoney(spent));
}

/**
 * Dépense réelle d'un mois : Σ des Transactions EXPENSE ACTIVES fournies.
 * Une Transaction INCOME, une transaction soft-deleted (deletedAt) ou une
 * ligne au type inconnu ne compte jamais.
 */
export function monthlySpent(entries: readonly BudgetExpenseLike[]): Money {
  return entries.reduce<Money>(
    (total, entry) => (isActiveExpense(entry) ? total.plus(toMoney(entry.amount)) : total),
    new Decimal(0),
  );
}

/**
 * Dépense réelle d'un mois pour UNE catégorie : Σ des Transactions EXPENSE
 * ACTIVES dont `categoryId` correspond exactement. Une transaction de
 * catégorie inconnue ou sans catégorie n'entre dans AUCUN budget catégorie
 * (elle reste comptée dans le budget GLOBAL via `monthlySpent`).
 */
export function spentByCategory(
  entries: readonly BudgetExpenseByCategoryLike[],
  categoryId: string,
): Money {
  return entries.reduce<Money>(
    (total, entry) =>
      isActiveExpense(entry) && entry.categoryId === categoryId
        ? total.plus(toMoney(entry.amount))
        : total,
    new Decimal(0),
  );
}

/**
 * Nombre de jours calendaires déjà écoulés dans le mois de `today` (clampé à
 * 1..nombre de jours du mois). Ne dépend que de `today`, jamais de l'horloge.
 */
export function elapsedDaysInMonth(monthKey: string, today: string): number {
  const { year, month } = keyToMonth(monthKey);
  const day = Number(today.slice(8, 10));
  const total = daysInMonth(year, month);
  if (!Number.isInteger(day) || day < 1) {
    throw new RangeError('today must be a valid YYYY-MM-DD date.');
  }
  return Math.min(day, total);
}

/**
 * Prévision de fin de mois — V1 simple et EXPLICABLE.
 *
 * Formule (mois en cours) :
 *   moyenne quotidienne = dépensé réel / jours écoulés
 *   prévision          = moyenne quotidienne × nombre de jours du mois
 *
 * Arrondi à 2 décimales (RMOITIE AU PLUS PROCHE) : la prévision est une
 * ESTIMATION, jamais une certitude. Elle n'utilise que des dépenses RÉELLES :
 *  - mois PASSÉ    → la « prévision » vaut le total réel final (dépensé) ;
 *  - mois FUTUR    → 0 : aucune dépense réelle n'existe, on n'invente rien ;
 *  - mois COURANT  → formule moyenne quotidienne × jours du mois.
 *
 * Cas particuliers couverts : premier jour du mois (élapsed = 1), aucune
 * dépense (0), février, années bissextiles, mois passé / futur.
 */
export function monthEndForecast(
  monthKey: string,
  today: string,
  spent: MoneyInput,
): Money {
  const { year, month } = keyToMonth(monthKey);
  const totalDays = daysInMonth(year, month);
  const todayMonth = today.slice(0, 7);
  const spentMoney = toMoney(spent);

  if (todayMonth > monthKey) {
    // Mois déjà terminé : le « réel » est le total final.
    return spentMoney;
  }
  if (todayMonth < monthKey) {
    // Mois futur : aucune dépense réelle enregistrée → aucune prévision inventée.
    return new Decimal(0);
  }
  const elapsed = elapsedDaysInMonth(monthKey, today);
  const averageDaily = spentMoney.div(elapsed);
  return averageDaily.mul(totalDays).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}
