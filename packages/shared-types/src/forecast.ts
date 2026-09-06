import { z } from 'zod';
import { currencySchema } from './account.js';
import { dateOnlySchema } from './transaction.js';
import { monthKeySchema } from './budget.js';

/**
 * Contrats de la PRÉVISION FINANCIÈRE DE FIN DE MOIS (correctif 8.1).
 *
 * ⚠ Distinction STRICTE avec la prévision de DÉPENSES (budget.ts) :
 *  - le contrat `/budgets` expose `spendingForecast` = projection statistique
 *    des DÉPENSES RÉELLES du mois (limites budgétaires) ;
 *  - le contrat `/forecast` ci-dessous expose la PRÉVISION DE SOLDE DISPONIBLE
 *    en fin de mois, construite à partir de composants explicites.
 *
 * Décisions contractuelles (V1) :
 *  - l'endpoint couvre UNIQUEMENT le MOIS COURANT (le mois contenant `today`) :
 *    il n'existe AUCUNE simulation d'un mois passé ou futur (aucun solde de
 *    départ reconstruit arbitrairement). Pour un mois historique, ce bloc est
 *    simplement ABSENT : seule `/budgets` (réel) répond. Cette décision évite
 *    toute ambiguïté « disponible prévisionnel » hors mois courant ;
 *  - tout est DÉRIVÉ en lecture stricte (comptes, transactions actives,
 *    PlannedExpense, ExpectedIncome). RIEN n'est stocké, aucune écriture ;
 *  - les montants sont des chaînes exactes (decimal.js côté calcul) ;
 *  - `monthEndAvailableForecast` peut être NÉGATIF (jamais clampé à zéro) ;
 *  - les revenus UNCERTAIN sont exposés SÉPARÉMENT (`uncertainIncomePotential`)
 *    et n'entrent JAMAIS dans la prévision principale.
 */

export const financialForecastResponseSchema = z.object({
  // Mois couvert : le mois calendaire contenant `today` (mois COURANT).
  month: monthKeySchema,
  // Jour LOCAL du frontend (YYYY-MM-DD) ayant servi de référence.
  today: dateOnlySchema,
  currency: currencySchema,
  // Total disponible ACTUEL : Banque + MVola + Orange Money + Airtel Money +
  // Cash (Épargne exclue). Toujours dérivé du journal (jamais stocké).
  availableToday: z.string(),
  // Σ des PlannedExpense PENDING dues au plus tard à la fin du mois.
  pendingPlannedExpensesTotal: z.string(),
  // Σ des ExpectedIncome CONFIRMED PENDING attendus au plus tard fin de mois.
  confirmedExpectedIncomeTotal: z.string(),
  // Σ des ExpectedIncome UNCERTAIN PENDING attendus au plus tard fin de mois.
  // POTENTIEL uniquement — jamais inclus dans monthEndAvailableForecast.
  uncertainIncomePotential: z.string(),
  // Prévision financière de fin de mois =
  //   availableToday − pendingPlannedExpensesTotal + confirmedExpectedIncomeTotal.
  // Peut être négatif ; jamais clampé.
  monthEndAvailableForecast: z.string(),
});
export type FinancialForecastResponse = z.infer<
  typeof financialForecastResponseSchema
>;
