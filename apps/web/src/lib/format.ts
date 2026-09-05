import type {
  AccountType,
  Currency,
  TransactionType,
} from '@finance/shared-types';

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

export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
  INCOME: 'Revenu',
  EXPENSE: 'Dépense',
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
 * Ex. MGA "1150000" → "1 150 000 Ar" ; EUR "1500.5" → "1 500,50 €" ;
 * un solde négatif "-30000" → "-30 000 Ar" (signe et groupement corrects).
 */
export function formatMoney(value: string, currency: Currency): string {
  const negative = value.startsWith('-');
  const absolute = negative ? value.slice(1) : value;
  const parts = absolute.split('.');
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

  const sign = negative ? '-' : '';
  return `${sign}${body} ${CURRENCY_SYMBOLS[currency]}`;
}

/**
 * Montant d'une opération avec son signe pour l'affichage d'un journal :
 * "+1 500 Ar" (revenu) / "-1 000 Ar" (dépense).
 */
export function formatSignedMoney(
  value: string,
  type: TransactionType,
  currency: Currency,
): string {
  const formatted = formatMoney(value, currency);
  return type === 'EXPENSE' ? `-${formatted}` : `+${formatted}`;
}

/** Date locale du navigateur au format "YYYY-MM-DD" (valeur d'input date). */
export function toISODate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function currencyName(currency: Currency): string {
  return CURRENCY_NAMES[currency];
}
