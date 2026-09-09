import { describe, expect, it } from 'vitest';
import {
  extractCounterpartyName,
  extractCounterpartyNumber,
  extractSmsAmount,
  extractSmsBalanceAfter,
  extractSmsDate,
  extractSmsFee,
  extractSmsLocation,
  extractSmsReference,
  parseMoneySms,
  providerFromSender,
  smsDedupeKey,
} from '../src/index.js';

/**
 * SMS « mobile money » (finance-core) — SÉMANTIQUE TECHNIQUE.
 *
 * Règles verrouillées :
 *  - parsing PURE et déterministe (même message → même résultat) ;
 *  - un SMS décrit un ÉVÉNEMENT TECHNIQUE (MONEY_RECEIVED, MONEY_SENT,
 *    CASH_WITHDRAWAL, CASH_DEPOSIT, PAYMENT, UNKNOWN) — JAMAIS une
 *    classification comptable (INCOME/EXPENSE) automatique ;
 *  - champ absent = null (jamais inventé) ; `receivedAt` ≠ date d'occurrence.
 */

describe('SMS mobile money — provider', () => {
  it('1. expéditeurs connus → opérateur', () => {
    expect(providerFromSender('MVOLA')).toBe('MVOLA');
    expect(providerFromSender('mvola-info')).toBe('MVOLA');
    expect(providerFromSender('ORANGE')).toBe('ORANGE_MONEY');
    expect(providerFromSender('AIRTEL Money')).toBe('AIRTEL_MONEY');
  });

  it("2. expéditeur inconnu → null (aucune devinette)", () => {
    expect(providerFromSender('INCONNU')).toBeNull();
    expect(providerFromSender('')).toBeNull();
  });

  it('3. clé de déduplication stable (espaces/casse normalisés)', () => {
    const a = smsDedupeKey('Mvola', '  Vous avez   recu 1000 Ar ');
    const b = smsDedupeKey('MVOLA', 'Vous avez recu 1000 Ar');
    expect(a).toBe(b);
    expect(a.startsWith('sms|MVOLA|')).toBe(true);
  });
});

describe('SMS mobile money — montants', () => {
  it('4. devise après le nombre (point décimal)', () => {
    expect(extractSmsAmount('Vous avez recu 1,000.00 MGA')).toBe('1000.00');
  });

  it('5. devise après le nombre (virgule décimale + espace milliers)', () => {
    expect(extractSmsAmount('Vous avez recu 100 000,00 Ar')).toBe('100000.00');
  });

  it('6. devise avant le nombre', () => {
    expect(extractSmsAmount('Debit MGA 5000.00 chez JIRAMA')).toBe('5000.00');
  });

  it('7. nombre sans devise mais avec fraction décimale', () => {
    expect(extractSmsAmount('Paiement de 4500.00 a JIRAMA')).toBe('4500.00');
  });

  it("8. aucun montant exploitable → null", () => {
    expect(extractSmsAmount('Bonjour, votre solde est positif.')).toBeNull();
    expect(extractSmsAmount('RDV le 15/09 a 10:30')).toBeNull();
  });
});

describe('SMS mobile money — dates', () => {
  it('9. date JJ/MM/AAAA → YYYY-MM-DD', () => {
    expect(extractSmsDate('fait le 12/09/2026 a 08:05')).toBe('2026-09-12');
  });

  it('10. date ISO acceptée', () => {
    expect(extractSmsDate('operation 2026-09-12 confirmee')).toBe('2026-09-12');
  });

  it('11. date impossible → null', () => {
    expect(extractSmsDate('le 32/13/2026')).toBeNull();
  });
});

describe('SMS mobile money — champs facultatifs', () => {
  it('12. frais et solde après opération lus explicitement', () => {
    const body =
      'Vous avez recu 100 000,00 Ar de RAKOTO. Frais: 250,00 Ar. Solde: 124 750,00 Ar.';
    expect(extractSmsFee(body)).toBe('250.00');
    expect(extractSmsBalanceAfter(body)).toBe('124750.00');
  });

  it('13. contrepartie (nom) et référence extraites, numéro null sinon', () => {
    const body =
      'Vous avez recu 25 000,00 Ar de RAKOTO NOMENJANAHARY. Ref 84930.';
    expect(extractCounterpartyName(body)).toContain('RAKOTO');
    expect(extractSmsReference(body)).toBe('84930');
    expect(extractCounterpartyNumber(body)).toBeNull();
  });

  it('14. numéro de contrepartie reconnu (envoi vers un mobile)', () => {
    const body =
      'Vous avez envoye 50 000,00 Ar a 0341200000. Frais: 100,00 Ar. Solde: 900.00 Ar.';
    expect(extractCounterpartyNumber(body)).toBe('0341200000');
    expect(extractCounterpartyName(body)).toBeNull();
  });

  it('15. lieu absent → null (jamais inventé)', () => {
    expect(
      extractSmsLocation('Vous avez recu 10 000 Ar de X. Ref 1234.'),
    ).toBeNull();
  });
});
describe('SMS mobile money — parsing complet (sémantique technique)', () => {
  it('16. MVola reçu → MONEY_RECEIVED (jamais INCOME)', () => {
    const parsed = parseMoneySms({
      sender: 'MVOLA',
      body: 'Vous avez recu 25 000,00 Ar de RAKOTO NOMENJANAHARY. Ref 84930 le 12/09/2026 a 08:05.',
    });
    expect(parsed.provider).toBe('MVOLA');
    expect(parsed.type).toBe('MONEY_RECEIVED');
    expect(parsed.type).not.toBe('INCOME');
    expect(parsed.amount).toBe('25000.00');
    expect(parsed.occurredAt).toBe('2026-09-12');
    expect(parsed.reference).toBe('84930');
    expect(parsed.counterpartyName).toContain('RAKOTO');
    expect(parsed.confidence).toBe('high');
  });

  it('17. MVola envoi → MONEY_SENT (jamais EXPENSE)', () => {
    const parsed = parseMoneySms({
      sender: 'MVOLA',
      body: 'Vous avez envoye 5 000,00 Ar a RAVELO. Frais: 100,00 Ar. Solde: 40 000,00 Ar le 13/09/2026.',
    });
    expect(parsed.type).toBe('MONEY_SENT');
    expect(parsed.type).not.toBe('EXPENSE');
    expect(parsed.amount).toBe('5000.00');
    expect(parsed.fee).toBe('100.00');
    expect(parsed.balanceAfter).toBe('40000.00');
    expect(parsed.counterpartyName).toContain('RAVELO');
    expect(parsed.occurredAt).toBe('2026-09-13');
  });

  it('18. MVola retrait agent → CASH_WITHDRAWAL (jamais EXPENSE)', () => {
    const parsed = parseMoneySms({
      sender: 'MVOLA',
      body: 'Retrait de 20 000,00 Ar a l agence Analakely. Frais: 1 500,00 Ar. Solde: 100 000,00 Ar. Ref 3321 le 14/09/2026.',
    });
    expect(parsed.type).toBe('CASH_WITHDRAWAL');
    expect(parsed.type).not.toBe('EXPENSE');
    expect(parsed.amount).toBe('20000.00');
    expect(parsed.location).toBe('Analakely');
  });

  it('19. MVola dépôt agent → CASH_DEPOSIT (jamais INCOME)', () => {
    const parsed = parseMoneySms({
      sender: 'MVOLA',
      body: 'Depot de 50 000,00 Ar au guichet Antanimena. Ref 7788 le 15/09/2026.',
    });
    expect(parsed.type).toBe('CASH_DEPOSIT');
    expect(parsed.type).not.toBe('INCOME');
    expect(parsed.location).toBe('Antanimena');
  });

  it('20. Orange reçu → MONEY_RECEIVED', () => {
    const parsed = parseMoneySms({
      sender: 'ORANGE',
      body: 'Vous avez recu 10 000,00 Ar de 0341200000. Solde: 20 000,00 Ar. Ref 112233.',
    });
    expect(parsed.provider).toBe('ORANGE_MONEY');
    expect(parsed.type).toBe('MONEY_RECEIVED');
    expect(parsed.amount).toBe('10000.00');
    expect(parsed.counterpartyNumber).toBe('0341200000');
  });

  it('21. Orange envoi → MONEY_SENT', () => {
    const parsed = parseMoneySms({
      sender: 'ORANGE',
      body: 'Vous avez envoye 4 500,00 Ar a RANDRIANARISOA. Frais: 50,00 Ar. Ref 4433.',
    });
    expect(parsed.provider).toBe('ORANGE_MONEY');
    expect(parsed.type).toBe('MONEY_SENT');
    expect(parsed.amount).toBe('4500.00');
    expect(parsed.counterpartyName).toContain('RANDRIANARISOA');
  });

  it('22. Airtel crédit générique → MONEY_RECEIVED (confiance moyenne)', () => {
    const parsed = parseMoneySms({
      sender: 'AIRTEL_MONEY',
      body: 'Solde credite de 8 000,00 Ar. Ref A77812.',
    });
    expect(parsed.provider).toBe('AIRTEL_MONEY');
    expect(parsed.type).toBe('MONEY_RECEIVED');
    expect(parsed.confidence).toBe('medium');
    expect(parsed.amount).toBe('8000.00');
  });

  it('23. Airtel débit générique → MONEY_SENT (confiance moyenne)', () => {
    const parsed = parseMoneySms({
      sender: 'AIRTEL_MONEY',
      body: 'Solde debite de 3 000,00 Ar. Ref B5566.',
    });
    expect(parsed.type).toBe('MONEY_SENT');
    expect(parsed.confidence).toBe('medium');
  });

  it('24. paiement marchand clairement identifié → PAYMENT (candidat)', () => {
    const parsed = parseMoneySms({
      sender: 'MVOLA',
      body: 'Paiement de 45 000,00 Ar a JIRAMA par MVola. Ref 4432 le 13/09/2026.',
    });
    expect(parsed.type).toBe('PAYMENT');
    expect(parsed.type).not.toBe('EXPENSE');
    expect(parsed.amount).toBe('45000.00');
    expect(parsed.counterpartyName).toContain('JIRAMA');
  });

  it('25. message sans événement → UNKNOWN (jamais inventé)', () => {
    const parsed = parseMoneySms({
      sender: 'MVOLA',
      body: 'Bienvenue chez MVola. Votre code PIN a ete change.',
    });
    expect(parsed.type).toBe('UNKNOWN');
    expect(parsed.amount).toBeNull();
    expect(parsed.confidence).toBe('low');
  });

  it('26. direction contradictoire (reçu + envoyé) → UNKNOWN prudent', () => {
    const parsed = parseMoneySms({
      sender: 'ORANGE',
      body: 'Vous avez envoye 10 000 Ar a RAKOTO et vous avez recu 10 000 Ar de RAVAO. Ref 1234.',
    });
    expect(parsed.type).toBe('UNKNOWN');
    expect(parsed.confidence).toBe('low');
    expect(parsed.amount).toBe('10000.00');
  });

  it('27. `receivedAt` ne devient jamais la date d’occurrence', () => {
    const parsed = parseMoneySms({
      sender: 'AIRTEL_MONEY',
      body: 'Credit de 8 000,00 Ar. Ref A77812.',
      receivedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(parsed.occurredAt).toBeNull();
    expect(parsed.receivedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('28. sémantique technique ≠ catégories comptables', () => {
    const received = parseMoneySms({
      sender: 'MVOLA',
      body: 'Vous avez recu 10 000 Ar de X.',
    });
    expect(received.type).toBe('MONEY_RECEIVED');
    expect(received.type).not.toBe('INCOME');
    expect('MONEY_SENT').not.toBe('EXPENSE');
    expect('CASH_WITHDRAWAL').not.toBe('EXPENSE');
    expect('CASH_DEPOSIT').not.toBe('INCOME');
    expect('PAYMENT').not.toBe('EXPENSE');
  });
});

