import { describe, expect, it } from 'vitest';
import {
  budgetRemaining,
  budgetStatus,
  elapsedDaysInMonth,
  monthEndForecast,
  monthlySpent,
  spentByCategory,
  type BudgetExpenseByCategoryLike,
  type BudgetExpenseLike,
} from '../src/index.js';

/**
 * Étape 8 — budgets mensuels.
 *
 * Règle centrale : le budget est une LIMITE analytique. Le « dépensé » est
 * TOUJOURS dérivé du journal réel des Transactions EXPENSE actives :
 *  - une Transaction INCOME ne compte jamais ;
 *  - une transaction soft-deleted (deletedAt) ne compte jamais ;
 *  - les dépenses planifiées et revenus futurs ne sont jamais des dépenses
 *    réelles (ils ne sont pas des entrées ici : aucune Transaction réelle) ;
 *  - statut binaire uniquement : VERT (dépensé ≤ budget) / DEPASSÉ ;
 *  - la prévision est déterministe, `today` est toujours injecté.
 */

const EXPENSE_RESTAURANT: BudgetExpenseByCategoryLike = {
  type: 'EXPENSE',
  amount: '150000',
  categoryId: 'cat-restaurant',
};
const EXPENSE_TRANSPORT: BudgetExpenseByCategoryLike = {
  type: 'EXPENSE',
  amount: '50000',
  categoryId: 'cat-transport',
};
const EXPENSE_UNKNOWN: BudgetExpenseByCategoryLike = {
  type: 'EXPENSE',
  amount: '20000',
  categoryId: null,
};
const INCOME: BudgetExpenseByCategoryLike = {
  type: 'INCOME',
  amount: '999999',
  categoryId: null,
};

function softDeleted(entry: BudgetExpenseLike): BudgetExpenseLike {
  return { ...entry, deletedAt: new Date('2026-09-15T00:00:00.000Z') };
}

describe('monthlySpent — dépenses réelles actives', () => {
  it('somme uniquement les EXPENSE actives du mois', () => {
    const total = monthlySpent([
      EXPENSE_RESTAURANT,
      EXPENSE_TRANSPORT,
      EXPENSE_UNKNOWN,
      INCOME,
    ]);
    expect(total.toString()).toBe('220000');
  });

  it('ignore une Transaction soft-deleted', () => {
    const total = monthlySpent([
      EXPENSE_RESTAURANT,
      softDeleted(EXPENSE_TRANSPORT),
      EXPENSE_UNKNOWN,
    ]);
    expect(total.toString()).toBe('170000');
  });

  it('aucune dépense → 0', () => {
    expect(monthlySpent([]).toString()).toBe('0');
    expect(monthlySpent([INCOME]).toString()).toBe('0');
  });

  it('l’INCOME ne compte jamais comme dépense', () => {
    expect(monthlySpent([EXPENSE_RESTAURANT, INCOME]).toString()).toBe('150000');
  });
});

describe('spentByCategory — dépenses réelles par catégorie', () => {
  const rows: BudgetExpenseByCategoryLike[] = [
    EXPENSE_RESTAURANT,
    EXPENSE_TRANSPORT,
    EXPENSE_UNKNOWN,
    INCOME,
  ];

  it('somme uniquement la catégorie demandée', () => {
    expect(spentByCategory(rows, 'cat-restaurant').toString()).toBe('150000');
    expect(spentByCategory(rows, 'cat-transport').toString()).toBe('50000');
  });

  it('catégorie inconnue : aucune catégorie budgétée n’est impactée', () => {
    expect(spentByCategory(rows, 'cat-other').toString()).toBe('0');
  });

  it('soft-deleted ignorée dans le total catégorie', () => {
    expect(
      spentByCategory([EXPENSE_RESTAURANT, softDeleted(EXPENSE_RESTAURANT)], 'cat-restaurant').toString(),
    ).toBe('150000');
  });
});

describe('budgetStatus — VERT / DÉPASSÉ', () => {
  it('dépensé ≤ budget → VERT', () => {
    expect(budgetStatus('150000', '200000')).toBe('VERT');
    expect(budgetStatus('200000', '200000')).toBe('VERT');
  });

  it('dépensé > budget → DÉPASSÉ', () => {
    expect(budgetStatus('230000', '200000')).toBe('DEPASSE');
  });

  it('accepter les montants décimaux exacts', () => {
    expect(budgetStatus('1500.50', '1500.50')).toBe('VERT');
    expect(budgetStatus('1500.51', '1500.50')).toBe('DEPASSE');
  });
});

describe('budgetRemaining — restant (négatif si dépassé)', () => {
  it('restant positif', () => {
    expect(budgetRemaining('200000', '150000').toString()).toBe('50000');
  });

  it('restant nul', () => {
    expect(budgetRemaining('200000', '200000').toString()).toBe('0');
  });

  it('restant NÉGATIF quand le budget est dépassé', () => {
    expect(budgetRemaining('200000', '245000').toString()).toBe('-45000');
  });
});

describe('monthEndForecast — prévision de fin de mois', () => {
  it('mois en cours : moyenne quotidienne × jours du mois', () => {
    // 300 000 dépensés sur 10 jours écoulés, septembre = 30 jours.
    const forecast = monthEndForecast('2026-09', '2026-09-10', '300000');
    expect(forecast.toString()).toBe('900000');
  });

  it('premier jour du mois : 1 jour écoulé', () => {
    const forecast = monthEndForecast('2026-09', '2026-09-01', '15000');
    expect(forecast.toString()).toBe('450000');
  });

  it('aucune dépense → prévision 0', () => {
    expect(monthEndForecast('2026-09', '2026-09-10', '0').toString()).toBe('0');
  });

  it('arrondi à 2 décimales', () => {
    // 1 / 3 jour × 31 = 10,333… → 10,33
    expect(monthEndForecast('2026-01', '2026-01-03', '1').toString()).toBe('10.33');
    // 2 / 3 × 31 = 20,666… → 20,67
    expect(monthEndForecast('2026-01', '2026-01-03', '2').toString()).toBe('20.67');
  });

  it('mois PASSÉ : la prévision vaut le total réel final', () => {
    expect(monthEndForecast('2026-08', '2026-09-10', '123456').toString()).toBe('123456');
    expect(monthEndForecast('2026-08', '2026-08-31', '50000').toString()).toBe('50000');
  });

  it('mois FUTUR : aucune dépense inventée', () => {
    expect(monthEndForecast('2026-11', '2026-09-10', '0').toString()).toBe('0');
  });

  it('février NON bissextile : 28 jours', () => {
    const forecast = monthEndForecast('2026-02', '2026-02-07', '70000');
    // 70 000 / 7 × 28 = 280 000.
    expect(forecast.toString()).toBe('280000');
  });

  it('février BISSEXTILE : 29 jours', () => {
    const forecast = monthEndForecast('2028-02', '2028-02-07', '70000');
    // 70 000 / 7 × 29 = 290 000.
    expect(forecast.toString()).toBe('290000');
  });

  it('mois à 31 jours', () => {
    const forecast = monthEndForecast('2027-01', '2027-01-10', '100000');
    expect(forecast.toString()).toBe('310000');
  });

  it('today = dernier jour du mois → moyenne du mois entier', () => {
    const forecast = monthEndForecast('2026-09', '2026-09-30', '900000');
    expect(forecast.toString()).toBe('900000');
  });
});

describe('elapsedDaysInMonth', () => {
  it('clampé aux jours du mois (février non bissextile)', () => {
    expect(elapsedDaysInMonth('2026-02', '2026-02-28')).toBe(28);
    expect(elapsedDaysInMonth('2026-02', '2026-02-31')).toBe(28);
  });

  it('février bissextile → 29 jours', () => {
    expect(elapsedDaysInMonth('2028-02', '2028-02-29')).toBe(29);
    expect(elapsedDaysInMonth('2028-02', '2028-02-30')).toBe(29);
  });

  it('valeur invalide refusée', () => {
    expect(() => elapsedDaysInMonth('2026-09', 'not-a-date')).toThrow(RangeError);
  });
});
