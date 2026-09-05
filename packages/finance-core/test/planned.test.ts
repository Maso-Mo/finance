import { describe, expect, it } from 'vitest';
import {
  classifyPlannedReminder,
  compareISO,
  currentBalance,
  dueBucket,
  generateMonthlyOccurrences,
  monthlyDueDate,
  netFlow,
} from '../src/index.js';

/**
 * Étape 6 — dépenses futures / récurrentes.
 *
 * Règle centrale : UNE DÉPENSE PLANIFIÉE N'EST PAS UNE DÉPENSE RÉELLE.
 *  - les helpers de dates sont purs et sans fuseau (YYYY-MM-DD) ;
 *  - une échéance 29/30/31 est clampée au dernier jour du mois ;
 *  - upcoming / due / overdue sont DÉRIVÉS de dueDate + status ;
 *  - rien de planifié n'entre dans currentBalance.
 */

describe('échéance mensuelle — clamp fin de mois', () => {
  it('jour 5 normal (octobre 2026)', () => {
    expect(monthlyDueDate({ year: 2026, month: 10 }, 5)).toBe('2026-10-05');
  });

  it('jour 31 en janvier → 31', () => {
    expect(monthlyDueDate({ year: 2027, month: 1 }, 31)).toBe('2027-01-31');
  });

  it('jour 31 en avril → 30', () => {
    expect(monthlyDueDate({ year: 2027, month: 4 }, 31)).toBe('2027-04-30');
  });

  it('jour 31 en février non bissextile → 28', () => {
    expect(monthlyDueDate({ year: 2027, month: 2 }, 31)).toBe('2027-02-28');
  });

  it('jour 31 en février bissextile → 29', () => {
    expect(monthlyDueDate({ year: 2028, month: 2 }, 31)).toBe('2028-02-29');
  });
});

describe('génération mensuelle déterministe', () => {
  it('série jour 5 sur un horizon donné', () => {
    const dates = generateMonthlyOccurrences({
      startDate: '2026-09-01',
      dayOfMonth: 5,
      referenceDate: '2026-09-15',
    });
    // Mois 09 + 3 suivants (10, 11, 12) → 4 échéances.
    expect(dates).toEqual([
      '2026-09-05',
      '2026-10-05',
      '2026-11-05',
      '2026-12-05',
    ]);
  });

  it('la première échéance doit suivre startDate (jour déjà passé ce mois-ci)', () => {
    const dates = generateMonthlyOccurrences({
      startDate: '2026-09-15',
      dayOfMonth: 5,
      referenceDate: '2026-09-15',
    });
    expect(dates[0]).toBe('2026-10-05');
    expect(dates).toHaveLength(3); // 10, 11, 12 (horizon courant + 3)
  });

  it('idempotent : deux appels identiques renvoient le même ensemble', () => {
    const options = {
      startDate: '2026-01-31',
      dayOfMonth: 31,
      referenceDate: '2026-05-09',
    } as const;
    expect(generateMonthlyOccurrences(options)).toEqual(
      generateMonthlyOccurrences(options),
    );
  });
});

describe('classification upcoming / due / overdue (dérivée)', () => {
  const today = '2026-10-05';

  it('échéance future proche → upcoming', () => {
    expect(dueBucket('2026-10-08', today)).toBe('upcoming');
  });

  it('échéance du jour → due', () => {
    expect(dueBucket(today, today)).toBe('due');
  });

  it('échéance passée PENDING → overdue', () => {
    expect(dueBucket('2026-09-30', today)).toBe('overdue');
  });

  it('au-delà de la fenêtre des 7 jours → later', () => {
    expect(dueBucket('2026-10-20', today)).toBe('later');
  });

  it('PAID n’est jamais un rappel actif', () => {
    expect(classifyPlannedReminder('2026-10-08', today, 'PAID')).toBeNull();
  });

  it('CANCELED n’est jamais un rappel actif', () => {
    expect(classifyPlannedReminder('2026-09-30', today, 'CANCELED')).toBeNull();
  });

  it('SKIPPED n’est jamais un rappel actif', () => {
    expect(classifyPlannedReminder('2026-10-08', today, 'SKIPPED')).toBeNull();
  });

  it('PENDING due aujourd’hui reste bien classé due', () => {
    expect(classifyPlannedReminder(today, today, 'PENDING')).toBe('due');
  });

  it('tri chronologique croissant de dates ISO', () => {
    expect(['2026-10-05', '2026-02-28', '2026-10-04'].sort(compareISO)).toEqual([
      '2026-02-28',
      '2026-10-04',
      '2026-10-05',
    ]);
  });
});

describe('une dépense planifiée ne touche jamais les soldes (invariant pur)', () => {
  it('currentBalance ne dépend que du journal RÉEL (jamais des planifiés)', () => {
    // Cash 100 000 ; une vraie dépense de 30 000 est confirmée.
    const cashId = 'account-cash';
    const realExpense = {
      type: 'EXPENSE',
      deletedAt: null,
      allocations: [{ accountId: cashId, amount: '30000' }],
    };
    const flow = netFlow([{ type: 'EXPENSE', amount: '30000' }]);
    const balance = currentBalance('100000', flow, '0');

    // Dépense planifiée encore PENDING : elle n'est pas une entrée du journal,
    // elle ne peut donc pas influencer ce calcul.
    const plannedPending = {
      amount: '500000',
      status: 'PENDING',
      dueDate: '2026-10-05',
    };

    expect(balance.toString()).toBe('70000');
    expect(plannedPending.status).toBe('PENDING');
    // Aucune fonction de solde ne reçoit la dépense planifiée en entrée :
    // le solde reste exactement celui du journal réel (100 000 − 30 000).
    expect(currentBalance('100000', flow, '0').toString()).toBe('70000');
    // Si elle avait été une vraie EXPENSE, elle aurait retiré 500 000.
    expect(currentBalance('100000', netFlow([{ type: 'EXPENSE', amount: '500000' }]), '0').toString()).toBe(
      '-400000',
    );
  });
});
