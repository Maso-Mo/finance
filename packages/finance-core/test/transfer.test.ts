import { describe, expect, it } from 'vitest';
import {
  availableBalanceImpactOfTransfer,
  currentBalanceWithTransfers,
  netTransferFlow,
  sumAvailableBalance,
  transferDeltaForAccount,
  transferDestinationDelta,
  transferNetFromTotals,
  transferSourceDelta,
  type BalanceEntry,
  type TransferLike,
} from '../src/index.js';

/**
 * TRANSFERTS INTERNES (étape 9) — fonctions pures de finance-core.
 *
 * Invariant absolu : un transfert n'est NI une Transaction EXPENSE NI une
 * Transaction INCOME. Il n'impacte que les soldes courants dérivés :
 *   source −(amount + fee)   destination +amount.
 */

const CASH = 'account-cash';
const MVOLA = 'account-mvola';
const SAVINGS = 'account-savings';

function transfer(
  sourceAccountId: string,
  destinationAccountId: string,
  amount: string,
  feeAmount = '0',
  deletedAt?: unknown,
): TransferLike {
  return { sourceAccountId, destinationAccountId, amount, feeAmount, deletedAt };
}

describe('transferSourceDelta / transferDestinationDelta', () => {
  it('source sans frais = −amount', () => {
    expect(transferSourceDelta('100000').toString()).toBe('-100000');
    expect(transferSourceDelta('0.5').toString()).toBe('-0.5');
  });

  it('source avec frais = −(amount + fee)', () => {
    expect(transferSourceDelta('100000', '2500').toString()).toBe('-102500');
  });

  it('destination = +amount (jamais le fee)', () => {
    expect(transferDestinationDelta('100000').toString()).toBe('100000');
  });

  it('calcul exact decimal (jamais de flottant)', () => {
    expect(transferSourceDelta('0.2', '0.1').toString()).toBe('-0.3');
    expect(transferSourceDelta('100.01', '0.99').toString()).toBe('-101');
  });

  it('gros montants exacts (NUMERIC(20,2))', () => {
    expect(
      transferSourceDelta('999999999999999999.99', '0.01').toString(),
    ).toBe('-1000000000000000000');
    expect(transferDestinationDelta('999999999999999999.99').toString()).toBe(
      '999999999999999999.99',
    );
  });

  it('fee par défaut à 0', () => {
    expect(transferSourceDelta('100000').toString()).toBe('-100000');
  });
});

describe('transferDeltaForAccount / netTransferFlow', () => {
  it('source = −(amount+fee), destination = +amount, tiers = 0', () => {
    const t = transfer(MVOLA, CASH, '100000', '2500');
    expect(transferDeltaForAccount(t, MVOLA).toString()).toBe('-102500');
    expect(transferDeltaForAccount(t, CASH).toString()).toBe('100000');
    expect(transferDeltaForAccount(t, SAVINGS).toString()).toBe('0');
  });

  it('un transfert soft-deleted est totalement ignoré', () => {
    const active = transfer(MVOLA, CASH, '100000', '2500');
    const deleted = transfer(MVOLA, CASH, '100000', '2500', new Date());
    expect(transferDeltaForAccount(deleted, MVOLA).toString()).toBe('0');
    expect(transferDeltaForAccount(deleted, CASH).toString()).toBe('0');
    expect(netTransferFlow([active, deleted], MVOLA).toString()).toBe('-102500');
    expect(netTransferFlow([active, deleted], CASH).toString()).toBe('100000');
  });

  it('transferNetFromTotals : crédits − débits (débit = amount + fee)', () => {
    const net = transferNetFromTotals('102500', '100000');
    expect(net.toString()).toBe('-2500');
    expect(transferNetFromTotals('0', '100000').toString()).toBe('100000');
    expect(transferNetFromTotals('102500', '0').toString()).toBe('-102500');
  });
});

describe('currentBalanceWithTransfers (transactions + ajustements + transferts)', () => {
  it('solde courant complet dérivé : initial + flux − dépenses + ajustement + transferts', () => {
    // CASH : 500 000 + revenus nets (300 000 − 50 000) + ajustement 10 000
    // + transfert reçu 100 000 = 860 000.
    const balance = currentBalanceWithTransfers(
      '500000',
      '250000',
      '10000',
      [transfer(MVOLA, CASH, '100000', '0')],
      CASH,
    );
    expect(balance.toString()).toBe('860000');
  });

  it('currentBalanceWithTransfers ignore un transfert supprimé', () => {
    const balance = currentBalanceWithTransfers(
      '100000',
      '0',
      '0',
      [transfer(MVOLA, CASH, '20000', '0', new Date())],
      CASH,
    );
    expect(balance.toString()).toBe('100000');
  });
});

describe('Impact sur le Total disponible (règle disponible = hors Épargne)', () => {
  function total(balances: BalanceEntry[]): string {
    return sumAvailableBalance(balances).toString();
  }

  it('disponible → disponible sans frais : Total inchangé', () => {
    const impact = availableBalanceImpactOfTransfer('100000', '0', 'MVOLA', 'CASH');
    expect(impact.toString()).toBe('0');
    const before = total([
      { type: 'MVOLA', balance: '500000' },
      { type: 'CASH', balance: '100000' },
      { type: 'SAVINGS', balance: '100000' },
    ]);
    const after = total([
      { type: 'MVOLA', balance: '400000' },
      { type: 'CASH', balance: '200000' },
      { type: 'SAVINGS', balance: '100000' },
    ]);
    expect(before).toBe('600000');
    expect(after).toBe(before);
  });

  it('disponible → disponible avec frais : Total −fee uniquement', () => {
    const impact = availableBalanceImpactOfTransfer('100000', '2500', 'MVOLA', 'CASH');
    expect(impact.toString()).toBe('-2500');
    const before = total([
      { type: 'MVOLA', balance: '500000' },
      { type: 'CASH', balance: '100000' },
    ]);
    const after = total([
      { type: 'MVOLA', balance: '397500' },
      { type: 'CASH', balance: '200000' },
    ]);
    expect(before).toBe('600000');
    expect(after).toBe('597500');
  });

  it('disponible → Épargne : Total −amount', () => {
    const impact = availableBalanceImpactOfTransfer('100000', '0', 'CASH', 'SAVINGS');
    expect(impact.toString()).toBe('-100000');
    const after = total([
      { type: 'CASH', balance: '400000' },
      { type: 'SAVINGS', balance: '200000' },
    ]);
    expect(after).toBe('400000');
  });

  it('disponible → Épargne avec frais : Total −(amount + fee)', () => {
    const impact = availableBalanceImpactOfTransfer('100000', '2500', 'CASH', 'SAVINGS');
    expect(impact.toString()).toBe('-102500');
  });

  it('Épargne → disponible : Total +amount (le fee reste sur l’Épargne)', () => {
    const impact = availableBalanceImpactOfTransfer('100000', '2500', 'SAVINGS', 'CASH');
    expect(impact.toString()).toBe('100000');
    const after = total([
      { type: 'CASH', balance: '200000' },
      { type: 'SAVINGS', balance: '197500' },
    ]);
    expect(after).toBe('200000');
  });
});

