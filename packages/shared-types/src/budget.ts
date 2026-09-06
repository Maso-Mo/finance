import { z } from 'zod';
import { currencySchema } from './account.js';
import {
  dateOnlySchema,
  positiveAmountSchema,
  transactionCategoryPublicSchema,
} from './transaction.js';

/**
 * Contrats partagés des BUDGETS MENSUELS (étape 8).
 *
 * ⚠ RÈGLE ABSOLUE : UN BUDGET N'EST PAS DE L'ARGENT.
 *  - c'est une LIMITE / un OBJECTIF analytique (budget global du mois, ou
 *    budget par catégorie de dépense) ;
 *  - il ne crée ni ne modifie JAMAIS une Transaction, un compte, un solde ou
 *    le Total disponible ;
 *  - le montant « dépensé » est TOUJOURS DÉRIVÉ du journal réel des
 *    Transactions EXPENSE actives (jamais stocké, jamais modifiable ici).
 *
 * Mois : clé calendaire « YYYY-MM » (texte, jamais d'instant UTC). Statut
 * volontairement binaire : VERT (dépensé ≤ budget) ou DEPASSÉ (dépensé >
 * budget) — aucun statut intermédiaire.
 */

// --- Mois calendaire « YYYY-MM » ---
export const monthKeySchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Invalid month. Expected YYYY-MM.');
export type MonthKey = z.infer<typeof monthKeySchema>;

// --- Statut binaire VERT / DÉPASSÉ ---
export const budgetStatusSchema = z.enum(['VERT', 'DEPASSE']);
export type BudgetStatus = z.infer<typeof budgetStatusSchema>;

export const BUDGET_STATUSES: readonly BudgetStatus[] = ['VERT', 'DEPASSE'];

// --- DTO public d'un budget mensuel ---
// `category` = null pour le budget GLOBAL du mois ; sinon catégorie de dépense.
export const monthlyBudgetPublicSchema = z.object({
  id: z.string().uuid(),
  month: monthKeySchema,
  // Limite choisie par l'utilisateur, positive, exacte (chaîne).
  amount: z.string(),
  currency: currencySchema,
  category: transactionCategoryPublicSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MonthlyBudgetPublic = z.infer<typeof monthlyBudgetPublicSchema>;

export const monthlyBudgetMutationResponseSchema = z.object({
  budget: monthlyBudgetPublicSchema,
});
export type MonthlyBudgetMutationResponse = z.infer<
  typeof monthlyBudgetMutationResponseSchema
>;

// --- Création ---
// Montant strictement positif + mois + catégorie OPTIONNELLE (absente ⇒ budget
// global du mois). La devise est celle de l'utilisateur, jamais choisie ici.
export const monthlyBudgetCreateSchema = z.object({
  month: monthKeySchema,
  amount: positiveAmountSchema,
  categoryId: z.string().uuid().optional(),
});
export type MonthlyBudgetCreate = z.infer<typeof monthlyBudgetCreateSchema>;

// --- Modification (V1) ---
// On ne modifie que la LIMITE ; jamais la catégorie ni le mois (on supprime et
// on recrée si besoin). Le montant reste strictement positif.
export const monthlyBudgetUpdateSchema = z.object({
  amount: positiveAmountSchema,
});
export type MonthlyBudgetUpdate = z.infer<typeof monthlyBudgetUpdateSchema>;

// --- Ligne dérivée d'un budget GLOBAL (statistiques calculées du mois) ---
export const globalBudgetLineSchema = z.object({
  id: z.string().uuid(),
  month: monthKeySchema,
  amount: z.string(),
  currency: currencySchema,
  // Restant = budget − dépensé réel du mois (négatif si dépassé).
  remaining: z.string(),
  status: budgetStatusSchema,
  // Prévision de DÉPENSES de fin de mois (projection des dépenses réelles) —
  // à ne PAS confondre avec la prévision de solde disponible (financière).
  spendingForecast: z.string(),
});
export type GlobalBudgetLine = z.infer<typeof globalBudgetLineSchema>;

// --- Ligne d'un budget par CATÉGORIE (statistiques de cette catégorie) ---
export const categoryBudgetLineSchema = z.object({
  id: z.string().uuid(),
  month: monthKeySchema,
  amount: z.string(),
  currency: currencySchema,
  category: transactionCategoryPublicSchema,
  // Dépensé réel de CETTE catégorie pendant le mois (dérivé du journal).
  spent: z.string(),
  remaining: z.string(),
  status: budgetStatusSchema,
  // Prévision de DÉPENSES de fin de mois pour cette catégorie.
  spendingForecast: z.string(),
});
export type CategoryBudgetLine = z.infer<typeof categoryBudgetLineSchema>;

// --- Vue analytique d'un mois (GET read-only) ---
export const monthlyBudgetsResponseSchema = z.object({
  month: monthKeySchema,
  // Jour LOCAL du frontend (YYYY-MM-DD) ayant servi à la prévision.
  today: dateOnlySchema,
  currency: currencySchema,
  // Dépenses réelles (EXPENSE actives) du mois — indépendant des budgets.
  spent: z.string(),
  // PRÉVISION DE DÉPENSES du mois (projection des dépenses réelles). Ce n'est
  // PAS une prévision de solde disponible : la prévision FINANCIÈRE de fin de
  // mois vit dans le contrat `/forecast` (mois courant uniquement).
  spendingForecast: z.string(),
  // Budget global du mois, ou null s'il n'est pas défini.
  globalBudget: globalBudgetLineSchema.nullable(),
  // Budgets par catégorie du mois (0 si aucun).
  categoryBudgets: z.array(categoryBudgetLineSchema),
});
export type MonthlyBudgetsResponse = z.infer<
  typeof monthlyBudgetsResponseSchema
>;
