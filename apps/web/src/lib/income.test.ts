import { describe, expect, it } from 'vitest';
import type { AccountPublic } from '@finance/shared-types';
import {
  buildExpectedIncomePayload,
  buildIncomeReceivedPayload,
  timingOf,
} from './income';

const accounts: AccountPublic[] = [
  { id: 'acc-bank', type: 'BANK', currency: 'MGA', initialBalance: '0', balance: '0' },
  { id: 'acc-mvola', type: 'MVOLA', currency: 'MGA', initialBalance: '0', balance: '0' },
  { id: 'acc-cash', type: 'CASH', currency: 'MGA', initialBalance: '0', balance: '0' },
];

describe('buildExpectedIncomePayload — certitude et forme temporelle', () => {
  it('CONFIRMED + date exacte → payload complet sans plage', () => {
    const { payload, errors } = buildExpectedIncomePayload({
      amount: '500000',
      certainty: 'CONFIRMED',
      description: 'Salaire',
      dateMode: 'exact',
      expectedDate: '2026-10-05',
      windowStart: '',
      windowEnd: '',
    });
    expect(errors).toEqual([]);
    expect(payload).toEqual({
      amount: '500000',
      certainty: 'CONFIRMED',
      description: 'Salaire',
      expectedDate: '2026-10-05',
    });
  });

  it('UNCERTAIN + date exacte → certainty UNCERTAIN conservée', () => {
    const { payload } = buildExpectedIncomePayload({
      amount: '150000',
      certainty: 'UNCERTAIN',
      description: '',
      dateMode: 'exact',
      expectedDate: '2026-10-20',
      windowStart: '',
      windowEnd: '',
    });
    expect(payload?.certainty).toBe('UNCERTAIN');
    expect(payload?.expectedDate).toBe('2026-10-20');
  });

  it('CONFIRMED + PÉRIODE → windowStart/windowEnd, AUCUNE date inventée', () => {
    const { payload, errors } = buildExpectedIncomePayload({
      amount: '300000',
      certainty: 'CONFIRMED',
      description: 'Freelance',
      dateMode: 'range',
      expectedDate: '',
      windowStart: '2026-10-20',
      windowEnd: '2026-10-27',
    });
    expect(errors).toEqual([]);
    expect(payload).toEqual({
      amount: '300000',
      certainty: 'CONFIRMED',
      description: 'Freelance',
      windowStart: '2026-10-20',
      windowEnd: '2026-10-27',
    });
    expect(payload?.expectedDate).toBeUndefined();
  });

  it('UNCERTAIN + PÉRIODE (20→27) → payload valide', () => {
    const { payload, errors } = buildExpectedIncomePayload({
      amount: '80000',
      certainty: 'UNCERTAIN',
      description: 'Surplus',
      dateMode: 'range',
      expectedDate: '',
      windowStart: '2026-10-20',
      windowEnd: '2026-10-27',
    });
    expect(errors).toEqual([]);
    expect(payload?.windowStart).toBe('2026-10-20');
    expect(payload?.windowEnd).toBe('2026-10-27');
    expect(payload?.certainty).toBe('UNCERTAIN');
  });
});
describe('validations du formulaire', () => {
  it('montant invalide (0, négatif, trop de décimales) → erreur', () => {
    for (const bad of ['0', '-5', '1.234', 'abc']) {
      const { payload, errors } = buildExpectedIncomePayload({
        amount: bad,
        certainty: 'CONFIRMED',
        description: '',
        dateMode: 'exact',
        expectedDate: '2026-10-05',
        windowStart: '',
        windowEnd: '',
      });
      expect(payload).toBeNull();
      expect(errors.join(' ')).toContain('Montant');
    }
  });

  it('date exacte absente → erreur', () => {
    const { payload, errors } = buildExpectedIncomePayload({
      amount: '10000',
      certainty: 'CONFIRMED',
      description: '',
      dateMode: 'exact',
      expectedDate: '',
      windowStart: '',
      windowEnd: '',
    });
    expect(payload).toBeNull();
    expect(errors.join(' ')).toContain('date exacte');
  });

  it('période incomplète (début seul) → erreur', () => {
    const { payload, errors } = buildExpectedIncomePayload({
      amount: '10000',
      certainty: 'CONFIRMED',
      description: '',
      dateMode: 'range',
      expectedDate: '',
      windowStart: '2026-10-20',
      windowEnd: '',
    });
    expect(payload).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('période invalide (fin avant début) → erreur', () => {
    const { payload, errors } = buildExpectedIncomePayload({
      amount: '10000',
      certainty: 'CONFIRMED',
      description: '',
      dateMode: 'range',
      expectedDate: '',
      windowStart: '2026-10-27',
      windowEnd: '2026-10-20',
    });
    expect(payload).toBeNull();
    expect(errors.join(' ')).toContain('suivre son début');
  });
});

describe('buildIncomeReceivedPayload — « Oui, je l’ai reçu »', () => {
  const base = {
    amount: '500000',
    date: '2026-10-05',
    dateUnknown: false,
    accountUnknown: false,
    allocations: { 'acc-bank': '', 'acc-mvola': '', 'acc-cash': '' },
    description: 'Salaire réel',
  };

  it('montant réel modifiable + allocation simple', () => {
    const { payload, errors } = buildIncomeReceivedPayload(
      {
        ...base,
        amount: '480000',
        allocations: { ...base.allocations, 'acc-bank': '480000' },
      },
      accounts,
    );
    expect(errors).toEqual([]);
    expect(payload).toEqual({
      amount: '480000',
      occurredAt: '2026-10-05',
      allocations: [{ accountId: 'acc-bank', amount: '480000' }],
      description: 'Salaire réel',
    });
  });

  it('allocation multi-comptes → une seule Transaction côté payload', () => {
    const { payload, errors } = buildIncomeReceivedPayload(
      {
        ...base,
        allocations: {
          'acc-bank': '300000',
          'acc-mvola': '200000',
          'acc-cash': '',
        },
      },
      accounts,
    );
    expect(errors).toEqual([]);
    expect(payload?.allocations).toEqual([
      { accountId: 'acc-bank', amount: '300000' },
      { accountId: 'acc-mvola', amount: '200000' },
    ]);
  });

  it('la répartition doit couvrir EXACTEMENT le montant réel', () => {
    const { payload, errors } = buildIncomeReceivedPayload(
      {
        ...base,
        allocations: { ...base.allocations, 'acc-bank': '300000' },
      },
      accounts,
    );
    expect(payload).toBeNull();
    expect(errors.join(' ')).toContain('exactement');
  });

  it('compte inconnu EXPLICITE → aucune allocation exigée', () => {
    const { payload, errors } = buildIncomeReceivedPayload(
      { ...base, accountUnknown: true },
      accounts,
    );
    expect(errors).toEqual([]);
    expect(payload?.accountUnknown).toBe(true);
    expect(payload?.allocations).toBeUndefined();
  });

  it('date réelle inconnue explicite → dateUnknown sans occurredAt', () => {
    const { payload, errors } = buildIncomeReceivedPayload(
      { ...base, dateUnknown: true, date: '', accountUnknown: true },
      accounts,
    );
    expect(errors).toEqual([]);
    expect(payload?.dateUnknown).toBe(true);
    expect(payload?.occurredAt).toBeUndefined();
  });

  it('ni date ni « je ne sais plus » → erreur', () => {
    const { payload, errors } = buildIncomeReceivedPayload(
      { ...base, date: '' },
      accounts,
    );
    expect(payload).toBeNull();
    expect(errors.join(' ')).toContain('date réelle');
  });
});

describe('timingOf', () => {
  it('affiche une date exacte sans inventer de plage', () => {
    expect(
      timingOf({ expectedDate: '2026-10-05', windowStart: null, windowEnd: null }),
    ).toBe('le 2026-10-05');
  });

  it('affiche la plage 20 → 27 telle quelle', () => {
    expect(
      timingOf({ expectedDate: null, windowStart: '2026-10-20', windowEnd: '2026-10-27' }),
    ).toBe('entre le 2026-10-20 et le 2026-10-27');
  });
});
