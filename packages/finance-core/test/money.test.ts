import { describe, expect, it } from 'vitest';
import {
  sum,
  sumAvailableBalance,
  toMoney,
  SAVINGS_ACCOUNT_TYPE,
  type BalanceEntry,
} from '../src/index.js';

function entry(
  type: string,
  balance: string,
): BalanceEntry {
  return { type, balance };
}

// Exemple du cahier des charges (MGA, sans décimales).
const accounts: BalanceEntry[] = [
  entry('BANK', '500000'),
  entry('MVOLA', '300000'),
  entry('ORANGE_MONEY', '100000'),
  entry('AIRTEL_MONEY', '100000'),
  entry('CASH', '150000'),
  entry(SAVINGS_ACCOUNT_TYPE, '400000'),
];

describe('sumAvailableBalance', () => {
  it('total disponible = banque + mobile money + cash, sans l’épargne', () => {
    const total = sumAvailableBalance(accounts);
    expect(total.toString()).toBe('1150000'); // et non 1550000
  });

  it('l’épargne est exclue du total', () => {
    const total = sumAvailableBalance(accounts);
    const withSavings = sum(accounts.map((a) => a.balance));
    expect(withSavings.toString()).toBe('1550000');
    expect(total.toString()).toBe('1150000');
  });

  it('comptes à zéro → total zéro', () => {
    const zeroes = [
      entry('BANK', '0'),
      entry('MVOLA', '0.00'),
      entry(SAVINGS_ACCOUNT_TYPE, '0'),
    ];
    expect(sumAvailableBalance(zeroes).toString()).toBe('0');
  });

  it('liste vide → 0', () => {
    expect(sumAvailableBalance([]).toString()).toBe('0');
  });

  it('grands montants exacts', () => {
    const large = [
      entry('BANK', '999999999999999999.99'),
      entry('CASH', '1.01'),
    ];
    expect(sumAvailableBalance(large).toString()).toBe('1000000000000000001');
  });

  it('calcul exact sans erreur flottante (0.1 + 0.2 = 0.3)', () => {
    const total = sumAvailableBalance([
      entry('CASH', '0.1'),
      entry('BANK', '0.2'),
    ]);
    expect(total.toString()).toBe('0.3');
    expect(total.toNumber()).toBe(0.3);
  });
});

describe('toMoney', () => {
  it('rejette les valeurs non finies', () => {
    expect(() => toMoney(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => toMoney(Number.NaN)).toThrow();
  });
});
