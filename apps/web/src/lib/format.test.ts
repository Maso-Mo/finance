import { describe, expect, it } from 'vitest';
import { formatMoney, formatSignedMoney, toISODate } from './format';

describe('formatMoney', () => {
  it('groupe les milliers en MGA', () => {
    expect(formatMoney('1150000', 'MGA')).toBe('1 150 000 Ar');
  });

  it('MGA sans décimales', () => {
    expect(formatMoney('0', 'MGA')).toBe('0 Ar');
  });

  it('EUR avec deux décimales', () => {
    expect(formatMoney('1500.5', 'EUR')).toBe('1 500,50 €');
  });

  it('solde négatif : signe avant le groupement', () => {
    expect(formatMoney('-30000', 'MGA')).toBe('-30 000 Ar');
  });
});

describe('formatSignedMoney', () => {
  it('dépense affichée en négatif', () => {
    expect(formatSignedMoney('15000', 'EXPENSE', 'MGA')).toBe(
      '-15 000 Ar',
    );
  });

  it('revenu affiché en positif', () => {
    expect(formatSignedMoney('250000.5', 'INCOME', 'EUR')).toBe(
      '+250 000,50 €',
    );
  });
});

describe('toISODate', () => {
  it('formate la date locale en YYYY-MM-DD', () => {
    expect(toISODate(new Date(2026, 8, 5))).toBe('2026-09-05');
  });
});
