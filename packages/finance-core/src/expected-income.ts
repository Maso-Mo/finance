/**
 * Revenus futurs (étape 7) — finance-core.
 *
 * Règles absolues (fonctions pures, sans I/O) :
 *  - un revenu futur PENDING n'est PAS de l'argent reçu : il ne doit JAMAIS
 *    entrer dans `currentBalance` / `accountFlow` / `sumAvailableBalance`.
 *    Seule la Transaction INCOME réelle (créée par la confirmation « Oui, je
 *    l'ai reçu ») alimente le journal et donc les soldes ;
 *  - « CONFIRMED / UNCERTAIN » décrit la CERTITUDE du revenu futur, jamais son
 *    statut de réception ;
 *  - le statut temporel d'un PENDING est DÉRIVÉ (jamais stocké) : date exacte
 *    → upcoming / dueToday / overdue ; plage → upcoming / inWindow / overdue.
 *    Le système n'invente jamais une date exacte dans une plage.
 *
 * Toutes les dates sont des jours calendaires « YYYY-MM-DD » (comparaison
 * lexicale exacte), comme le reste de finance-core.
 */

import { isValidISODate } from './calendar.js';

/** Niveau de certitude d'un revenu futur (champ de la couche métier). */
export type IncomeCertainty = 'CONFIRMED' | 'UNCERTAIN';

/** Statut de réception d'un revenu futur (champ de la couche métier). */
export type ExpectedIncomeStatus = 'PENDING' | 'RECEIVED' | 'CANCELED';

/** Catégorie temporelle dérivée d'un revenu futur PENDING. */
export type IncomeReminderBucket = 'upcoming' | 'dueToday' | 'inWindow' | 'overdue';

/** Certitude confirmée (« je m'attends réellement à recevoir ») ? */
export function isConfirmedIncome(certainty: IncomeCertainty | string): boolean {
  return certainty === 'CONFIRMED';
}

/** Un revenu futur est-il encore en attente de réception ? */
export function isPendingIncome(status: ExpectedIncomeStatus | string): boolean {
  return status === 'PENDING';
}

/** Timing temporel minimal d'un revenu futur (nullable côté stockage). */
export interface ExpectedIncomeTiming {
  expectedDate?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
}

/**
 * Validité temporelle d'un revenu futur : UNE seule forme active —
 * date exacte XOR (plage complète windowStart <= windowEnd). Aucune absence,
 * aucun mélange, aucun « windowStart seul ».
 */
export function expectedIncomeTimingIsValid(timing: ExpectedIncomeTiming): boolean {
  const { expectedDate, windowStart, windowEnd } = timing;
  const hasExact = expectedDate != null;
  const hasStart = windowStart != null;
  const hasEnd = windowEnd != null;

  if (hasExact && !hasStart && !hasEnd) {
    return isValidISODate(expectedDate!);
  }
  if (!hasExact && hasStart && hasEnd) {
    if (!isValidISODate(windowStart!) || !isValidISODate(windowEnd!)) {
      return false;
    }
    return windowStart! <= windowEnd!;
  }
  return false;
}

/**
 * Classifie un revenu futur à date EXACTE par rapport au jour local `today`.
 * PENDING uniquement : avant → upcoming ; le jour même → dueToday ; après →
 * overdue. Un revenu non PENDING n'est jamais un rappel actif (null).
 */
export function classifyExpectedIncomeByDate(
  expectedDate: string,
  today: string,
  status: ExpectedIncomeStatus | string,
): IncomeReminderBucket | null {
  if (status !== 'PENDING') {
    return null;
  }
  if (expectedDate > today) {
    return 'upcoming';
  }
  if (expectedDate === today) {
    return 'dueToday';
  }
  return 'overdue';
}

/**
 * Classifie un revenu futur en PLAGE par rapport au jour local `today`.
 * PENDING uniquement : avant windowStart → upcoming ; du windowStart au
 * windowEnd INCLUS → inWindow ; après windowEnd → overdue. Aucun jour précis
 * de la plage n'est jamais choisi.
 */
export function classifyExpectedIncomeByWindow(
  windowStart: string,
  windowEnd: string,
  today: string,
  status: ExpectedIncomeStatus | string,
): IncomeReminderBucket | null {
  if (status !== 'PENDING') {
    return null;
  }
  if (today < windowStart) {
    return 'upcoming';
  }
  if (today <= windowEnd) {
    return 'inWindow';
  }
  return 'overdue';
}

/**
 * Premier jour pertinent d'un revenu futur (tri chronologique des rappels) :
 * la date exacte, ou windowStart pour une plage. Null si aucun timing.
 */
export function expectedIncomeStartDate(timing: ExpectedIncomeTiming): string | null {
  return timing.expectedDate ?? timing.windowStart ?? null;
}

/** Dernier jour pertinent (date exacte, ou windowEnd pour une plage). */
export function expectedIncomeEndDate(timing: ExpectedIncomeTiming): string | null {
  return timing.windowEnd ?? timing.expectedDate ?? null;
}
