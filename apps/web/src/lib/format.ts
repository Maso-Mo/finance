import type { AccountType, Currency } from '@finance/shared-types';

/**
 * Formatage d'affichage UNIQUEMENT. Le calcul monétaire reste exact
 * (decimal.js / chaînes) ; jamais une chaîne formatée n'est une source de
 * vérité pour un calcul.
 */

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  BANK: 'Banque',
  MVOLA: 'MVola',
  ORANGE_MONEY: 'Orange Money',
  AIRTEL_MONEY: 'Airtel Money',
  CASH: 'Cash',
  SAVINGS: 'Épargne',
};

const CURRENCY_SYMBOLS: Record<Currency, string> = {
  MGA: 'Ar',
  EUR: '€',
  CAD: 'CA$',
};

const CURRENCY_NAMES: Record<Currency, string> = {
  MGA: 'Ariary (MGA)',
  EUR: 'Euro (EUR)',
  CAD: 'Dollar canadien (CAD)',
};

/** MGA : pas de décimales par défaut ; EUR/CAD : deux décimales. */
function decimalCount(currency: Currency): 0 | 2 {
  return currency === 'MGA' ? 0 : 2;
}

function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * Formate une valeur monétaire exacte (chaîne) pour l'affichage.
 * Ex. MGA "1150000" → "1 150 000 Ar" ; EUR "1500.5" → "1 500,50 €".
 */
export function formatMoney(value: string, currency: Currency): string {
  const parts = value.split('.');
  const intPart = parts[0] ?? '0';
  const rawFraction = parts[1] ?? '';
  const decimals = decimalCount(currency);
  const integer = groupThousands(intPart);

  let fraction = rawFraction;
  if (decimals === 2) {
    fraction = (rawFraction + '00').slice(0, 2);
  }

  const body =
    decimals === 0
      ? integer
      : fraction !== ''
        ? `${integer},${fraction}`
        : `${integer},00`;

  return `${body} ${CURRENCY_SYMBOLS[currency]}`;
}

export function currencyName(currency: Currency): string {
  return CURRENCY_NAMES[currency];
}
