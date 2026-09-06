import { prisma } from '../db.js';
import { todayLocalISO, dbDateToISO } from '../dates.js';
import { getDashboard } from '../accounts/accounts.service.js';
import {
  daysInMonth,
  expectedIncomeTotalsByMonthEnd,
  keyToMonth,
  monthEndFinancialBreakdown,
  pendingPlannedExpensesTotal,
} from '@finance/finance-core';
import type { FinancialForecastResponse } from '@finance/shared-types';

/**
 * Service de la PRÉVISION FINANCIÈRE DE FIN DE MOIS (correctif 8.1).
 *
 * ⚠ RÈGLE ABSOLUE : GET STRICTEMENT READ-ONLY. Ce service lit uniquement
 * (comptes, transactions dérivées, PlannedExpense, ExpectedIncome), calcule
 * et retourne. Aucune écriture, aucun changement de statut, aucune génération,
 * aucune table Forecast : tout est DÉRIVÉ.
 *
 * Portée V1 : le MOIS COURANT uniquement (le mois contenant `today`). Aucune
 * reconstruction arbitraire d'un solde de départ futur ou passé : pour un mois
 * non courant, ce concept est absent du contrat (cf. shared-types/forecast.ts).
 *
 * Composants (noms explicites, jamais ambigus) :
 *  - availableToday             → Total disponible ACTUEL (Épargne exclue),
 *                                 dérivé du journal (initialBalance + INCOME
 *                                 actifs − EXPENSE actives + ajustements) ;
 *  - pendingPlannedExpensesTotal→ Σ PlannedExpense PENDING dues ≤ fin de mois ;
 *  - confirmedExpectedIncomeTotal → Σ ExpectedIncome CONFIRMED PENDING attendus
 *                                 ≤ fin de mois (date exacte ou windowEnd) ;
 *  - uncertainIncomePotential    → Σ ExpectedIncome UNCERTAIN PENDING (JAMAIS
 *                                 inclus dans la prévision principale) ;
 *  - monthEndAvailableForecast   → availableToday − dépenses prévues + revenus
 *                                 confirmés (peut être négatif, jamais clampé).
 */

/** Dernier jour calendaire du mois contenant `today` : « YYYY-MM-DD ». */
function monthEndISO(referenceToday: string): string {
  const monthKey = referenceToday.slice(0, 7);
  const { year, month } = keyToMonth(monthKey);
  const day = String(daysInMonth(year, month)).padStart(2, '0');
  return `${monthKey}-${day}`;
}

export async function getMonthEndFinancialForecast(
  userId: string,
  today?: string,
): Promise<FinancialForecastResponse> {
  const referenceToday = today ?? todayLocalISO();
  const monthKey = referenceToday.slice(0, 7);
  const monthEnd = monthEndISO(referenceToday);
  const monthEndDate = new Date(`${monthEnd}T00:00:00.000Z`);

  // Lecture parallèle (toutes en lecture stricte, aucune écriture).
  const [dashboard, plannedRows, incomeRows] = await Promise.all([
    getDashboard(userId),
    prisma.plannedExpense.findMany({
      where: { userId, status: 'PENDING', dueDate: { lte: monthEndDate } },
      select: { amount: true, dueDate: true },
      orderBy: { dueDate: 'asc' },
    }),
    prisma.expectedIncome.findMany({
      where: { userId, status: 'PENDING' },
      select: { amount: true, certainty: true, expectedDate: true, windowEnd: true },
      orderBy: { expectedDate: 'asc' },
    }),
  ]);

  // Dépenses futures RESTANT À PAYER d'ici la fin du mois (PENDING).
  const pendingTotal = pendingPlannedExpensesTotal(
    plannedRows.map((row) => ({
      status: 'PENDING' as const,
      dueDate: dbDateToISO(row.dueDate),
      amount: row.amount.toString(),
    })),
    monthEnd,
  );

  // Revenus futurs attendus d'ici la fin du mois, répartis par certitude.
  const incomeTotals = expectedIncomeTotalsByMonthEnd(
    incomeRows.map((row) => ({
      certainty: row.certainty as 'CONFIRMED' | 'UNCERTAIN',
      status: 'PENDING' as const,
      amount: row.amount.toString(),
      expectedDate: row.expectedDate ? dbDateToISO(row.expectedDate) : null,
      windowEnd: row.windowEnd ? dbDateToISO(row.windowEnd) : null,
    })),
    monthEnd,
  );

  const breakdown = monthEndFinancialBreakdown({
    availableToday: dashboard.totalAvailable,
    pendingPlannedExpensesTotal: pendingTotal,
    confirmedExpectedIncomeTotal: incomeTotals.confirmed,
    uncertainIncomePotential: incomeTotals.uncertain,
  });

  return {
    month: monthKey,
    today: referenceToday,
    currency: dashboard.currency,
    availableToday: breakdown.availableToday.toString(),
    pendingPlannedExpensesTotal: breakdown.pendingPlannedExpensesTotal.toString(),
    confirmedExpectedIncomeTotal: breakdown.confirmedExpectedIncomeTotal.toString(),
    uncertainIncomePotential: breakdown.uncertainIncomePotential.toString(),
    monthEndAvailableForecast: breakdown.monthEndAvailableForecast.toString(),
  };
}
