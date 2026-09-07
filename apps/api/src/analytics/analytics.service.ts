import { prisma } from '../db.js';
import { ApiError } from '../http-error.js';
import { todayLocalISO } from '../dates.js';
import type {
  AnalyticsOverviewResponse,
  Currency,
} from '@finance/shared-types';

/**
 * ANALYTIQUE LECTURE-SEULE — GET /analytics/overview.
 * Strictement read-only : tout est DÉRIVÉ du journal réel des Transactions
 * actives (jamais d'écriture, jamais de changement de statut, jamais stocké).
 *
 * Inclusion : Transactions actives (deletedAt NULL), type INCOME/EXPENSE, avec
 * date d'occurrence connue, dans la fenêtre demandée. Transferts, Épargnes,
 * règlements de dettes, PlannedExpense non payées, ExpectedIncome non reçues
 * ne produisent AUCUNE Transaction réelle tant qu'elles ne sont pas confirmées
 * ⇒ naturellement exclues ; toute ligne logiquement supprimée est exclue.
 *
 * Mois : clé « YYYY-MM » dérivée de `occurredAt`. Les transactions stockent
 * `occurredAt` à MIDI UTC (cf. transactions.service) : le mois saisi ne
 * bascule jamais avec le fuseau horaire de la session.
 */

const MONTH_KEY_LENGTH = 7;

/** Décalage d'une clé « YYYY-MM » de `delta` mois (négatif autorisé). */
function shiftMonthKey(key: string, delta: number): string {
  const [year = 0, month = 1] = key.split('-').map(Number);
  const total = year * 12 + (month - 1) + delta;
  const newYear = Math.floor(total / 12);
  const newMonth = (total % 12) + 1;
  return `${newYear}-${String(newMonth).padStart(2, '0')}`;
}

/** Bornes [start, end) couvrant les `months` mois terminant en `endMonth`. */
function monthWindowBounds(
  endMonth: string,
  months: number,
): { start: Date; end: Date } {
  return {
    start: new Date(
      `${shiftMonthKey(endMonth, -(months - 1))}-01T00:00:00.000Z`,
    ),
    end: new Date(`${shiftMonthKey(endMonth, 1)}-01T00:00:00.000Z`),
  };
}

/** Montant Décimal (≤ 2 décimales) → cents entiers exacts (BigInt). */
function toCents(value: { toString(): string }): bigint {
  const raw = value.toString();
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [wholePart = '0', fracPart = ''] = unsigned.split('.');
  const whole = BigInt(wholePart === '' ? '0' : wholePart);
  const frac = BigInt(fracPart.padEnd(2, '0').slice(0, 2) || '0');
  return (whole * 100n + frac) * (negative ? -1n : 1n);
}

/** Cents entiers → chaîne décimale (zéros de fin retirés). */
function centsToString(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const frac = absolute % 100n;
  const fracText = frac.toString().padStart(2, '0').replace(/0+$/, '');
  const body = fracText ? `${whole}.${fracText}` : `${whole}`;
  return negative ? `-${body}` : body;
}

type CategoryEntry = { cents: bigint; label: string };
type MonthlyTotals = { income: bigint; expense: bigint };

export async function getAnalyticsOverview(
  userId: string,
  months: number,
  today?: string,
): Promise<AnalyticsOverviewResponse> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currency: true },
  });
  if (!user) {
    throw new ApiError(404, 'User not found.');
  }
  const currency = user.currency as Currency;

  const referenceToday = today ?? todayLocalISO();
  const currentMonth = referenceToday.slice(0, MONTH_KEY_LENGTH);
  const { start, end } = monthWindowBounds(currentMonth, months);

  const rows = await prisma.transaction.findMany({
    where: {
      userId,
      deletedAt: null,
      occurredAt: { not: null, gte: start, lt: end },
    },
    select: {
      type: true,
      amount: true,
      occurredAt: true,
      categoryId: true,
      categoryUnknown: true,
      category: { select: { id: true, name: true } },
    },
  });

  const monthly = new Map<string, MonthlyTotals>();
  for (let offset = 0; offset < months; offset += 1) {
    const month = shiftMonthKey(currentMonth, -(months - 1 - offset));
    monthly.set(month, { income: 0n, expense: 0n });
  }
  const categories = new Map<string, CategoryEntry>();

  for (const row of rows) {
    if (!row.occurredAt) {
      continue;
    }
    const month = row.occurredAt.toISOString().slice(0, MONTH_KEY_LENGTH);
    const point = monthly.get(month);
    if (point) {
      if (row.type === 'INCOME') {
        point.income += toCents(row.amount);
      } else {
        point.expense += toCents(row.amount);
      }
    }
    if (month === currentMonth && row.type === 'EXPENSE') {
      const isUnknown = row.categoryUnknown || !row.categoryId;
      const key = isUnknown ? 'unknown' : (row.categoryId as string);
      const entry = categories.get(key);
      if (entry) {
        entry.cents += toCents(row.amount);
      } else {
        categories.set(key, {
          cents: toCents(row.amount),
          label: isUnknown
            ? 'Sans catégorie'
            : (row.category?.name ?? 'Autres'),
        });
      }
    }
  }

  const monthlyCashflow = [...monthly.entries()].map(([month, totals]) => ({
    month,
    income: centsToString(totals.income),
    expense: centsToString(totals.expense),
  }));

  const totalExpenseCents = [...categories.values()].reduce(
    (sum, entry) => sum + entry.cents,
    0n,
  );
  const currentMonthExpenseCategories = [...categories.entries()]
    .map(([key, entry]) => ({
      categoryId: key === 'unknown' ? null : key,
      label: entry.label,
      amount: centsToString(entry.cents),
      share: categoryShare(entry.cents, totalExpenseCents),
    }))
    .sort((a, b) => Number(b.amount) - Number(a.amount));

  return {
    currency,
    currentMonth,
    monthlyCashflow,
    currentMonthExpenseCategories,
  };
}

/** Part 0..1 d'une catégorie dans le total du mois (0 si aucun total). */
function categoryShare(cents: bigint, totalCents: bigint): number {
  if (totalCents <= 0n) {
    return 0;
  }
  const share = Number(cents) / Number(totalCents);
  return Math.min(1, Math.max(0, Number(share.toFixed(6))));
}
