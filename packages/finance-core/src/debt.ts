import Decimal from 'decimal.js';
import { toMoney, type Money, type MoneyInput } from './money.js';

/**
 * DETTES, CRÉANCES ET RÈGLEMENTS (étape 11) — finance-core.
 *
 * ⚠ INVARIANT FONDAMENTAL : le remboursement du PRINCIPAL d'une dette n'est NI
 * une dépense de consommation NI un revenu.
 *  - `I_OWE`      (« je dois ») : un règlement sort de mon compte (delta −) ;
 *  - `OWED_TO_ME` (« on me doit ») : un règlement entre sur mon compte
 *    (delta +) ;
 *  - dans les DEUX cas aucun Transaction EXPENSE/INCOME n'est créé (sinon
 *    budgets, spent, revenus et analyses futures seraient faux).
 *
 * Tous les montants stockés restent POSITIFS ; la DIRECTION porte le sens.
 * Le montant RESTANT n'est JAMAIS stocké :
 *   remaining = originalAmount − Σ règlements actifs.
 * Le statut temporel (OPEN / SETTLED / OVERDUE) est TOUJOURS dérivé en
 * lecture, jamais persisté.
 *
 * CAS SPÉCIAL « AVANCE » (`INCOME_ADVANCE_RECEIVABLE`, uniquement sur
 * OWED_TO_ME) : l'utilisateur qualifie EXPLICITEMENT la créance comme avance
 * sur un revenu/salaire. Contrairement à un remboursement ordinaire reçu
 * (jamais un revenu), une avance de salaire RÉELLEMENT reçue EST un revenu :
 * le +compte est alors porté par une vraie Transaction INCOME liée, et le
 * DebtSettlement sert UNIQUEMENT à réduire la créance — jamais les deux
 * (aucun double comptage dans le solde).
 *
 * Fonctions pures : sans Prisma, PostgreSQL, Express ni React.
 * Montants exacts decimal.js (jamais de flottant).
 */

export const DEBT_DIRECTION_I_OWE = 'I_OWE';
export const DEBT_DIRECTION_OWED_TO_ME = 'OWED_TO_ME';
export type DebtDirection = 'I_OWE' | 'OWED_TO_ME';

export const DEBT_KIND_STANDARD = 'STANDARD';
export const DEBT_KIND_INCOME_ADVANCE_RECEIVABLE = 'INCOME_ADVANCE_RECEIVABLE';
export type DebtKind = 'STANDARD' | 'INCOME_ADVANCE_RECEIVABLE';

export type DebtTemporalStatus = 'OPEN' | 'SETTLED' | 'OVERDUE';

/** Un règlement n'est « actif » que s'il n'est pas supprimé. */
export function isActiveSettlement(
  settlement: { deletedAt?: unknown } | null | undefined,
): boolean {
  return settlement != null && settlement.deletedAt == null;
}

/**
 * Σ des montants des règlements ACTIFS (0 si la liste est vide).
 * Chaque montant est POSITIF ; la fonction refuse une entrée négative ou
 * nulle (incohérence de stockage — le sens est porté par la direction).
 */
export function debtSettledAmount(amounts: readonly MoneyInput[]): Money {
  return amounts.reduce<Money>((total, amount) => {
    const value = toMoney(amount);
    if (value.lte(0)) {
      throw new RangeError('Settlement amounts must be greater than 0.');
    }
    return total.plus(value);
  }, new Decimal(0));
}

/**
 * Montant restant DÉRIVÉ :
 *   originalAmount − Σ règlements actifs.
 * Peut devenir négatif uniquement si des données sont incohérentes (le
 * service interdit tout sur-remboursement : total réglé <= originalAmount).
 */
export function debtRemaining(
  originalAmount: MoneyInput,
  settledAmount: MoneyInput,
): Money {
  return toMoney(originalAmount).minus(toMoney(settledAmount));
}

/**
 * Statut temporel DÉRIVÉ (jamais stocké) :
 *  - SETTLED : remaining = 0 ;
 *  - OVERDUE : remaining > 0 ET échéance connue ET échéance < aujourd'hui ;
 *  - OPEN    : dans tous les autres cas (remaining > 0).
 * `dueDate` est un jour calendaire « YYYY-MM-DD » (nullable) ; `today` suit le
 * même format.
 */
export function debtStatus(
  remaining: MoneyInput,
  dueDate: string | null,
  today: string,
): DebtTemporalStatus {
  const value = toMoney(remaining);
  if (value.isZero()) {
    return 'SETTLED';
  }
  if (dueDate !== null && dueDate < today) {
    return 'OVERDUE';
  }
  return 'OPEN';
}

/**
 * Délta de solde d'un règlement STANDARD (remboursement réel) :
 *  - I_OWE      → −amount (l'argent sort de mon compte) ;
 *  - OWED_TO_ME → +amount (l'argent entre sur mon compte).
 * Refuse toute autre direction (jamais de signe implicite).
 */
export function standardDebtSettlementDelta(
  direction: string,
  amount: MoneyInput,
): Money {
  const value = toMoney(amount);
  if (direction === DEBT_DIRECTION_I_OWE) {
    return value.negated();
  }
  if (direction === DEBT_DIRECTION_OWED_TO_ME) {
    return value;
  }
  throw new RangeError(`Unknown debt direction: ${direction}`);
}

/**
 * Délta de solde d'un règlement TOUTES catégories confondues :
 *  - I_OWE (toujours STANDARD)             → −amount ;
 *  - OWED_TO_ME STANDARD                   → +amount ;
 *  - OWED_TO_ME INCOME_ADVANCE_RECEIVABLE  → 0 : le +compte est déjà porté
 *    par la Transaction INCOME liée à ce règlement (jamais les deux).
 */
export function debtSettlementAccountDelta(
  direction: string,
  kind: string,
  amount: MoneyInput,
): Money {
  if (kind === DEBT_KIND_INCOME_ADVANCE_RECEIVABLE) {
    if (direction !== DEBT_DIRECTION_OWED_TO_ME) {
      throw new RangeError(
        'INCOME_ADVANCE_RECEIVABLE is only valid for OWED_TO_ME debts.',
      );
    }
    return new Decimal(0);
  }
  return standardDebtSettlementDelta(direction, amount);
}

/**
 * Détection de SUR-REMBOURSEMENT : un nouveau règlement est refusé si
 *   settledAmount + amount > originalAmount.
 * Le paiement EXACTEMENT égal au restant est autorisé (<=, jamais <).
 */
export function isDebtOverpayment(
  originalAmount: MoneyInput,
  settledAmount: MoneyInput,
  newAmount: MoneyInput,
): boolean {
  return toMoney(settledAmount)
    .plus(toMoney(newAmount))
    .gt(toMoney(originalAmount));
}

/** Restant AVANT un règlement (affichage « Restant avant / après »). */
export function debtRemainingBeforeSettlement(
  originalAmount: MoneyInput,
  settledAmount: MoneyInput,
): Money {
  return debtRemaining(originalAmount, settledAmount);
}
