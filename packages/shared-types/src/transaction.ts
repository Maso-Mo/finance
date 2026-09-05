import { z } from 'zod';
import { accountTypeSchema, amountInputSchema } from './account.js';

/**
 * Contrats partagés des transactions (dépenses/revenus) — étape 5.
 *
 * Une transaction appartient à un UTILISATEUR (jamais à un seul compte) : elle
 * est ventilée en allocations. Aucun modèle Prisma n'est exposé ici.
 *
 * États « je ne sais plus » EXPLICITES (un champ vide ne suffit jamais) :
 * date = occurredAt OU dateUnknown ; comptes = allocations OU accountUnknown ;
 * catégorie (EXPENSE) = categoryId OU categoryUnknown.
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
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, 'Invalid date.');
export type DateOnly = z.infer<typeof dateOnlySchema>;

// --- Montant strictement positif (opération ou allocation) ---
export const positiveAmountSchema = amountInputSchema.refine(
  (value) => /[1-9]/.test(value),
  'Amount must be greater than 0.',
);

// --- Allocation d'entrée (ventilation vers un compte) ---
export const transactionAllocationInputSchema = z.object({
  accountId: z.string().uuid(),
  amount: positiveAmountSchema,
});
export type TransactionAllocationInput = z.infer<
  typeof transactionAllocationInputSchema
>;

/**
 * Corps de création ET de modification (PATCH = remplacement atomique complet :
 * le nouvel état remplace l'ancien — montant, date, catégorie, description,
 * allocations, compte inconnu/connu).
 */
export const transactionUpsertSchema = z
  .object({
    type: transactionTypeSchema,
    amount: positiveAmountSchema,
    description: z
      .string()
      .trim()
      .max(120, 'Description must be at most 120 characters.')
      .optional(),
    // Jour de l'opération. Aucun défaut « aujourd'hui » : date fournie OU
    // dateUnknown: true explicite.
    occurredAt: dateOnlySchema.optional(),
    dateUnknown: z.boolean().optional(),
    // Ventilation comptable : somme = montant EXACTEMENT (vérifiée côté
    // backend avec decimal.js). Si accountUnknown est vrai, aucune allocation.
    allocations: z
      .array(transactionAllocationInputSchema)
      .max(6, 'At most one allocation per account (6 accounts).')
      .optional(),
    accountUnknown: z.boolean().optional(),
    // Catégorie : obligatoire pour une EXPENSE sauf inconnue explicite.
    categoryId: z.string().uuid().optional(),
    categoryUnknown: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const {
      type,
      occurredAt,
      dateUnknown,
      allocations,
      accountUnknown,
      categoryId,
      categoryUnknown,
    } = value;

    // --- Date connue XOR date inconnue explicite ---
    const dateKnown = occurredAt !== undefined;
    const dateExplicitlyUnknown = dateUnknown === true;
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
        message: 'Set occurredAt or dateUnknown: true.',
      });
    }

    // --- Comptes connus XOR compte(s) inconnu(s) ---
    const allocated = allocations ?? [];
    if (accountUnknown === true && allocated.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['accountUnknown'],
        message: 'accountUnknown must be used without allocations.',
      });
    } else if (accountUnknown !== true && allocated.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['allocations'],
        message: 'Add allocations or set accountUnknown: true.',
      });
    }

    // Un compte ne peut apparaître qu'une seule fois par transaction.
    const seen = new Set<string>();
    for (const allocation of allocated) {
      if (seen.has(allocation.accountId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['allocations'],
          message: 'Duplicate account in allocations.',
        });
        break;
      }
      seen.add(allocation.accountId);
    }

    // --- Catégorie : EXPENSE obligatoire (ou inconnue explicite) ---
    const categoryKnown = categoryId !== undefined;
    const categoryExplicitUnknown = categoryUnknown === true;
    if (type === 'EXPENSE') {
      if (categoryKnown && categoryExplicitUnknown) {
        ctx.addIssue({
          code: 'custom',
          path: ['categoryUnknown'],
          message: 'Do not provide both categoryId and categoryUnknown.',
        });
      } else if (!categoryKnown && !categoryExplicitUnknown) {
        ctx.addIssue({
          code: 'custom',
          path: ['categoryId'],
          message: 'Provide categoryId or set categoryUnknown: true.',
        });
      }
    } else if (categoryKnown || categoryExplicitUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['categoryId'],
        message: 'Income transactions do not have an expense category.',
      });
    }
  });
export type TransactionUpsert = z.infer<typeof transactionUpsertSchema>;

// La création et la modification partagent le même contrat complet.
export const transactionCreateSchema = transactionUpsertSchema;
export type TransactionCreate = TransactionUpsert;
export const transactionUpdateSchema = transactionUpsertSchema;
export type TransactionUpdate = TransactionUpsert;

// --- DTO publics ---
export const transactionCategoryPublicSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});

export const transactionAllocationPublicSchema = z.object({
  accountId: z.string().uuid(),
  accountType: accountTypeSchema,
  // Part de la transaction portée par ce compte, en chaîne exacte.
  amount: z.string(),
});

export const transactionPublicSchema = z.object({
  id: z.string().uuid(),
  type: transactionTypeSchema,
  // Montant POSITIF exact, en chaîne (jamais de number flottant).
  amount: z.string(),
  description: z.string().nullable(),
  // Jour de l'opération, ou null si l'utilisateur a indiqué ne pas savoir.
  occurredAt: dateOnlySchema.nullable(),
  accountUnknown: z.boolean(),
  categoryUnknown: z.boolean(),
  category: transactionCategoryPublicSchema.nullable(),
  allocations: z.array(transactionAllocationPublicSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TransactionPublic = z.infer<typeof transactionPublicSchema>;

export const transactionMutationResponseSchema = z.object({
  transaction: transactionPublicSchema,
});
export type TransactionMutationResponse = z.infer<
  typeof transactionMutationResponseSchema
>;

/**
 * Historique GLOBAL paginé. `totals` porte sur l'ensemble du journal actif de
 * l'utilisateur (indépendant de la page affichée).
 */
export const transactionsResponseSchema = z.object({
  transactions: z.array(transactionPublicSchema),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
  totals: z.object({
    incomes: z.string(),
    expenses: z.string(),
  }),
});
export type TransactionsResponse = z.infer<typeof transactionsResponseSchema>;

