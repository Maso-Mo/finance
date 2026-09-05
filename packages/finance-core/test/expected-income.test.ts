import { describe, expect, it } from 'vitest';
import {
  accountFlow,
  classifyExpectedIncomeByDate,
  classifyExpectedIncomeByWindow,
  currentBalance,
  expectedIncomeTimingIsValid,
  isConfirmedIncome,
  isPendingIncome,
} from '../src/index.js';

const PENDING = 'PENDING';
const RECEIVED = 'RECEIVED';
const CANCELED = 'CANCELED';
const TODAY = '2026-10-20';

/**
 * Règles finance-core (étape 7) — revenus futurs.
 *
 * ⚠ Un revenu futur PENDING (CONFIRMED comme UNCERTAIN) n'est JAMAIS un flux
 * du journal : il ne doit jamais entrer dans accountFlow / currentBalance /
 * sumAvailableBalance. Seule la Transaction INCOME réelle (créée lors du
 * « Oui, je l'ai reçu ») alimente les soldes.
 */

describe('Revenu futur — date EXACTE', () => {
  it('1. date future → upcoming', () => {
    expect(classifyExpectedIncomeByDate('2026-10-25', TODAY, PENDING)).toBe('upcoming');
  });

  it('2. le jour même → dueToday', () => {
    expect(classifyExpectedIncomeByDate(TODAY, TODAY, PENDING)).toBe('dueToday');
  });

  it('3. date passée PENDING → overdue (le statut temporel est dérivé)', () => {
    expect(classifyExpectedIncomeByDate('2026-10-05', TODAY, PENDING)).toBe('overdue');
  });

  it('RECEIVED / CANCELED → jamais un rappel actif (null)', () => {
    expect(classifyExpectedIncomeByDate('2026-10-25', TODAY, RECEIVED)).toBeNull();
    expect(classifyExpectedIncomeByDate(TODAY, TODAY, CANCELED)).toBeNull();
  });
});

describe('Revenu futur — PLAGE de dates', () => {
  // « entre le 20 et le 27 » → windowStart=20, windowEnd=27. Le système ne
  // choisit JAMAIS un jour précis dans la plage.
  const WINDOW_START = '2026-10-20';
  const WINDOW_END = '2026-10-27';

  it('4. avant windowStart → upcoming', () => {
    expect(classifyExpectedIncomeByWindow(WINDOW_START, WINDOW_END, '2026-10-15', PENDING)).toBe('upcoming');
  });

  it('5. le jour de windowStart → inWindow', () => {
    expect(classifyExpectedIncomeByWindow(WINDOW_START, WINDOW_END, WINDOW_START, PENDING)).toBe('inWindow');
  });

  it('6. au milieu de la plage → inWindow', () => {
    expect(classifyExpectedIncomeByWindow(WINDOW_START, WINDOW_END, '2026-10-23', PENDING)).toBe('inWindow');
  });

  it('7. le jour de windowEnd (inclus) → inWindow', () => {
    expect(classifyExpectedIncomeByWindow(WINDOW_START, WINDOW_END, WINDOW_END, PENDING)).toBe('inWindow');
  });

  it('8. après windowEnd → overdue', () => {
    expect(classifyExpectedIncomeByWindow(WINDOW_START, WINDOW_END, '2026-10-28', PENDING)).toBe('overdue');
  });
});

describe('Validité temporelle (une seule forme active)', () => {
  it('9. plage invalide windowStart > windowEnd → refusée', () => {
    expect(
      expectedIncomeTimingIsValid({
        windowStart: '2026-10-27',
        windowEnd: '2026-10-20',
      }),
    ).toBe(false);
  });

  it('plage incomplète (windowStart seul) → refusée', () => {
    expect(
      expectedIncomeTimingIsValid({ windowStart: '2026-10-20' }),
    ).toBe(false);
  });

  it('date exacte + plage SIMULTANÉES → refusée', () => {
    expect(
      expectedIncomeTimingIsValid({
        expectedDate: '2026-10-20',
        windowStart: '2026-10-20',
        windowEnd: '2026-10-27',
      }),
    ).toBe(false);
  });

  it('aucune indication temporelle → refusée (V1)', () => {
    expect(expectedIncomeTimingIsValid({})).toBe(false);
  });

  it('date exacte valide et plage complète valide → acceptées', () => {
    expect(expectedIncomeTimingIsValid({ expectedDate: '2026-10-20' })).toBe(true);
    expect(
      expectedIncomeTimingIsValid({
        windowStart: '2026-10-20',
        windowEnd: '2026-10-27',
      }),
    ).toBe(true);
  });
});

describe('Certitude et statut (règle de lecture)', () => {
  it('CONFIRMED = attendu réellement ; UNCERTAIN = espéré', () => {
    expect(isConfirmedIncome('CONFIRMED')).toBe(true);
    expect(isConfirmedIncome('UNCERTAIN')).toBe(false);
  });

  it('seul PENDING est « en attente de réception »', () => {
    expect(isPendingIncome('PENDING')).toBe(true);
    expect(isPendingIncome('RECEIVED')).toBe(false);
    expect(isPendingIncome('CANCELED')).toBe(false);
  });
});

describe('Un revenu futur n’entre JAMAIS dans currentBalance', () => {
  const ACCOUNT = 'account-cash-1';

  it('10. CONFIRMED PENDING 500 000 → le solde reste 100 000', () => {
    // Le revenu futur est ATTENDU (CONFIRMED), mais PAS reçu : aucune
    // Transaction INCOME n'existe dans le journal.
    const expectedIncomes = [{ certainty: 'CONFIRMED', amount: '500000' }];
    expect(isConfirmedIncome(expectedIncomes[0]!.certainty)).toBe(true);

    const realJournal: Parameters<typeof accountFlow>[0] = [];
    const netFlow = accountFlow(realJournal, ACCOUNT);
    const balance = currentBalance('100000', netFlow, '0');
    expect(balance.toString()).toBe('100000');
  });

  it('11. UNCERTAIN PENDING 500 000 → le solde reste 100 000', () => {
    const expectedIncomes = [{ certainty: 'UNCERTAIN', amount: '500000' }];
    expect(isConfirmedIncome(expectedIncomes[0]!.certainty)).toBe(false);

    const realJournal: Parameters<typeof accountFlow>[0] = [];
    const netFlow = accountFlow(realJournal, ACCOUNT);
    // Même API publique (composée via currentBalance) : le résultat est
    // identique — les revenus futurs ne sont pas des flux.
    const balance = currentBalance('100000', netFlow, '0');
    expect(balance.toString()).toBe('100000');
  });
});
