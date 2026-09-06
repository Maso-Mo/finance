import { z } from 'zod';
import { amountInputSchema, currencySchema } from './account.js';
import { monthKeySchema } from './budget.js';
import { dateOnlySchema, positiveAmountSchema } from './transaction.js';
import { transferPublicSchema } from './transfer.js';

/**
 * Contrats partagés des PLANS D'ÉPARGNE MENSUELS (étape 10).
 *
 * ⚠ RÈGLE ABSOLUE : UN PLAN D'ÉPARGNE N'EST JAMAIS DE L'ARGENT.
 *  - il ne modifie AUCUN solde, AUCUN Total disponible, AUCUNE Transaction,
 *    AUCUN budget ni forecast ;
 *  - le compte Épargne n'augmente QUE lorsqu'un vrai AccountTransfer vers
 *    SAVINGS est enregistré (contribution liée ou page transferts) ;
 *  - la cible PERCENTAGE est TOUJOURS DÉRIVÉE en lecture des revenus
 *    RÉELLEMENT reçus du mois (jamais stockée).
 *
 * Modes mutuellement exclusifs (vérifiés ici + service + base) :
 *  - FIXED      → fixedAmount (strictement positif) ;
 *  - PERCENTAGE → percentage (0 exclu, <= 100).
 * Mois : clé calendaire « YYYY-MM » (texte, jamais d'instant UTC).
 */

// --- Mode ---
export const savingsPlanModeSchema = z.enum(['FIXED', 'PERCENTAGE']);
export type SavingsPlanMode = z.infer<typeof savingsPlanModeSchema>;

export const SAVINGS_PLAN_MODES: readonly SavingsPlanMode[] = [
  'FIXED',
  'PERCENTAGE',
];

// --- Pourcentage (strictement > 0, <= 100, max 2 décimales) ---
export const savingsPercentageSchema = amountInputSchema.refine(
  (value) => Number(value) > 0 && Number(value) <= 100,
  'Percentage must be greater than 0 and at most 100.',
);

// --- DTO public d'un plan ---
export const savingsPlanPublicSchema = z.object({
  id: z.string().uuid(),
  month: monthKeySchema,
  mode: savingsPlanModeSchema,
  // Cible FIXE (mode FIXED) ou null — chaîne décimale exacte.
  fixedAmount: z.string().nullable(),
  // Pourcentage (mode PERCENTAGE) ou null — chaîne décimale exacte.
  percentage: z.string().nullable(),
  currency: currencySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SavingsPlanPublic = z.infer<typeof savingsPlanPublicSchema>;

// --- Corps de création ET de modification ---
// PATCH = remplacement complet des champs éditables d'un plan ACTIF (mode +
// cible). Aucune modification n'altère jamais les Transfers déjà enregistrés.
export const savingsPlanUpsertSchema = z
  .object({
    month: monthKeySchema,
    mode: savingsPlanModeSchema,
    fixedAmount: positiveAmountSchema.optional(),
    percentage: savingsPercentageSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const { mode, fixedAmount, percentage } = value;
    if (mode === 'FIXED') {
      if (fixedAmount === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['fixedAmount'],
          message: 'A FIXED savings plan requires fixedAmount.',
        });
      }
      if (percentage !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['percentage'],
          message: 'A FIXED savings plan must not include a percentage.',
        });
      }
    } else {
      if (percentage === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['percentage'],
          message: 'A PERCENTAGE savings plan requires a percentage.',
        });
      }
      if (fixedAmount !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['fixedAmount'],
          message: 'A PERCENTAGE savings plan must not include a fixed amount.',
        });
      }
    }
  });
export type SavingsPlanUpsert = z.infer<typeof savingsPlanUpsertSchema>;

export const savingsPlanCreateSchema = savingsPlanUpsertSchema;
export type SavingsPlanCreate = SavingsPlanUpsert;
export const savingsPlanUpdateSchema = savingsPlanUpsertSchema;
export type SavingsPlanUpdate = SavingsPlanUpsert;

export const savingsPlanMutationResponseSchema = z.object({
  plan: savingsPlanPublicSchema,
});
export type SavingsPlanMutationResponse = z.infer<
  typeof savingsPlanMutationResponseSchema
>;
// --- Contribution : confirmation d'un AccountTransfer RÉEL vers SAVINGS ---
// Le compte destination est IMPOSÉ (SAVINGS, vérifié côté backend) : le
// formulaire ne demande que la source, le montant transféré, les frais
// éventuels et la date réelle (ou « je ne sais plus »).
export const savingsContributionCreateSchema = z
  .object({
    sourceAccountId: z.string().uuid(),
    // Montant RÉELLEMENT crédité sur Épargne (strictement positif).
    amount: positiveAmountSchema,
    // Frais (>= 0) toujours prélevés EN PLUS sur la source (règle Transfer V1).
    feeAmount: amountInputSchema.optional(),
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
export type SavingsContributionCreate = z.infer<
  typeof savingsContributionCreateSchema
>;

// --- DTO public d'une contribution (le Transfer reste la source de vérité) ---
export const savingsContributionPublicSchema = z.object({
  id: z.string().uuid(),
  // AccountTransfer réel lié (source, destination SAVINGS, montant, frais, date).
  transfer: transferPublicSchema,
  createdAt: z.string(),
});
export type SavingsContributionPublic = z.infer<
  typeof savingsContributionPublicSchema
>;

export const savingsContributionMutationResponseSchema = z.object({
  contribution: savingsContributionPublicSchema,
});
export type SavingsContributionMutationResponse = z.infer<
  typeof savingsContributionMutationResponseSchema
>;

// --- Statut dérivé de la progression (jamais stocké) ---
export const savingsProgressStatusSchema = z.enum([
  'IN_PROGRESS',
  'REACHED',
  'NO_INCOME_YET',
]);
export type SavingsProgressStatus = z.infer<
  typeof savingsProgressStatusSchema
>;

// --- Vue analytique d'un mois (GET read-only) ---
// Plan du mois (ou null) + cible/contribution dérivées + compte Épargne réel.
// Le solde réel de l'Épargne et le montant contribué au plan sont DEUX
// concepts distincts : jamais affichés comme une même valeur.
export const savingsMonthViewSchema = z.object({
  month: monthKeySchema,
  currency: currencySchema,
  // Compte Épargne de l'utilisateur : solde COURANT dérivé.
  savingsAccount: z
    .object({ id: z.string().uuid(), balance: z.string() })
    .nullable(),
  // Plan ACTIF du mois, ou null si aucun n'est défini.
  plan: savingsPlanPublicSchema.nullable(),
  // Cible DÉRIVÉE du mois (FIXED → fixedAmount ; PERCENTAGE → revenus × %).
  target: z.string().nullable(),
  // Revenus RÉELLEMENT reçus ce mois (mode PERCENTAGE ; sinon null).
  eligibleIncome: z.string().nullable(),
  // Σ des AccountTransfer.amount des contributions ACTIVES du plan.
  contributed: z.string().nullable(),
  // target − contributed (peut être négatif : dépassement, jamais clampé).
  remaining: z.string().nullable(),
  progress: savingsProgressStatusSchema.nullable(),
  contributions: z.array(savingsContributionPublicSchema),
});
export type SavingsMonthView = z.infer<typeof savingsMonthViewSchema>;

