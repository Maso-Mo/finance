import { prisma } from '../db.js';
import type { AccountType, Currency } from '@finance/shared-types';
import { findCategoryIdByRef } from './tools.js';

/**
 * Helpers partagés de la couche ACTION (étape 13) :
 *  - formatage français d'affichage (montants, dates) pour les RÉSUMÉS ;
 *  - résolution déterministe des références symboliques (type de compte →
 *    id réel ; code/nom de catégorie → id système).
 */

export const ACCOUNT_LABELS: Record<AccountType, string> = {
  BANK: 'Banque',
  MVOLA: 'MVola',
  ORANGE_MONEY: 'Orange Money',
  AIRTEL_MONEY: 'Airtel Money',
  CASH: 'Cash',
  SAVINGS: 'Épargne',
};

/** Montant exact (chaîne) → format FR pour résumé (ex. « 1 150 000 Ar »). */
export function moneyFR(value: string, currency: string | null): string {
  const symbol: Record<string, string> = { MGA: 'Ar', EUR: '€', CAD: 'CA$' };
  const sym = symbol[currency ?? 'MGA'] ?? 'Ar';
  const decimals = currency === 'EUR' || currency === 'CAD' ? 2 : 0;
  const negative = value.startsWith('-');
  const absolute = negative ? value.slice(1) : value;
  const [intPart = '0', rawFrac = ''] = absolute.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  let fraction = rawFrac;
  if (decimals === 2) {
    fraction = (rawFrac + '00').slice(0, 2);
  }
  const body =
    decimals === 0 ? grouped : fraction ? `${grouped},${fraction}` : `${grouped},00`;
  return `${negative ? '-' : ''}${body} ${sym}`;
}

const dateFormatter = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** « YYYY-MM-DD » → « 5 sept. 2026 » (neutre fuseau, calcul jamais local). */
export function dayLabel(day: string): string {
  return dateFormatter.format(new Date(`${day}T00:00:00.000Z`));
}

/** Libellé d'une date d'action connue ou « je ne sais plus ». */
export function dateValueLabel(day?: string, unknown?: boolean): string {
  if (unknown === true || !day) {
    return 'Date inconnue';
  }
  return dayLabel(day);
}

/** Devise principale de l'utilisateur (MGA/EUR/CAD) ou null. */
export async function userCurrency(userId: string): Promise<Currency | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currency: true },
  });
  return user ? (user.currency as Currency) : null;
}

/** Type de compte → id réel appartenant à l'utilisateur (ou null). */
export async function resolveAccountId(
  userId: string,
  type: AccountType | undefined,
): Promise<string | null> {
  if (!type) {
    return null;
  }
  const account = await prisma.account.findFirst({
    where: { userId, type },
    select: { id: true, type: true },
  });
  return account ? account.id : null;
}

/** Vérifie qu'une cible (id) appartient bien à l'utilisateur. */
export async function assertOwned(
  userId: string,
  table: 'transaction' | 'accountTransfer' | 'plannedExpense' | 'expectedIncome' | 'monthlyBudget' | 'debt' | 'monthlySavingsPlan',
  id: string,
): Promise<void> {
  let found = false;
  if (table === 'transaction') {
    found = Boolean(await prisma.transaction.findFirst({ where: { id, userId }, select: { id: true } }));
  } else if (table === 'accountTransfer') {
    found = Boolean(await prisma.accountTransfer.findFirst({ where: { id, userId }, select: { id: true } }));
  } else if (table === 'plannedExpense') {
    found = Boolean(await prisma.plannedExpense.findFirst({ where: { id, userId }, select: { id: true } }));
  } else if (table === 'expectedIncome') {
    found = Boolean(await prisma.expectedIncome.findFirst({ where: { id, userId }, select: { id: true } }));
  } else if (table === 'monthlyBudget') {
    found = Boolean(await prisma.monthlyBudget.findFirst({ where: { id, userId }, select: { id: true } }));
  } else if (table === 'debt') {
    found = Boolean(await prisma.debt.findFirst({ where: { id, userId }, select: { id: true } }));
  } else if (table === 'monthlySavingsPlan') {
    found = Boolean(await prisma.monthlySavingsPlan.findFirst({ where: { id, userId }, select: { id: true } }));
  }
  if (!found) {
    throw new Error(`ASSISTANT_TARGET_NOT_FOUND:${id}`);
  }
}

/** Résout un categoryRef en catégorie système (code ou nom exact). */
export async function resolveCategory(
  categoryRef: string | undefined,
): Promise<{ id: string; code: string; name: string } | null> {
  if (!categoryRef) {
    return null;
  }
  return findCategoryIdByRef(categoryRef);
}
