import { describe, expect, it } from 'vitest';
import {
  accountFlow,
  adjustmentsTotal,
  allocationsMatchTotal,
  allocationsTotal,
  currentBalance,
  entryDelta,
  EXPENSE_TYPE,
  INCOME_TYPE,
  isActiveTransaction,
  netFlow,
  sumAvailableBalance,
  transactionTotals,
  type Allocation,
  type JournalTransaction,
  type LedgerEntry,
} from '../src/index.js';

const CASH = 'account-cash';
const MVOLA = 'account-mvola';
const SAVINGS = 'SAVINGS';

function entry(type: string, amount: string): LedgerEntry {
  return { type, amount };
}

function allocation(accountId: string, amount: string): Allocation {
  return { accountId, amount };
}

/** Transaction active avec ses allocations (liste vide = compte inconnu). */
function tx(type: string, allocations: Allocation[]): JournalTransaction {
  return { type, allocations };
}

describe('entryDelta', () => {
  it('une dépense simple est un flux sortant (négatif)', () => {
    expect(entryDelta(entry(EXPENSE_TYPE, '15000')).toString()).toBe('-15000');
  });

  it('un revenu simple est un flux entrant (positif)', () => {
    expect(entryDelta(entry(INCOME_TYPE, '25000')).toString()).toBe('25000');
  });

  it('un type inconnu est traité comme un flux entrant (défaut sûr)', () => {
    expect(entryDelta(entry('OTHER', '100')).toString()).toBe('100');
  });
});

describe('netFlow', () => {
  it('revenus moins dépenses', () => {
    const flow = netFlow([
      entry(INCOME_TYPE, '50000'),
      entry(EXPENSE_TYPE, '15000'),
      entry(EXPENSE_TYPE, '3500.50'),
      entry(INCOME_TYPE, '10.25'),
    ]);
    expect(flow.toString()).toBe('31509.75');
  });

  it('liste vide → 0', () => {
    expect(netFlow([]).toString()).toBe('0');
  });

  it('calcul exact sans erreur flottante', () => {
    const flow = netFlow([
      entry(INCOME_TYPE, '0.1'),
      entry(INCOME_TYPE, '0.2'),
      entry(EXPENSE_TYPE, '0.3'),
    ]);
    expect(flow.toString()).toBe('0');
  });
});

describe('transactionTotals', () => {
  it('additionne chaque sens séparément, en montants positifs', () => {
    const totals = transactionTotals([
      entry(INCOME_TYPE, '1000'),
      entry(INCOME_TYPE, '2000.50'),
      entry(EXPENSE_TYPE, '300'),
      entry(EXPENSE_TYPE, '50.25'),
    ]);
    expect(totals.incomes.toString()).toBe('3000.5');
    expect(totals.expenses.toString()).toBe('350.25');
  });

  it('liste vide → zéros', () => {
    const totals = transactionTotals([]);
    expect(totals.incomes.toString()).toBe('0');
    expect(totals.expenses.toString()).toBe('0');
  });
});

describe('allocations : somme exacte', () => {
  it('plusieurs allocations : 400 000 + 200 000 = 600 000', () => {
    const total = allocationsTotal([
      allocation(MVOLA, '400000'),
      allocation(CASH, '200000'),
    ]);
    expect(total.toString()).toBe('600000');
  });

  it('somme allocations correcte → accepté', () => {
    expect(
      allocationsMatchTotal('600000', [
        allocation(MVOLA, '400000'),
        allocation(CASH, '200000'),
      ]),
    ).toBe(true);
  });

  it('somme allocations incorrecte (400 000 + 150 000) → refus', () => {
    expect(
      allocationsMatchTotal('600000', [
        allocation(MVOLA, '400000'),
        allocation(CASH, '150000'),
      ]),
    ).toBe(false);
  });

  it('aucune allocation → somme 0', () => {
    expect(allocationsTotal([]).toString()).toBe('0');
    expect(allocationsMatchTotal('600000', [])).toBe(false);
  });

  it('exactitude décimale sur la somme', () => {
    expect(
      allocationsMatchTotal('0.3', [
        allocation(CASH, '0.1'),
        allocation(MVOLA, '0.2'),
      ]),
    ).toBe(true);
  });
});

describe('accountFlow (flux par compte via allocations)', () => {
  it('dépense simple allouée à un seul compte', () => {
    const transactions = [tx(EXPENSE_TYPE, [allocation(CASH, '100000')])];
    expect(accountFlow(transactions, CASH).toString()).toBe('-100000');
    expect(accountFlow(transactions, MVOLA).toString()).toBe('0');
  });

  it('revenu simple alloué au compte de réception', () => {
    const transactions = [tx(INCOME_TYPE, [allocation(MVOLA, '250000')])];
    expect(accountFlow(transactions, MVOLA).toString()).toBe('250000');
    expect(accountFlow(transactions, CASH).toString()).toBe('0');
  });

  it('multi-source : 600 000 ventilé MVola 400 000 + Cash 200 000', () => {
    const transactions = [
      tx(EXPENSE_TYPE, [allocation(MVOLA, '400000'), allocation(CASH, '200000')]),
    ];
    expect(accountFlow(transactions, CASH).toString()).toBe('-200000');
    expect(accountFlow(transactions, MVOLA).toString()).toBe('-400000');
    expect(transactions).toHaveLength(1);
  });

  it('compte inconnu (aucune allocation) : aucun solde impacté', () => {
    const transactions = [tx(EXPENSE_TYPE, [])];
    expect(accountFlow(transactions, CASH).toString()).toBe('0');
    expect(accountFlow(transactions, MVOLA).toString()).toBe('0');
  });

  it('transaction supprimée (deletedAt) : ignorée', () => {
    const active = tx(EXPENSE_TYPE, [allocation(CASH, '1000')]);
    const deleted = {
      ...tx(EXPENSE_TYPE, [allocation(CASH, '9000')]),
      deletedAt: new Date('2026-09-01'),
    };
    expect(accountFlow([active, deleted], CASH).toString()).toBe('-1000');
  });

  it('mélange revenus/dépenses actives sur plusieurs comptes', () => {
    const transactions = [
      tx(INCOME_TYPE, [allocation(CASH, '500000')]),
      tx(EXPENSE_TYPE, [allocation(MVOLA, '120000'), allocation(CASH, '30000')]),
    ];
    expect(accountFlow(transactions, CASH).toString()).toBe('470000');
    expect(accountFlow(transactions, MVOLA).toString()).toBe('-120000');
  });

  it('liste vide → 0', () => {
    expect(accountFlow([], CASH).toString()).toBe('0');
  });
});

describe('isActiveTransaction', () => {
  it('sans deletedAt → active', () => {
    expect(isActiveTransaction({ deletedAt: null })).toBe(true);
    expect(isActiveTransaction({})).toBe(true);
  });

  it('deletedAt renseigné → inactive', () => {
    expect(isActiveTransaction({ deletedAt: new Date() })).toBe(false);
  });
});

describe('adjustmentsTotal', () => {
  it('ajustement positif seul', () => {
    expect(adjustmentsTotal([{ amount: '20000' }]).toString()).toBe('20000');
  });

  it('ajustement négatif seul', () => {
    expect(adjustmentsTotal([{ amount: '-20000' }]).toString()).toBe('-20000');
  });

  it('plusieurs ajustements (+ et −)', () => {
    expect(
      adjustmentsTotal([{ amount: '20000' }, { amount: '-5000' }]).toString(),
    ).toBe('15000');
  });

  it('liste vide → 0', () => {
    expect(adjustmentsTotal([]).toString()).toBe('0');
  });
});

describe('currentBalance (formule finale)', () => {
  it('aucun mouvement : solde = solde de départ', () => {
    expect(currentBalance('100000', '0', '0').toString()).toBe('100000');
  });

  it('formule complète : départ + flux net des allocations + ajustements', () => {
    // départ 500 000 ; revenu alloué 200 000 ; dépense allouée 150 000
    // (flux net = +50 000) ; ajustement +20 000.
    expect(currentBalance('500000', '50000', '20000').toString()).toBe('570000');
  });

  it('exemple produit : solde calculé 100 000 corrigé à +20 000', () => {
    expect(currentBalance('0', '100000', '20000').toString()).toBe('120000');
  });

  it('correction négative du solde calculé (−20 000)', () => {
    expect(currentBalance('0', '100000', '-20000').toString()).toBe('80000');
  });

  it('dépenses supérieures au solde → solde négatif exact', () => {
    expect(currentBalance('1000', '-2500.5', '0').toString()).toBe('-1500.5');
  });

  it('grands montants exacts (pas de flottant)', () => {
    expect(currentBalance('999999999999999999.99', '0.01', '0').toString()).toBe(
      '1000000000000000000',
    );
  });
});

describe('Total disponible (sumAvailableBalance)', () => {
  it("l'épargne (SAVINGS) est exclue du total disponible", () => {
    const total = sumAvailableBalance([
      { type: 'BANK', balance: '100000' },
      { type: 'MVOLA', balance: '200000' },
      { type: 'CASH', balance: '0' },
      { type: SAVINGS, balance: '5000000' },
    ]);
    expect(total.toString()).toBe('300000');
  });

  it('liste vide → 0', () => {
    expect(sumAvailableBalance([]).toString()).toBe('0');
  });
});

