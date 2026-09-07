import { z } from 'zod';
import { currencySchema } from './account.js';
import { monthKeySchema } from './budget.js';

/**
 * Contrats partagés de l'ANALYTIQUE LECTURE-SEULE (dashboard) entre web et api.
 *
 * GET /analytics/overview?months=6[&today=YYYY-MM-DD] — STRICTEMENT READ-ONLY :
 * le calcul est dérivé du journal réel des Transactions actives ; aucune
 * écriture, aucun changement de statut, aucune génération ici.
 *
 * Définitions (inclusion) :
 *  - seules les Transactions actives (deletedAt NULL) de type INCOME/EXPENSE
 *    avec une date d'occurrence connue participent ; les Transferts, Épargnes,
 *    règlements de dettes, PlannedExpense non payées et ExpectedIncome non
 *    reçues ne produisent AUCUNE Transaction tant qu'ils ne sont pas réels, ils
 *    sont donc naturellement exclus ; une ligne logiquement supprimée est exclue ;
 *  - la clé de mois « YYYY-MM » est dérivée de `occurredAt` (stocké à midi UTC :
 *    le mois calendaire ne bascule jamais avec le fuseau de la session).
 */

// --- Point mensuel revenus / dépenses (fenêtre demandée, mois sans activité à 0) ---
export const monthlyCashflowPointSchema = z.object({
  month: monthKeySchema,
  income: z.string(),
  expense: z.string(),
});
export type MonthlyCashflowPoint = z.infer<typeof monthlyCashflowPointSchema>;

// --- Dépense du mois courant ventilée par catégorie (descendant, parts 0..1) ---
export const currentMonthExpenseCategorySchema = z.object({
  // null = dépense « sans catégorie » (categoryUnknown ou catégorie inconnue).
  categoryId: z.string().uuid().nullable(),
  label: z.string(),
  amount: z.string(),
  // Part du total des dépenses du mois courant, entre 0 et 1 (0 si aucun total).
  share: z.number().min(0).max(1),
});
export type CurrentMonthExpenseCategory = z.infer<
  typeof currentMonthExpenseCategorySchema
>;

// --- Vue d'ensemble GET /analytics/overview ---
export const analyticsOverviewResponseSchema = z.object({
  currency: currencySchema,
  // Mois calendaire « YYYY-MM » du jour de référence (mois courant).
  currentMonth: monthKeySchema,
  // Fenêtre demandée, ordre chronologique, EXACTEMENT `months` points
  // (les mois sans activité sont à zéro pour garder l'axe stable).
  monthlyCashflow: z.array(monthlyCashflowPointSchema),
  // Ventilation du mois courant (vide si aucune dépense réelle ce mois-ci).
  currentMonthExpenseCategories: z.array(currentMonthExpenseCategorySchema),
});
export type AnalyticsOverviewResponse = z.infer<
  typeof analyticsOverviewResponseSchema
>;
