import { describe, expect, it } from 'vitest';
import {
  currentBalance,
  entryDelta,
  EXPENSE_TYPE,
  INCOME_TYPE,
  netFlow,
  transactionTotals,
  type LedgerEntry,
} from '../src/index.js';

function entry(type: string, amount: string): LedgerEntry {
  return { type, amount };
}

describe('entryDelta', () => {
  it('une dépense est un flux sortant (négatif)', () => {
    expect(entryDelta(entry(EXPENSE_TYPE, '15000')).toString()).toBe('-15000');
  });

  it('un revenu est un flux entrant (positif)', () => {
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

describe('currentBalance (solde dérivé)', () => {
  it('solde de départ seul (aucune opération)', () => {
    expect(currentBalance('100000', []).toString()).toBe('100000');
  });

  it('solde = départ + revenus − dépenses', () => {
    // Exemple : départ 500 000, revenu 200 000, dépense 150 000.
    const balance = currentBalance('500000', [
      entry(INCOME_TYPE, '200000'),
      entry(EXPENSE_TYPE, '150000'),
    ]);
    expect(balance.toString()).toBe('550000');
  });

  it('dépenses supérieures au solde → solde négatif (reste exact)', () => {
    const balance = currentBalance('1000', [entry(EXPENSE_TYPE, '2500.5')]);
    expect(balance.toString()).toBe('-1500.5');
  });

  it('grands montants exacts (pas de flottant)', () => {
    const balance = currentBalance('999999999999999999.99', [
      entry(INCOME_TYPE, '0.01'),
    ]);
    expect(balance.toString()).toBe('1000000000000000000');
  });
});
