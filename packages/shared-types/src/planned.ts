import { z } from 'zod';
import { currencySchema } from './account.js';
import {
  dateOnlySchema,
  positiveAmountSchema,
  transactionAllocationInputSchema,
  transactionCategoryPublicSchema,
  transactionPublicSchema,
} from './transaction.js';

/**
 * Contrats partagés des DÉPENSES PLANIFIÉES (étape 6).
 *
 * ⚠ Règle absolue : UNE DÉPENSE PLANIFIÉE N'EST PAS UNE DÉPENSE RÉELLE.
 *  - PENDING : aucun impact sur un solde, le total disponible ou les
 *    statistiques réelles ;
 *  - elle ne devient une vraie Transaction EXPENSE qu'après confirmation
 *    explicite (« Oui, payé ») via POST /planned-expenses/:id/confirm-paid.
 *
 * Les statuts restent simples : PENDING / PAID / CANCELED / SKIPPED.
 * Le caractère « à venir / aujourd'hui / en retard » est DÉRIVÉ de
 * dueDate + status (jamais stocké).
 */

// --- Statut ---
export const plannedExpenseStatusSchema = z.enum([
  'PENDING',
  'PAID',
  'CANCELED',
  'SKIPPED',
]);
export type PlannedExpenseStatus = z.infer<typeof plannedExpenseStatusSchema>;

export const PLANNED_EXPENSE_STATUSES: readonly PlannedExpenseStatus[] = [
  'PENDING',
  'PAID',
  'CANCELED',
  'SKIPPED',
];

// --- Catégorie temporelle dérivée (rappel) ---
export const dueBucketSchema = z.enum(['overdue', 'due', 'upcoming', 'later']);
export type DueBucket = z.infer<typeof dueBucketSchema>;

// --- DTO public d'une dépense planifiée ---
export const plannedExpensePublicSchema = z.object({
  id: z.string().uuid(),
  // Montant PRÉVU, positif, exact (chaîne). Même payée, la dépense planifiée
  // conserve sa valeur prévue : la valeur réelle vit dans la Transaction.
  amount: z.string(),
  currency: currencySchema,
  // Jour calendaire (YYYY-MM-DD), jamais un instant.
  dueDate: dateOnlySchema,
  description: z.string().nullable(),
  category: transactionCategoryPublicSchema.nullable(),
  categoryUnknown: z.boolean(),
  status: plannedExpenseStatusSchema,
  // null pour une dépense ponctuelle ; sinon occurrence générée d'une règle.
  recurringRuleId: z.string().uuid().nullable(),
  // Lien vers la vraie Transaction EXPENSE créée lors du « Oui, payé ».
  confirmedTransactionId: z.string().uuid().nullable(),
  // Catégorie dérivée du rappel (null si la dépense n'est plus PENDING).
  bucket: dueBucketSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PlannedExpensePublic = z.infer<typeof plannedExpensePublicSchema>;

export const plannedExpensesResponseSchema = z.object({
  plannedExpenses: z.array(plannedExpensePublicSchema),
});
export type PlannedExpensesResponse = z.infer<
  typeof plannedExpensesResponseSchema
>;

// --- Création d'une dépense FUTURE PONCTUELLE ---
// Montant prévu + date prévue + catégorie (connue OU « je ne sais pas encore »
// explicite). AUCUN compte source : il sera demandé à la confirmation réelle.
export const plannedExpenseCreateSchema = z
  .object({
    amount: positiveAmountSchema,
    dueDate: dateOnlySchema,
    description: z
      .string()
      .trim()
      .max(120, 'Description must be at most 120 characters.')
      .optional(),
    categoryId: z.string().uuid().optional(),
    categoryUnknown: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const { categoryId, categoryUnknown } = value;
    const known = categoryId !== undefined;
    const explicitUnknown = categoryUnknown === true;
    if (known && explicitUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['categoryUnknown'],
        message: 'Do not provide both categoryId and categoryUnknown.',
      });
    } else if (!known && !explicitUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['categoryId'],
        message: 'Provide categoryId or set categoryUnknown: true.',
      });
    }
  });
export type PlannedExpenseCreate = z.infer<typeof plannedExpenseCreateSchema>;

// --- Modification d'une dépense planifiée (PENDING uniquement) ---
export const plannedExpenseUpdateSchema = z
  .object({
    amount: positiveAmountSchema.optional(),
    dueDate: dateOnlySchema.optional(),
    description: z
      .string()
      .trim()
      .max(120, 'Description must be at most 120 characters.')
      .nullish(),
    categoryId: z.string().uuid().optional(),
    categoryUnknown: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const { categoryId, categoryUnknown } = value;
    if (categoryId !== undefined && categoryUnknown === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['categoryUnknown'],
        message: 'Do not provide both categoryId and categoryUnknown.',
      });
    } else if (categoryUnknown === false && categoryId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['categoryId'],
        message: 'Provide categoryId to set a known category.',
      });
    }
  });
export type PlannedExpenseUpdate = z.infer<typeof plannedExpenseUpdateSchema>;

export const plannedExpenseMutationResponseSchema = z.object({
  plannedExpense: plannedExpensePublicSchema,
});
export type PlannedExpenseMutationResponse = z.infer<
  typeof plannedExpenseMutationResponseSchema
>;

// --- Règle de DÉPENSE MENSUELLE RÉCURRENTE (V1 : mensuelle uniquement) ---
// La règle n'est PAS une dépense : elle génère des occurrences (PlannedExpense)
// une par mois. `dayOfMonth` 1..31 ; un mois sans ce jour → dernier jour.
export const recurringExpensePublicSchema = z.object({
  id: z.string().uuid(),
  amount: z.string(),
  currency: currencySchema,
  dayOfMonth: z.number().int().min(1).max(31),
  description: z.string().nullable(),
  category: transactionCategoryPublicSchema.nullable(),
  categoryUnknown: z.boolean(),
  startDate: dateOnlySchema,
  endDate: dateOnlySchema.nullable(),
  isActive: z.boolean(),
  // Nombre d'occurrences PENDING restantes (confort d'affichage).
  pendingOccurrences: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RecurringExpensePublic = z.infer<
  typeof recurringExpensePublicSchema
>;

export const recurringExpensesResponseSchema = z.object({
  recurringExpenses: z.array(recurringExpensePublicSchema),
});
export type RecurringExpensesResponse = z.infer<
  typeof recurringExpensesResponseSchema
>;

const categoryRulesRefine = (
  value: { categoryId?: string; categoryUnknown?: boolean },
  ctx: z.RefinementCtx,
): void => {
  const { categoryId, categoryUnknown } = value;
  const known = categoryId !== undefined;
  const explicitUnknown = categoryUnknown === true;
  if (known && explicitUnknown) {
    ctx.addIssue({
      code: 'custom',
      path: ['categoryUnknown'],
      message: 'Do not provide both categoryId and categoryUnknown.',
    });
  } else if (!known && !explicitUnknown) {
    ctx.addIssue({
      code: 'custom',
      path: ['categoryId'],
      message: 'Provide categoryId or set categoryUnknown: true.',
    });
  }
};


export const recurringExpenseUpdateSchema = z
  .object({
    amount: positiveAmountSchema.optional(),
    dayOfMonth: z.coerce.number().int().min(1).max(31).optional(),
    startDate: dateOnlySchema.optional(),
    endDate: dateOnlySchema.nullable().optional(),
    isActive: z.boolean().optional(),
    description: z
      .string()
      .trim()
      .max(120, 'Description must be at most 120 characters.')
      .nullish(),
    categoryId: z.string().uuid().optional(),
    categoryUnknown: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const { categoryId, categoryUnknown } = value;
    if (categoryId !== undefined && categoryUnknown === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['categoryUnknown'],
        message: 'Do not provide both categoryId and categoryUnknown.',
      });
    } else if (categoryUnknown === false && categoryId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['categoryId'],
        message: 'Provide categoryId to set a known category.',
      });
    }
  })
  .superRefine((value, ctx) => {
    const startDate = value.startDate;
    const endDate = value.endDate;
    if (startDate !== undefined && endDate != null && endDate < startDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: 'endDate must not be before startDate.',
      });
    }
  });
export type RecurringExpenseUpdate = z.infer<
  typeof recurringExpenseUpdateSchema
>;

export const recurringExpenseMutationResponseSchema = z.object({
  recurringExpense: recurringExpensePublicSchema,
});
export type RecurringExpenseMutationResponse = z.infer<
  typeof recurringExpenseMutationResponseSchema
>;

export const recurringExpenseCreateSchema = z
  .object({
    amount: positiveAmountSchema,
    dayOfMonth: z.coerce.number().int().min(1).max(31),
    startDate: dateOnlySchema,
    endDate: dateOnlySchema.optional(),
    description: z
      .string()
      .trim()
      .max(120, 'Description must be at most 120 characters.')
      .optional(),
    categoryId: z.string().uuid().optional(),
    categoryUnknown: z.boolean().optional(),
  })
  .superRefine(categoryRulesRefine)
  .superRefine((value, ctx) => {
    if (value.endDate && value.endDate < value.startDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: 'endDate must not be before startDate.',
      });
    }
  });
export type RecurringExpenseCreate = z.infer<
  typeof recurringExpenseCreateSchema
>;


// --- Confirmation « Oui, payé » : la VRAIE dépense réelle ---
// Formulaire du réel : montant réellement payé, date réelle (ou « je ne sais
// plus »), compte(s) réels (ou « je ne sais plus »), catégorie. La validation
// reprend les règles du journal (étape 5) : aucun champ vide ambigu.
export const plannedExpenseConfirmPaidSchema = z
  .object({
    amount: positiveAmountSchema,
    description: z
      .string()
      .trim()
      .max(120, 'Description must be at most 120 characters.')
      .optional(),
    occurredAt: dateOnlySchema.optional(),
    dateUnknown: z.boolean().optional(),
    allocations: z
      .array(transactionAllocationInputSchema)
      .max(6, 'At most one allocation per account (6 accounts).')
      .optional(),
    accountUnknown: z.boolean().optional(),
    categoryId: z.string().uuid().optional(),
    categoryUnknown: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const { occurredAt, dateUnknown } = value;
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
        message: 'Provide occurredAt or set dateUnknown: true.',
      });
    }

    const allocated = value.allocations ?? [];
    if (value.accountUnknown === true && allocated.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['accountUnknown'],
        message: 'Do not provide allocations when accountUnknown is true.',
      });
    } else if (value.accountUnknown !== true && allocated.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['allocations'],
        message: 'Provide at least one allocation or set accountUnknown: true.',
      });
    }
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

    const { categoryId, categoryUnknown } = value;
    const categoryKnown = categoryId !== undefined;
    const categoryExplicitUnknown = categoryUnknown === true;
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
  });
export type PlannedExpenseConfirmPaid = z.infer<
  typeof plannedExpenseConfirmPaidSchema
>;

export const plannedExpenseConfirmPaidResponseSchema = z.object({
  plannedExpense: plannedExpensePublicSchema,
  transaction: transactionPublicSchema,
});
export type PlannedExpenseConfirmPaidResponse = z.infer<
  typeof plannedExpenseConfirmPaidResponseSchema
>;

// --- Rappels internes (read-only, états dérivés) ---
export const remindersResponseSchema = z.object({
  // Jour local transmis par le frontend (YYYY-MM-DD), base des calculs.
  today: dateOnlySchema,
  overdue: z.array(plannedExpensePublicSchema),
  dueToday: z.array(plannedExpensePublicSchema),
  upcoming: z.array(plannedExpensePublicSchema),
});
export type RemindersResponse = z.infer<typeof remindersResponseSchema>;

