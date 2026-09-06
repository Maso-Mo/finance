import { describe, expect, it } from 'vitest';
import {
  debtRemaining,
  debtSettledAmount,
  debtSettlementAccountDelta,
  debtStatus,
  isDebtOverpayment,
  standardDebtSettlementDelta,
  type DebtTemporalStatus,
} from '../src/index.js';

/**
 * DETTES / CRÉANCES / RÈGLEMENTS (étape 11) — finance-core.
 *
 * Invariants testés : les montants sont toujours POSITIFS (la direction porte
 * le sens) ; le restant est DÉRIVÉ (original − Σ règlements actifs) ; le
 * statut OPEN/SETTLED/OVERDUE n'est jamais stocké ; un règlement I_OWE est un
 * delta négatif et un règlement OWED_TO_ME STANDARD un delta positif ; un
 * règlement d'avance de revenu ne porte AUCUN delta de solde (le +compte est
 * porté par sa Transaction INCOME liée — jamais les deux) ; le sur-paiement
 * est détecté en decimal.js exact.
 */

describe('dette I_OWE — remaining dérivé', () => {
  it('1. 100000 emprunté, 0 réglé → remaining 100000', () => {
    const settled = debtSettledAmount([]);
    expect(settled.toString()).toBe('0');
    expect(debtRemaining('100000', settled).toString()).toBe('100000');
  });

  it('2. I_OWE après 40000 → remaining 60000', () => {
    const settled = debtSettledAmount(['40000']);
    expect(debtRemaining('100000', settled).toString()).toBe('60000');
  });
});

describe('créance OWED_TO_ME — remaining dérivé', () => {
  it('3. 500000 dû, 150000 reçu → remaining 350000', () => {
    const settled = debtSettledAmount(['150000']);
    expect(debtRemaining('500000', settled).toString()).toBe('350000');
  });

  it('4. plusieurs règlements (100000 + 150000 sur 500000)', () => {
    const settled = debtSettledAmount(['100000', '150000']);
    expect(settled.toString()).toBe('250000');
    expect(debtRemaining('500000', settled).toString()).toBe('250000');
  });

  it('5. remaining zéro quand tout est réglé', () => {
    const settled = debtSettledAmount(['100000', '150000', '250000']);
    expect(debtRemaining('500000', settled).toString()).toBe('0');
  });
});

describe('deltas de solde des règlements', () => {
  it('6. règlement I_OWE → delta négatif', () => {
    expect(standardDebtSettlementDelta('I_OWE', '40000').toString()).toBe(
      '-40000',
    );
  });

  it('7. règlement OWED_TO_ME STANDARD → delta positif', () => {
    expect(standardDebtSettlementDelta('OWED_TO_ME', '40000').toString()).toBe(
      '40000',
    );
  });

  it('8. direction inconnue refusée (jamais de signe implicite)', () => {
    expect(() => standardDebtSettlementDelta('SIDE', '10')).toThrow(
      RangeError,
    );
  });
});

describe('avance sur revenu (cas spécial explicite)', () => {
  it('9. avance OWED_TO_ME → delta de solde 0 (porté par la Transaction INCOME)', () => {
    expect(
      debtSettlementAccountDelta(
        'OWED_TO_ME',
        'INCOME_ADVANCE_RECEIVABLE',
        '150000',
      ).toString(),
    ).toBe('0');
  });

  it('10. I_OWE conserve le delta négatif', () => {
    expect(
      debtSettlementAccountDelta('I_OWE', 'STANDARD', '40000').toString(),
    ).toBe('-40000');
  });

  it('11. INCOME_ADVANCE_RECEIVABLE interdit pour I_OWE', () => {
    expect(() =>
      debtSettlementAccountDelta('I_OWE', 'INCOME_ADVANCE_RECEIVABLE', '10'),
    ).toThrow(RangeError);
  });
});

describe('statuts temporels dérivés', () => {
  it('12. remaining > 0 sans échéance → OPEN', () => {
    expect(debtStatus('100', null, '2026-09-06')).toBe('OPEN');
  });

  it('13. remaining 0 → SETTLED (même si échéance passée)', () => {
    const status: DebtTemporalStatus = debtStatus(
      '0',
      '2026-08-01',
      '2026-09-06',
    );
    expect(status).toBe('SETTLED');
  });

  it('14. remaining > 0 avec échéance passée → OVERDUE', () => {
    expect(debtStatus('100', '2026-08-01', '2026-09-06')).toBe('OVERDUE');
  });

  it('15. échéance aujourd’hui → OPEN (pas encore en retard)', () => {
    expect(debtStatus('100', '2026-09-06', '2026-09-06')).toBe('OPEN');
  });
});

describe('sur-remboursement', () => {
  it('16. paiement supérieur au restant détecté', () => {
    // reste 30000 sur 100000 → paiement 40000 interdit.
    expect(isDebtOverpayment('100000', '70000', '40000')).toBe(true);
  });

  it('17. paiement exactement égal au restant autorisé', () => {
    expect(isDebtOverpayment('100000', '70000', '30000')).toBe(false);
  });

  it('18. paiement partiel autorisé', () => {
    expect(isDebtOverpayment('100000', '60000', '30000')).toBe(false);
  });
});

describe('précision décimale et gros montants', () => {
  it('19. decimal exact (jamais de flottant)', () => {
    expect(debtSettledAmount(['0.1', '0.2']).toString()).toBe('0.3');
    expect(debtRemaining('0.3', '0.1').toString()).toBe('0.2');
  });

  it('20. gros montants (NUMERIC(20,2)) sans arrondi', () => {
    const original = '99999999999999999999.99';
    const settled = debtSettledAmount(['1.01', '0.01']);
    expect(settled.toString()).toBe('1.02');
    expect(debtRemaining(original, settled).toString()).toBe(
      '99999999999999999998.97',
    );
  });

  it('21. montant de règlement nul ou négatif refusé', () => {
    expect(() => debtSettledAmount(['0'])).toThrow(RangeError);
    expect(() => debtSettledAmount(['-1'])).toThrow(RangeError);
  });
});
