import { describe, expect, it } from 'vitest';
import {
  savingsContributionTotal,
  savingsPercentageTarget,
  savingsProgressStatus,
  savingsRemaining,
  savingsTargetFixed,
  type SavingsProgressStatus,
} from '../src/index.js';

/**
 * ÉPARGNE MENSUELLE PLANIFIÉE (étape 10) — finance-core.
 *
 * Règles testées :
 *  - cible FIXED = valeur fixée ;
 *  - cible PERCENTAGE = revenus RÉELLEMENT reçus × % / 100 (arrondi 2 déc.) ;
 *  - contribution = AccountTransfer.amount (les frais ne comptent jamais) ;
 *  - remaining peut être négatif (dépassement) — jamais clampé ;
 *  - statut DÉRIVÉ simple (NO_INCOME_YET / IN_PROGRESS / REACHED).
 */

describe('cible d’un plan FIXED', () => {
  it('1. fixed 100000 → target 100000', () => {
    expect(savingsTargetFixed('100000').toString()).toBe('100000');
  });

  it('2. fixed avec décimales conservées', () => {
    expect(savingsTargetFixed('150.50').toString()).toBe('150.5');
  });
});

describe('cible d’un plan PERCENTAGE', () => {
  it('3. 20 % de 800000 → 160000', () => {
    expect(savingsPercentageTarget('800000', '20').toString()).toBe('160000');
  });

  it('4. 0 revenu → 0', () => {
    expect(savingsPercentageTarget('0', '20').toString()).toBe('0');
  });

  it('5. 100 % de 500000 → 500000', () => {
    expect(savingsPercentageTarget('500000', '100').toString()).toBe('500000');
  });

  it('6. arrondi exact à 2 décimales (100000.99 × 20 % → 20000.20)', () => {
    expect(savingsPercentageTarget('100000.99', '20').toString()).toBe('20000.2');
  });

  it('7. pourcentage hors bornes refusé', () => {
    expect(() => savingsPercentageTarget('1000', '0')).toThrow(RangeError);
    expect(() => savingsPercentageTarget('1000', '101')).toThrow(RangeError);
    expect(() => savingsPercentageTarget('1000', '-5')).toThrow(RangeError);
  });

  it('8. grande valeur exacte', () => {
    expect(savingsPercentageTarget('99999999999999.99', '12.5').toString()).toBe(
      '12500000000000',
    );
  });
});

describe('contributions au plan', () => {
  it('9. contribution 40k + 60k = 100k', () => {
    expect(savingsContributionTotal(['40000', '60000']).toString()).toBe(
      '100000',
    );
  });

  it('10. aucune contribution → 0', () => {
    expect(savingsContributionTotal([]).toString()).toBe('0');
  });

  it('11. exactitude décimale 0.1 + 0.2', () => {
    expect(savingsContributionTotal(['0.1', '0.2']).toString()).toBe('0.3');
  });
});

describe('remaining', () => {
  it('12. remaining positif', () => {
    expect(savingsRemaining('100000', '40000').toString()).toBe('60000');
  });

  it('13. remaining nul', () => {
    expect(savingsRemaining('100000', '100000').toString()).toBe('0');
  });

  it('14. remaining négatif jamais clampé (dépassement 130k / 100k)', () => {
    expect(savingsRemaining('100000', '130000').toString()).toBe('-30000');
  });
});

describe('statut dérivé', () => {
  function status(options: {
    mode: string;
    target: string;
    contributed: string;
    income: string;
  }): SavingsProgressStatus {
    return savingsProgressStatus({
      mode: options.mode,
      target: options.target,
      contributed: options.contributed,
      eligibleIncome: options.income,
    });
  }

  it('15. FIXED non atteint → IN_PROGRESS', () => {
    expect(
      status({ mode: 'FIXED', target: '100000', contributed: '40000', income: '0' }),
    ).toBe('IN_PROGRESS');
  });

  it('16. FIXED atteint → REACHED', () => {
    expect(
      status({ mode: 'FIXED', target: '100000', contributed: '100000', income: '0' }),
    ).toBe('REACHED');
  });

  it('17. PERCENTAGE sans revenus et sans contribution → NO_INCOME_YET', () => {
    expect(
      status({ mode: 'PERCENTAGE', target: '0', contributed: '0', income: '0' }),
    ).toBe('NO_INCOME_YET');
  });

  it('18. PERCENTAGE avec revenus et cible en cours → IN_PROGRESS', () => {
    expect(
      status({ mode: 'PERCENTAGE', target: '160000', contributed: '100000', income: '800000' }),
    ).toBe('IN_PROGRESS');
  });

  it('19. dépassement → REACHED (et non NO_INCOME_YET)', () => {
    // revenus 0 mais argent déjà épargné manuellement : l'objectif est dépassé.
    expect(
      status({ mode: 'PERCENTAGE', target: '0', contributed: '5000', income: '0' }),
    ).toBe('REACHED');
  });
});
