import { describe, expect, it } from 'vitest';
import {
  normalizeMoneyText,
  parseStatementText,
  splitStatementLine,
  statementRowKey,
} from '../src/index.js';

/**
 * Relevés (finance-core) — extraction PURE, LOCALE, SANS LLM.
 *
 * Règles verrouillées :
 *  - le sens est EXPLICITE (montant signé OU colonne débit/crédit) ;
 *  - une ligne ambiguë est IGNORÉE avec une raison (jamais devinée) ;
 *  - un relevé ne produit que des CANDIDATS : aucune écriture directe ;
 *  - montants en chaîne décimale exacte ; `rowKey` déduplique.
 */

describe('Relevé — normalisation', () => {
  it('1. montants signés et espaces de milliers', () => {
    expect(normalizeMoneyText('4500.00')).toBe('4500.00');
    expect(normalizeMoneyText('-4500')).toBe('-4500.00');
    expect(normalizeMoneyText('+150000')).toBe('150000.00');
    expect(normalizeMoneyText('1 234,56')).toBe('1234.56');
  });

  it('2. montant invalide ou nul → null', () => {
    expect(normalizeMoneyText('abc')).toBeNull();
    expect(normalizeMoneyText('0')).toBeNull();
    expect(normalizeMoneyText('-0.00')).toBeNull();
    expect(normalizeMoneyText('1.2.3')).toBeNull();
  });

  it('3. séparateurs de colonnes (tab > ; > | > ,)', () => {
    expect(splitStatementLine('2026-09-01\tMarche\t-4500.00')).toHaveLength(3);
    expect(splitStatementLine('2026-09-01;Marche;4500.00')).toHaveLength(3);
  });
});

describe('Relevé — grammaire montant signé', () => {
  it('4. lignes signées → lignes INCOME/EXPENSE', () => {
    const text = [
      'date;libelle;montant',
      '2026-09-01;Marche Alakamisy;-4500.00',
      '2026-09-02;Vente zebu;+1500000',
      '2026-09-03;Carburant;-20000',
    ].join('\n');
    const result = parseStatementText(text, { provider: 'BANK' });
    expect(result.headers).toEqual([1]);
    expect(result.ignored).toHaveLength(0);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({
      kind: 'EXPENSE',
      amount: '4500.00',
      date: '2026-09-01',
      description: 'Marche Alakamisy',
    });
    expect(result.rows[1]).toMatchObject({
      kind: 'INCOME',
      amount: '1500000.00',
      date: '2026-09-02',
    });
  });

  it('5. ligne sans montant signé → ignorée avec raison', () => {
    const result = parseStatementText('Releve mensuel - Septembre 2026');
    expect(result.rows).toHaveLength(0);
    expect(result.ignored).toHaveLength(1);
    expect(result.ignored[0]?.reason).toContain('exploitable');
  });
});

describe('Relevé — grammaire colonnes débit / crédit', () => {
  it('6. débit et crédit dans des colonnes séparées', () => {
    const text = [
      'date;description;debit;credit',
      '01/09/2026;Retrait distributeur;20000.00;',
      '01/09/2026;Virement salaire;;1500000.00',
      '02/09/2026;Ligne sans argent;;',
    ].join('\n');
    const result = parseStatementText(text, { provider: 'MVOLA' });
    expect(result.headers).toEqual([1]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      kind: 'EXPENSE',
      amount: '20000.00',
      date: '2026-09-01',
      sourceColumn: 'debit',
    });
    expect(result.rows[1]).toMatchObject({
      kind: 'INCOME',
      amount: '1500000.00',
      sourceColumn: 'credit',
    });
    expect(result.ignored[0]?.reason).toContain('aucun montant');
  });

  it("7. débit ET crédit remplis → jamais deviné, ligne ignorée", () => {
    const result = parseStatementText(
      '2026-09-01;Double saisie;20000.00;20000.00',
    );
    expect(result.rows).toHaveLength(0);
    expect(result.ignored[0]?.reason).toContain('toutes les deux');
  });
});

describe('Relevé — candidats et déduplication', () => {
  it('8. `rowKey` est canonique (casse et espaces normalisés)', () => {
    const a = statementRowKey({
      kind: 'EXPENSE',
      amount: '4500.00',
      date: '2026-09-01',
      description: '  Marche  Alakamisy ',
    });
    const b = statementRowKey({
      kind: 'EXPENSE',
      amount: '4500.00',
      date: '2026-09-01',
      description: 'marche alakamisy',
    });
    expect(a).toBe(b);
  });

  it("9. un relevé ne crée jamais d'écriture : rows = candidats purs", () => {
    const result = parseStatementText('2026-09-01;Test;+100');
    expect(result.rows[0]).toMatchObject({
      line: 1,
      raw: '2026-09-01;Test;+100',
      kind: 'INCOME',
      amount: '100.00',
    });
  });
});
