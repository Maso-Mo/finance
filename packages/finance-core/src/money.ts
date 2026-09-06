import Decimal from 'decimal.js';

/**
 * Représentation monétaire exacte de finance-core.
 *
 * Tous les montants sont manipulés via decimal.js (jamais de number JS
 * flottant pour l'argent). À la frontière backend → finance-core, on convertit
 * proprement (le Decimal de Prisma → string → Decimal de decimal.js).
 * finance-core ne connaît ni Prisma, ni Express, ni React.
 */

export type Money = Decimal;
export type MoneyInput = string | number | Decimal;

// Précision interne élevée : un montant peut atteindre Decimal(20, 2) — 20
// chiffres entiers + 2 décimales. La précision par défaut de decimal.js (20
// chiffres significatifs) arrondirait déjà les SOMMES de tels montants. On
// lève la limite une fois pour toute la bibliothèque afin que chaque addition/
// soustraction reste EXACTE (jamais d'arrondi silencieux sur l'argent).
Decimal.set({ precision: 80 });

/** Convertit une entrée en Decimal exact, en rejetant NaN/Infinity. */
export function toMoney(input: MoneyInput): Money {
  const value = input instanceof Decimal ? input : new Decimal(input);
  if (!value.isFinite()) {
    throw new RangeError('Amount must be a finite number.');
  }
  return value;
}

/** Somme exacte de plusieurs montants (0 si la liste est vide). */
export function sum(values: MoneyInput[]): Money {
  return values.reduce<Money>((total, value) => {
    return total.plus(toMoney(value));
  }, new Decimal(0));
}

export const SAVINGS_ACCOUNT_TYPE = 'SAVINGS';

export interface BalanceEntry {
  type: string;
  balance: MoneyInput;
}

/**
 * Règle du "Total disponible" :
 *
 * TOTAL DISPONIBLE = Banque + MVola + Orange Money + Airtel Money + Cash
 *
 * L'ÉPARGNE (SAVINGS) est EXCLUE du total disponible (elle reste visible
 * dans les détails, mais n'est pas comptée comme argent disponible).
 *
 * Fonction pure : réutilisable par web, api et la future app mobile.
 */
export function sumAvailableBalance(entries: BalanceEntry[]): Money {
  return entries.reduce<Money>((total, entry) => {
    if (entry.type === SAVINGS_ACCOUNT_TYPE) {
      return total;
    }
    return total.plus(toMoney(entry.balance));
  }, new Decimal(0));
}
