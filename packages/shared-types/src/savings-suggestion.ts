import { z } from 'zod';
import { dateOnlySchema, positiveAmountSchema } from './transaction.js';
import { transferPublicSchema } from './transfer.js';
import { savingsPlanModeSchema } from './savings.js';

/**
 * Contrats partagés des PROPOSITIONS D'ÉPARGNE post-revenu (étape 10).
 *
 * ⚠ Une proposition n'est JAMAIS de l'argent :
 *  - GET  /next  strictement read-only (aucune écriture, aucun transfert) ;
 *  - PENDING  → visible une seule fois par revenu (contrainte unique) ;
 *  - DISMISSED → « Ignorer » persiste (reload / re-login / retry) ;
 *  - CONFIRMED → UN SEUL AccountTransfer source → SAVINGS est créé (jamais
 *    de Transaction EXPENSE/INCOME parallèle). Le transfert reste la source
 *    de vérité du mouvement.
 */

/** Statut de la décision humaine sur une proposition. */
export const savingsSuggestionStatusSchema = z.enum([
  'PENDING',
  'DISMISSED',
  'CONFIRMED',
]);
export type SavingsSuggestionStatus = z.infer<
  typeof savingsSuggestionStatusSchema
>;

/** Revenu réel qui a déclenché la proposition (aperçu read-only). */
export const savingsSuggestionIncomeSchema = z.object({
  id: z.string().uuid(),
  amount: z.string(),
  description: z.string().nullable(),
  occurredAt: dateOnlySchema.nullable(),
  dateUnknown: z.boolean(),
  accountUnknown: z.boolean(),
});
export type SavingsSuggestionIncome = z.infer<
  typeof savingsSuggestionIncomeSchema
>;

/** Source probable (allocation unique du revenu), ou null → l'utilisateur choisit. */
export const savingsSuggestionSourceSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  balance: z.string(),
});
export type SavingsSuggestionSource = z.infer<
  typeof savingsSuggestionSourceSchema
>;

/** Règle du mois du revenu (plan ACTIF), ou null si aucun plan. */
export const savingsSuggestionRuleSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('FIXED'), fixedAmount: z.string() }),
  z.object({ mode: z.literal('PERCENTAGE'), percentage: z.string() }),
]);
export type SavingsSuggestionRule = z.infer<
  typeof savingsSuggestionRuleSchema
>;

/** Proposition complète (read-only) renvoyée par GET /next. */
export const savingsSuggestionPublicSchema = z.object({
  id: z.string().uuid(),
  status: savingsSuggestionStatusSchema,
  incomeTransactionId: z.string().uuid(),
  income: savingsSuggestionIncomeSchema.nullable(),
  sourceAccount: savingsSuggestionSourceSchema.nullable(),
  /** Règle du mois du revenu (FIXED/PERCENTAGE) si un plan ACTIF existe. */
  rule: savingsSuggestionRuleSchema.nullable(),
  /**
   * Montant proposé PAR DÉFAUT, en chaîne décimale exacte :
   *  - règle FIXED      → fixedAmount ;
   *  - règle PERCENTAGE → pourcentage × revenu de CETTE transaction ;
   *  - aucun plan       → null (l'utilisateur choisit « Oui » puis un montant
   *    ou un pourcentage de CE revenu — aucun faux montant par défaut).
   */
  suggestedAmount: z.string().nullable(),
  /** Mois calendaire « YYYY-MM » du revenu (pour rattacher la règle). */
  incomeMonth: z.string(),
  createdAt: z.string(),
});
export type SavingsSuggestionPublic = z.infer<
  typeof savingsSuggestionPublicSchema
>;

export const savingsSuggestionNextResponseSchema = z.object({
  suggestion: savingsSuggestionPublicSchema.nullable(),
});
export type SavingsSuggestionNextResponse = z.infer<
  typeof savingsSuggestionNextResponseSchema
>;

/** Confirmation : montant définitif + source (seulement si inconnue). */
export const savingsSuggestionConfirmSchema = z.object({
  amount: positiveAmountSchema,
  sourceAccountId: z.string().uuid().optional(),
});
export type SavingsSuggestionConfirm = z.infer<
  typeof savingsSuggestionConfirmSchema
>;

export const savingsSuggestionConfirmResponseSchema = z.object({
  suggestion: savingsSuggestionPublicSchema,
  transfer: transferPublicSchema,
});
export type SavingsSuggestionConfirmResponse = z.infer<
  typeof savingsSuggestionConfirmResponseSchema
>;

/** Retrait RÉEL de l'Épargne : destination + montant (frais éventuels). */
export const savingsWithdrawalCreateSchema = z
  .object({
    destinationAccountId: z.string().uuid(),
    amount: positiveAmountSchema,
    // Frais (>= 0) toujours prélevés EN PLUS sur l'Épargne (règle Transfer V1).
    feeAmount: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/, 'Fee must be a valid non-negative amount.')
      .optional(),
    occurredAt: dateOnlySchema.optional(),
    dateUnknown: z.boolean().optional(),
    description: z
      .string()
      .trim()
      .max(120, 'Description must be at most 120 characters.')
      .optional(),
  })
  .superRefine((value, ctx) => {
    const dateKnown = value.occurredAt !== undefined;
    const dateExplicitlyUnknown = value.dateUnknown === true;
    if (dateKnown && dateExplicitlyUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['dateUnknown'],
        message: 'Do not provide both occurredAt and dateUnknown.',
      });
    } else if (!dateKnown && !dateExplicitlyUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['occurredAt'],
        message: 'Provide occurredAt or set dateUnknown: true.',
      });
    }
  });
export type SavingsWithdrawalCreate = z.infer<
  typeof savingsWithdrawalCreateSchema
>;

export const savingsWithdrawalMutationResponseSchema = z.object({
  transfer: transferPublicSchema,
});
export type SavingsWithdrawalMutationResponse = z.infer<
  typeof savingsWithdrawalMutationResponseSchema
>;
