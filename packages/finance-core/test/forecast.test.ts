import { describe, expect, it } from 'vitest';
import {
  expectedIncomeTotalsByMonthEnd,
  monthEndAvailableForecast,
  monthEndFinancialBreakdown,
  pendingPlannedExpensesTotal,
} from '../src/index.js';

/**
 * Correctif 8.1 — prévision FINANCIÈRE de fin de mois (finance-core).
 *
 * ⚠ Distinction STRICTE :
 *  - `spendingForecast` (budget.ts) : projection statistique des DÉPENSES
 *    RÉELLES du mois — testée dans budget.test.ts ;
 *  - fonctions ci-dessous : PRÉVISION DE DISPONIBLE EN FIN DE MOIS
 *    (availableToday − dépenses planifiées PENDING + revenus CONFIRMED
 *    PENDING ; incertains séparés).
 */

const MONTH_END_2026_09 = '2026-09-30';

describe('pendingPlannedExpensesTotal — dépenses futures restantes', () => {
  it('PENDING due dans l’horizon → comptée', () => {
    const total = pendingPlannedExpensesTotal(
      [
        { status: 'PENDING', dueDate: '2026-09-20', amount: '200000' },
        { status: 'PENDING', dueDate: '2026-09-05', amount: '50000' },
      ],
      MONTH_END_2026_09,
    );
    expect(total.toString()).toBe('250000');
  });

  it('PAID → jamais comptée (déjà reflétée dans availableToday via sa Transaction)', () => {
    const total = pendingPlannedExpensesTotal(
      [
        { status: 'PENDING', dueDate: '2026-09-20', amount: '200000' },
        { status: 'PAID', dueDate: '2026-09-10', amount: '200000' },
        { status: 'CANCELED', dueDate: '2026-09-12', amount: '90000' },
        { status: 'SKIPPED', dueDate: '2026-09-15', amount: '70000' },
      ],
      MONTH_END_2026_09,
    );
    expect(total.toString()).toBe('200000');
  });

  it('échéance PENDING après la fin du mois → pas encore due à l’horizon', () => {
    const total = pendingPlannedExpensesTotal(
      [{ status: 'PENDING', dueDate: '2026-10-05', amount: '150000' }],
      MONTH_END_2026_09,
    );
    expect(total.toString()).toBe('0');
  });

  it('PENDING en retard (due passée) reste une obligation non résolue', () => {
    const total = pendingPlannedExpensesTotal(
      [{ status: 'PENDING', dueDate: '2026-09-10', amount: '120000' }],
      MONTH_END_2026_09,
    );
    expect(total.toString()).toBe('120000');
  });
});

describe('expectedIncomeTotalsByMonthEnd — revenus attendus à l’horizon', () => {
  it('CONFIRMED PENDING à date exacte dans l’horizon → confirmé compté', () => {
    const totals = expectedIncomeTotalsByMonthEnd(
      [
        {
          certainty: 'CONFIRMED',
          status: 'PENDING',
          expectedDate: '2026-09-18',
          amount: '300000',
        },
      ],
      MONTH_END_2026_09,
    );
    expect(totals.confirmed.toString()).toBe('300000');
    expect(totals.uncertain.toString()).toBe('0');
  });

  it('UNCERTAIN PENDING → séparé dans uncertain, jamais dans confirmed', () => {
    const totals = expectedIncomeTotalsByMonthEnd(
      [
        {
          certainty: 'CONFIRMED',
          status: 'PENDING',
          expectedDate: '2026-09-18',
          amount: '300000',
        },
        {
          certainty: 'UNCERTAIN',
          status: 'PENDING',
          expectedDate: '2026-09-20',
          amount: '1000000',
        },
      ],
      MONTH_END_2026_09,
    );
    expect(totals.confirmed.toString()).toBe('300000');
    expect(totals.uncertain.toString()).toBe('1000000');
  });

  it('RECEIVED → jamais compté (sa Transaction INCOME est déjà dans availableToday)', () => {
    const totals = expectedIncomeTotalsByMonthEnd(
      [
        {
          certainty: 'CONFIRMED',
          status: 'RECEIVED',
          expectedDate: '2026-09-15',
          amount: '500000',
        },
        {
          certainty: 'CONFIRMED',
          status: 'CANCELED',
          expectedDate: '2026-09-16',
          amount: '100000',
        },
      ],
      MONTH_END_2026_09,
    );
    expect(totals.confirmed.toString()).toBe('0');
    expect(totals.uncertain.toString()).toBe('0');
  });

  it('PLAGE : seule la borne windowEnd décide (≤ fin du mois inclus)', () => {
    const totals = expectedIncomeTotalsByMonthEnd(
      [
        {
          certainty: 'CONFIRMED',
          status: 'PENDING',
          windowStart: '2026-09-20',
          windowEnd: '2026-09-30',
          amount: '500000',
        },
        {
          certainty: 'CONFIRMED',
          status: 'PENDING',
          windowStart: '2026-09-25',
          windowEnd: '2026-10-05',
          amount: '999999',
        },
      ],
      MONTH_END_2026_09,
    );
    expect(totals.confirmed.toString()).toBe('500000');
  });

  it('revenu CONFIRMED PENDING en RETARD reste compté (pas d’état supprimé)', () => {
    const totals = expectedIncomeTotalsByMonthEnd(
      [
        {
          certainty: 'CONFIRMED',
          status: 'PENDING',
          expectedDate: '2026-09-10',
          amount: '120000',
        },
      ],
      MONTH_END_2026_09,
    );
    expect(totals.confirmed.toString()).toBe('120000');
  });
});

describe('monthEndAvailableForecast — formule V1 exacte', () => {
  it('exemple obligatoire : 500 000 − 200 000 + 300 000 = 600 000', () => {
    const forecast = monthEndAvailableForecast({
      availableToday: '500000',
      pendingPlannedExpensesTotal: '200000',
      confirmedExpectedIncomeTotal: '300000',
    });
    expect(forecast.toString()).toBe('600000');
  });

  it('aucune dépense future → le disponible reste disponible', () => {
    const forecast = monthEndAvailableForecast({
      availableToday: '500000',
      pendingPlannedExpensesTotal: '0',
      confirmedExpectedIncomeTotal: '0',
    });
    expect(forecast.toString()).toBe('500000');
  });

  it('aucun revenu confirmé → simple soustraction', () => {
    const forecast = monthEndAvailableForecast({
      availableToday: '400000',
      pendingPlannedExpensesTotal: '120000',
      confirmedExpectedIncomeTotal: '0',
    });
    expect(forecast.toString()).toBe('280000');
  });

  it('prévision NÉGATIVE : jamais clampée à zéro', () => {
    const forecast = monthEndAvailableForecast({
      availableToday: '100000',
      pendingPlannedExpensesTotal: '300000',
      confirmedExpectedIncomeTotal: '0',
    });
    expect(forecast.toString()).toBe('-200000');
  });

  it('décimales exactes (decimal.js, jamais de flottant)', () => {
    const forecast = monthEndAvailableForecast({
      availableToday: '1000.5',
      pendingPlannedExpensesTotal: '200.25',
      confirmedExpectedIncomeTotal: '99.75',
    });
    expect(forecast.toString()).toBe('900');
  });

  it('grandes valeurs (limites Decimal(20, 2))', () => {
    const forecast = monthEndAvailableForecast({
      availableToday: '99999999999999999999.99',
      pendingPlannedExpensesTotal: '0.01',
      confirmedExpectedIncomeTotal: '0.01',
    });
    expect(forecast.toString()).toBe('99999999999999999999.99');
  });
});

describe('monthEndFinancialBreakdown — ventilation sans ambiguïté', () => {
  it('expose chaque composant séparément, incertain jamais dans le résultat', () => {
    const breakdown = monthEndFinancialBreakdown({
      availableToday: '500000',
      pendingPlannedExpensesTotal: '200000',
      confirmedExpectedIncomeTotal: '300000',
      uncertainIncomePotential: '1000000',
    });
    expect(breakdown.availableToday.toString()).toBe('500000');
    expect(breakdown.pendingPlannedExpensesTotal.toString()).toBe('200000');
    expect(breakdown.confirmedExpectedIncomeTotal.toString()).toBe('300000');
    expect(breakdown.uncertainIncomePotential.toString()).toBe('1000000');
    expect(breakdown.monthEndAvailableForecast.toString()).toBe('600000');
  });

  it('l’épargne est exclue EN AMONT via availableToday (jamais réeinjectée ici)', () => {
    const breakdown = monthEndFinancialBreakdown({
      // availableToday est déjà le Total disponible SANS l'épargne : si le
      // compte épargne valait 1 000 000, la valeur transmise ici reste 100 000.
      availableToday: '100000',
      pendingPlannedExpensesTotal: '0',
      confirmedExpectedIncomeTotal: '0',
      uncertainIncomePotential: '0',
    });
    expect(breakdown.monthEndAvailableForecast.toString()).toBe('100000');
  });
});

