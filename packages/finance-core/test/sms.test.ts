import { describe, expect, it } from 'vitest';
import {
  extractSmsAmount,
  extractSmsDate,
  parseMoneySms,
  providerFromSender,
  smsDedupeKey,
} from '../src/index.js';

/**
 * Socle SMS « mobile money » (finance-core).
 *
 * Règles verrouillées :
 *  - parsing PURE et déterministe (même message → même résultat) ;
 *  - un SMS ne crée jamais d'écriture : `kind` reste UNKNOWN dès que la
 *    direction est ambiguë ou absente ;
 *  - `receivedAt` n'est jamais utilisé comme date d'occurrence : seule une
 *    date LUE dans le corps est proposée.
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
    expect(extractSmsDate('operation 2026-09-12 confirmée')).toBe('2026-09-12');
  });

  it('11. date impossible → null', () => {
    expect(extractSmsDate('le 32/13/2026')).toBeNull();
  });
});

describe('SMS mobile money — parsing complet', () => {
  it('12. MVola reçu → INCOME (montant, date, référence)', () => {
    const parsed = parseMoneySms({
      sender: 'MVOLA',
      body: 'Vous avez recu 25 000,00 Ar de RAKOTO NOMENJANAHARY. Ref 84930 le 12/09/2026 a 08:05.',
    });
    expect(parsed.provider).toBe('MVOLA');
    expect(parsed.kind).toBe('INCOME');
    expect(parsed.amount).toBe('25000.00');
    expect(parsed.occurredAt).toBe('2026-09-12');
    expect(parsed.reference).toBe('84930');
    expect(parsed.counterparty).toContain('RAKOTO');
  });

  it('13. Paiement sortant MVola → EXPENSE', () => {
    const parsed = parseMoneySms({
      sender: 'MVOLA',
      body: 'Paiement de 5 000,00 Ar a JIRAMA par MVola. Ref 4432 le 13/09/2026.',
    });
    expect(parsed.kind).toBe('EXPENSE');
    expect(parsed.amount).toBe('5000.00');
    expect(parsed.reference).toBe('4432');
  });

  it('14. message sans sens explicite → UNKNOWN (jamais inventé)', () => {
    const parsed = parseMoneySms({
      sender: 'MVOLA',
      body: 'Bienvenue chez MVola. Votre code PIN a ete change.',
    });
    expect(parsed.kind).toBe('UNKNOWN');
    expect(parsed.amount).toBeNull();
  });

  it('15. corps ambigu (recu + paiement) → UNKNOWN prudent', () => {
    const parsed = parseMoneySms({
      sender: 'ORANGE',
      body: 'Recu paiement de 10 000 Ar. Ref 1234.',
    });
    expect(parsed.kind).toBe('UNKNOWN');
    expect(parsed.amount).toBe('10000.00');
  });

  it('16. `receivedAt` ne devient jamais la date d’occurrence', () => {
    const parsed = parseMoneySms({
      sender: 'AIRTEL_MONEY',
      body: 'Credit de 8 000,00 Ar. Ref A77812.',
      receivedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(parsed.occurredAt).toBeNull();
    expect(parsed.kind).toBe('INCOME');
  });
});
