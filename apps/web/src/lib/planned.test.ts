import { describe, expect, it } from 'vitest';
import {
  buildConfirmPaidPayload,
  buildPlannedExpensePayload,
  buildRecurringExpensePayload,
} from './planned';
import type { AccountPublic, CategoryPublic } from '@finance/shared-types';

const CATEGORIES: CategoryPublic[] = [
  { id: 'cat-internet', code: 'internet', name: 'Internet', isSystem: true },
  { id: 'cat-other', code: 'other', name: 'Autre', isSystem: true },
];

const ACCOUNTS: AccountPublic[] = [
  {
    id: 'acc-cash',
    type: 'CASH',
    currency: 'MGA',
    initialBalance: '100000',
    balance: '100000',
  },
  {
    id: 'acc-mvola',
    type: 'MVOLA',
    currency: 'MGA',
    initialBalance: '200000',
    balance: '200000',
  },
];

describe('formulaire dépense future ponctuelle', () => {
  it('construit un payload valide avec catégorie connue', () => {
    const { payload, errors } = buildPlannedExpensePayload({
      amount: '80000',
      dueDate: '2026-10-05',
      categoryId: 'cat-internet',
      categoryUnknown: false,
      description: ' Internet ',
    });
    expect(errors).toEqual([]);
    expect(payload).toEqual({
      amount: '80000',
      dueDate: '2026-10-05',
      categoryId: 'cat-internet',
      description: 'Internet',
    });
  });

  it('« Je ne sais pas encore » → categoryUnknown explicite', () => {
    const { payload, errors } = buildPlannedExpensePayload({
      amount: '80000',
      dueDate: '2026-10-05',
      categoryId: '',
      categoryUnknown: true,
      description: '',
    });
    expect(errors).toEqual([]);
    expect(payload?.categoryUnknown).toBe(true);
    expect(payload?.categoryId).toBeUndefined();
  });

  it('montant invalide et catégorie ambigüe → erreurs', () => {
    const res = buildPlannedExpensePayload({
      amount: '0',
      dueDate: '',
      categoryId: '',
      categoryUnknown: false,
      description: '',
    });
    expect(res.payload).toBeNull();
    expect(res.errors.join(' ')).toContain('Montant');
    expect(res.errors.join(' ')).toContain('catégorie');
  });
});

describe('formulaire dépense mensuelle récurrente', () => {
  it('construit un payload valide (jour 5, date de fin facultative)', () => {
    const { payload, errors } = buildRecurringExpensePayload({
      amount: '80000',
      dayOfMonth: '5',
      startDate: '2026-10-01',
      endDate: '2027-10-01',
      categoryId: 'cat-internet',
      categoryUnknown: false,
      description: '',
    });
    expect(errors).toEqual([]);
    expect(payload?.dayOfMonth).toBe(5);
    expect(payload?.endDate).toBe('2027-10-01');
  });

  it('jour 0 ou 32 refusé', () => {
    for (const day of ['0', '32', '']) {
      const res = buildRecurringExpensePayload({
        amount: '80000',
        dayOfMonth: day,
        startDate: '2026-10-01',
        endDate: '',
        categoryId: 'cat-internet',
        categoryUnknown: false,
        description: '',
      });
      expect(res.payload, `day=${day}`).toBeNull();
      expect(res.errors.join(' ')).toContain('Jour');
    }
  });

  it('date de fin avant la date de début → refusée', () => {
    const res = buildRecurringExpensePayload({
      amount: '80000',
      dayOfMonth: '5',
      startDate: '2026-10-01',
      endDate: '2026-09-01',
      categoryId: 'cat-internet',
      categoryUnknown: false,
      description: '',
    });
    expect(res.payload).toBeNull();
  });
});

describe('confirmation « Oui, payé » — le réel peut différer du prévu', () => {
  it('montant réel différent + compte inconnu explicite', () => {
    const { payload, errors } = buildConfirmPaidPayload(
      {
        amount: '82500',
        date: '2026-10-06',
        dateUnknown: false,
        accountUnknown: true,
        allocations: {},
        categoryId: 'cat-internet',
        categoryUnknown: false,
        description: '',
      },
      ACCOUNTS,
    );
    expect(errors).toEqual([]);
    expect(payload?.amount).toBe('82500');
    expect(payload?.accountUnknown).toBe(true);
    expect(payload?.occurredAt).toBe('2026-10-06');
    expect(payload?.categoryId).toBe('cat-internet');
  });

  it('« je ne sais plus » la date → dateUnknown sans occurredAt', () => {
    const { payload } = buildConfirmPaidPayload(
      {
        amount: '30000',
        date: '',
        dateUnknown: true,
        accountUnknown: true,
        allocations: {},
        categoryId: 'cat-internet',
        categoryUnknown: false,
        description: '',
      },
      ACCOUNTS,
    );
    expect(payload?.dateUnknown).toBe(true);
    expect(payload?.occurredAt).toBeUndefined();
  });

  it('multi-source réel : la somme doit couvrir exactement le montant', () => {
    const { payload, errors } = buildConfirmPaidPayload(
      {
        amount: '60000',
        date: '2026-10-05',
        dateUnknown: false,
        accountUnknown: false,
        allocations: { 'acc-cash': '20000', 'acc-mvola': '40000' },
        categoryId: 'cat-other',
        categoryUnknown: false,
        description: '',
      },
      ACCOUNTS,
    );
    expect(errors).toEqual([]);
    expect(payload?.allocations).toEqual([
      { accountId: 'acc-cash', amount: '20000' },
      { accountId: 'acc-mvola', amount: '40000' },
    ]);
  });

  it('répartition partielle → refusée', () => {
    const res = buildConfirmPaidPayload(
      {
        amount: '60000',
        date: '2026-10-05',
        dateUnknown: false,
        accountUnknown: false,
        allocations: { 'acc-cash': '20000' },
        categoryId: 'cat-other',
        categoryUnknown: false,
        description: '',
      },
      ACCOUNTS,
    );
    expect(res.payload).toBeNull();
  });
});
