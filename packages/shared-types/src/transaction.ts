import { z } from 'zod';
import { accountPublicSchema, amountInputSchema } from './account.js';

/**
 * Contrats partagés des transactions (dépenses/revenus) — étape 5.
 * Aucun modèle Prisma n'est exposé : uniquement les DTO publics.
 *
 * Règle métier : le solde d'un compte est DÉRIVÉ en lecture
 * (solde de départ + revenus − dépenses) — cf. finance-core/ledger.
 */

// --- Sens d'une opération ---
export const transactionTypeSchema = z.enum(['INCOME', 'EXPENSE']);
export type TransactionType = z.infer<typeof transactionTypeSchema>;

export const TRANSACTION_TYPES: readonly TransactionType[] = [
  'INCOME',
  'EXPENSE',
];

// --- Date de l'opération (jour) ---
// Format "YYYY-MM-DD". La validation vérifie qu'il s'agit bien d'une date
// réelle (pas de 2026-02-31) via un aller-retour UTC.
export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date. Expected YYYY-MM-DD.')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Invalid date.');
export type DateOnly = z.infer<typeof dateOnlySchema>;

// --- Création d'une opération ---
export const transactionCreateSchema = z.object({
  type: transactionTypeSchema,
  // Montant strictement positif (une opération de 0 n'a pas de sens).
  amount: amountInputSchema.refine(
    (value) => /[1-9]/.test(value),
    'Amount must be greater than 0.',
  ),
  description: z
    .string()
    .trim()
    .min(1, 'Description must not be empty.')
    .max(120, 'Description must be at most 120 characters.')
    .optional(),
  // Jour de l'opération ; par défaut aujourd'hui côté serveur.
  occurredAt: dateOnlySchema.optional(),
});
export type TransactionCreate = z.infer<typeof transactionCreateSchema>;

// --- DTO publics ---
export const transactionPublicSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  type: transactionTypeSchema,
  // Montant positif exact, en chaîne (jamais de number flottant).
  amount: z.string(),
  description: z.string().nullable(),
  occurredAt: dateOnlySchema,
});
export type TransactionPublic = z.infer<typeof transactionPublicSchema>;

/** Réponse de création : l'opération créée (201). */
export const transactionCreatedResponseSchema = z.object({
  transaction: transactionPublicSchema,
});
export type TransactionCreatedResponse = z.infer<
  typeof transactionCreatedResponseSchema
>;

/**
 * Journal complet d'un compte : le compte (avec son solde courant dérivé),
 * la liste des opérations (triée de la plus récente à la plus ancienne) et
 * les totaux par sens (montants positifs, en chaîne).
 */
export const accountLedgerResponseSchema = z.object({
  account: accountPublicSchema,
  transactions: z.array(transactionPublicSchema),
  totals: z.object({
    incomes: z.string(),
    expenses: z.string(),
  }),
});
export type AccountLedgerResponse = z.infer<typeof accountLedgerResponseSchema>;
