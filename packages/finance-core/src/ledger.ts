import Decimal from 'decimal.js';
import { toMoney, type Money, type MoneyInput } from './money.js';

/**
 * Journal des opérations (dépenses/revenus) de finance-core.
 *
 * Modèle (étape 5 corrigée) :
 *  - une transaction appartient à un utilisateur, PAS à un seul compte : elle
 *    est ventilée en zéro/une/plusieurs ALLOCATIONS ;
 *  - allocations connues ⇒ Σ allocations = montant de la transaction
 *    EXACTEMENT (decimal.js, jamais de flottant) ;
 *  - « compte inconnu » (aucune allocation) : la transaction n'altère aucun
 *    solde précis tant qu'aucune allocation n'est renseignée ;
 *  - une transaction supprimée (deletedAt) est ignorée ;
 *  - AccountAdjustment = correction de solde (ni dépense ni revenu).
 *
 * Solde courant d'un compte (toujours dérivé, jamais stocké) :
 *   currentBalance = initialBalance
 *                  + revenus actifs alloués − dépenses actives allouées
 *                  + ajustements.
 *
 * ⚠ TRANSFERTS : ne PAS modéliser comme « dépense source + revenu
 * destination » (fausserait totaux/statistiques/budgets). Les fonctions ci-
 * dessous restent dédiées aux dépenses/revenus réels.
 *
 * Fonctions pures : sans I/O, découplées de Prisma / shared-types.
 */

export const EXPENSE_TYPE = 'EXPENSE';
export const INCOME_TYPE = 'INCOME';

/** Ligne simple d'un journal : un sens et un montant POSITIF. */
export interface LedgerEntry {
  type: string;
  amount: MoneyInput;
}

/** Allocation d'une transaction vers un compte. */
export interface Allocation {
  /** Identifiant du compte (indispensable pour un flux par compte). */
  accountId?: string;
  amount: MoneyInput;
}

/** Forme minimale d'une transaction du journal pour les calculs purs. */
export interface JournalTransaction {
  type: string;
  /** Date de suppression logique : si présente, la transaction est ignorée. */
  deletedAt?: unknown;
  /** Allocations (absentes/vides si compte inconnu). */
  allocations?: readonly Allocation[];
}

/** Montant d'un ajustement (signé : + ajoute, − retire). */
export interface Adjustment {
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

/** Une transaction n'est « active » que si elle n'est pas supprimée. */
export function isActiveTransaction(
  transaction: { deletedAt?: unknown } | null | undefined,
): boolean {
  return transaction != null && transaction.deletedAt == null;
}

/** Σ des allocations (0 si la liste est vide). */
export function allocationsTotal(allocations: readonly Allocation[]): Money {
  return allocations.reduce<Money>(
    (total, allocation) => total.plus(toMoney(allocation.amount)),
    new Decimal(0),
  );
}

/**
 * Vérifie que la somme des allocations vaut EXACTEMENT le montant de la
 * transaction (règle « allocations connues ⇒ somme = montant »).
 */
export function allocationsMatchTotal(
  totalAmount: MoneyInput,
  allocations: readonly Allocation[],
): boolean {
  return allocationsTotal(allocations).eq(toMoney(totalAmount));
}

/**
 * Flux net (revenus − dépenses) qu'une transaction ACTIVE apporte au compte
 * `accountId` via ses allocations : somme des allocations de ce compte, signées
 * par le sens de la transaction. 0 si la transaction est supprimée, sans
 * allocation pour ce compte, ou à compte inconnu.
 */
export function accountFlow(
  transactions: readonly JournalTransaction[],
  accountId: string,
): Money {
  return transactions
    .filter((transaction) => isActiveTransaction(transaction))
    .reduce<Money>((total, transaction) => {
      const allocation = (transaction.allocations ?? []).find(
        (item) => item.accountId === accountId,
      );
      if (!allocation) {
        return total;
      }
      return total.plus(
        entryDelta({ type: transaction.type, amount: allocation.amount }),
      );
    }, new Decimal(0));
}

/** Σ des ajustements de solde (montants signés, 0 si la liste est vide). */
export function adjustmentsTotal(adjustments: readonly Adjustment[]): Money {
  return adjustments.reduce<Money>(
    (total, adjustment) => total.plus(toMoney(adjustment.amount)),
    new Decimal(0),
  );
}

/**
 * Solde courant d'un compte :
 *   initialBalance + flux net des allocations actives + ajustements.
 * `flow` est le flux net (revenus − dépenses) déjà calculé pour ce compte.
 */
export function currentBalance(
  startingBalance: MoneyInput,
  flow: MoneyInput,
  adjustments: MoneyInput,
): Money {
  return toMoney(startingBalance)
    .plus(toMoney(flow))
    .plus(toMoney(adjustments));
}
