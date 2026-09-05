import Decimal from 'decimal.js';
import { toMoney, type Money, type MoneyInput } from './money.js';

/**
 * Journal des opérations (dépenses/revenus) de finance-core.
 *
 * Une opération porte un `type` et un montant TOUJOURS positif. Le signe est
 * appliqué ici : EXPENSE = flux sortant (−), tout autre type (INCOME…) = flux
 * entrant (+). Le type est une simple chaîne pour rester générique et
 * découplé de shared-types / Prisma.
 *
 * Fonctions pures : le solde courant d'un compte est toujours dérivé,
 * jamais stocké (solde = solde de départ + revenus − dépenses).
 */

export const EXPENSE_TYPE = 'EXPENSE';
export const INCOME_TYPE = 'INCOME';

export interface LedgerEntry {
  type: string;
  amount: MoneyInput;
}

/** Signe d'une opération : −montant pour une dépense, +montant sinon. */
export function entryDelta(entry: LedgerEntry): Money {
  const value = toMoney(entry.amount);
  return entry.type === EXPENSE_TYPE ? value.negated() : value;
}

/** Flux net d'un journal : Σ revenus − Σ dépenses (0 si vide). */
export function netFlow(entries: LedgerEntry[]): Money {
  return entries.reduce<Money>(
    (total, entry) => total.plus(entryDelta(entry)),
    new Decimal(0),
  );
}

/**
 * Totaux par sens, exprimés en montants POSITIFS :
 * `incomes` = Σ revenus, `expenses` = Σ dépenses (magnitude, jamais négatif).
 */
export function transactionTotals(entries: LedgerEntry[]): {
  incomes: Money;
  expenses: Money;
} {
  return entries.reduce<{ incomes: Money; expenses: Money }>(
    (totals, entry) => {
      const value = toMoney(entry.amount);
      if (entry.type === EXPENSE_TYPE) {
        return { incomes: totals.incomes, expenses: totals.expenses.plus(value) };
      }
      return { incomes: totals.incomes.plus(value), expenses: totals.expenses };
    },
    { incomes: new Decimal(0), expenses: new Decimal(0) },
  );
}

/** Solde courant d'un compte = solde de départ + flux du journal. */
export function currentBalance(
  startingBalance: MoneyInput,
  entries: LedgerEntry[],
): Money {
  return toMoney(startingBalance).plus(netFlow(entries));
}
