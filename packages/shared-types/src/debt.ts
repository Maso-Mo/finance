import { z } from 'zod';
import { accountTypeSchema, currencySchema } from './account.js';
import { dateOnlySchema, positiveAmountSchema } from './transaction.js';

/**
 * Contrats partagés DETTES / CRÉANCES / RÈGLEMENTS (étape 11).
 *
 * INVARIANT : le remboursement du PRINCIPAL n'est NI une Transaction EXPENSE
 * NI une Transaction INCOME (sinon budgets, spent, revenus faux). Il n'impacte
 * QUE le solde courant dérivé des comptes.
 *  - I_OWE : JE dois (règlement = argent sortant) ;
 *  - OWED_TO_ME : on ME doit (règlement = entrant).
 *  - STANDARD : remboursement ordinaire (mouvement de compte, aucune Transaction) ;
 *  - INCOME_ADVANCE_RECEIVABLE : « avance » EXPLICITE sur un revenu/salaire,
 *    réservée à OWED_TO_ME : une Transaction INCOME liée est créée (jamais
 *    aussi le mouvement de compte — jamais les deux).
 * Montants = chaînes décimales exactes ; restant et statut DÉRIVÉS.
 */

// --- Direction ---
export const debtDirectionSchema = z.enum(['I_OWE', 'OWED_TO_ME']);
export type DebtDirection = z.infer<typeof debtDirectionSchema>;

export const DEBT_DIRECTIONS: readonly DebtDirection[] = [
  'I_OWE',
  'OWED_TO_ME',
];

// --- Type de dette ---
export const debtKindSchema = z.enum([
  'STANDARD',
  'INCOME_ADVANCE_RECEIVABLE',
]);
export type DebtKind = z.infer<typeof debtKindSchema>;

export const DEBT_KINDS: readonly DebtKind[] = [
  'STANDARD',
  'INCOME_ADVANCE_RECEIVABLE',
];

// --- Statut temporel dérivé (jamais stocké) ---
export const debtTemporalStatusSchema = z.enum([
  'OPEN',
  'SETTLED',
  'OVERDUE',
]);
export type DebtTemporalStatus = z.infer<typeof debtTemporalStatusSchema>;

// --- Création d'une dette ---
export const debtCreateSchema = z
  .object({
    direction: debtDirectionSchema,
    // STANDARD par défaut ; « avance » EXPLICITE, réservée à OWED_TO_ME.
    kind: debtKindSchema.optional(),
    originalAmount: positiveAmountSchema,
    counterpartyName: z
      .string()
      .trim()
      .max(120, 'Counterparty name must be at most 120 characters.')
      .optional(),
    description: z
      .string()
      .trim()
      .max(240, 'Description must be at most 240 characters.')
      .optional(),
    // Échéance : date réelle OU « je ne sais plus ». Jamais « aujourd'hui ».
    dueDate: dateOnlySchema.optional(),
    dueDateUnknown: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const { direction, kind, dueDate, dueDateUnknown } = value;
    if (direction === 'I_OWE' && kind === 'INCOME_ADVANCE_RECEIVABLE') {
      ctx.addIssue({
        code: 'custom',
        path: ['kind'],
        message: 'An income advance is only valid when others owe you money.',
      });
    }
    const dateKnown = dueDate !== undefined;
    const dateExplicitlyUnknown = dueDateUnknown === true;
    if (dateKnown && dateExplicitlyUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['dueDateUnknown'],
        message: 'Do not provide both dueDate and dueDateUnknown.',
      });
    }
  });
export type DebtCreate = z.infer<typeof debtCreateSchema>;

// --- Modification d'une dette ---
// PATCH partiel des champs éditables d'une dette ACTIVE. Le backend revalide
// l'invariant `originalAmount >= Σ règlements actifs`. `direction` et `kind`
// sont IMMUABLES en V1 (les modifier changerait le sens des règlements).
export const debtUpdateSchema = z
  .object({
    originalAmount: positiveAmountSchema.optional(),
    counterpartyName: z
      .string()
      .trim()
      .max(120, 'Counterparty name must be at most 120 characters.')
      .nullable()
      .optional(),
    description: z
      .string()
      .trim()
      .max(240, 'Description must be at most 240 characters.')
      .nullable()
      .optional(),
    dueDate: dateOnlySchema.nullable().optional(),
    dueDateUnknown: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const { dueDate, dueDateUnknown } = value;
    if (dueDate !== undefined && dueDateUnknown === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['dueDateUnknown'],
        message: 'Do not provide both dueDate and dueDateUnknown.',
      });
    }
  });
export type DebtUpdate = z.infer<typeof debtUpdateSchema>;

// --- Création d'un règlement (somme RÉELLEMENT payée / reçue) ---
export const debtSettlementCreateSchema = z
  .object({
    // Montant RÉELLEMENT payé (I_OWE) ou reçu (OWED_TO_ME), toujours positif.
    amount: positiveAmountSchema,
    // Compte réellement utilisé, OU « je ne sais plus » explicite. Compte
    // absent sans unknown explicite → 400 (jamais d'ambiguïté).
    accountId: z.string().uuid().optional(),
    accountUnknown: z.boolean().optional(),
    // Date réelle OU « je ne sais plus ». Jamais « aujourd'hui » par défaut.
    occurredAt: dateOnlySchema.optional(),
    dateUnknown: z.boolean().optional(),
    description: z
      .string()
      .trim()
      .max(240, 'Description must be at most 240 characters.')
      .optional(),
  })
  .superRefine((value, ctx) => {
    const accountKnown = value.accountId !== undefined;
    const accountExplicitUnknown = value.accountUnknown === true;
    if (accountKnown && accountExplicitUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['accountUnknown'],
        message: 'Do not provide both accountId and accountUnknown.',
      });
    } else if (!accountKnown && !accountExplicitUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['accountId'],
        message: 'Provide accountId or set accountUnknown: true.',
      });
    }

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
export type DebtSettlementCreate = z.infer<
  typeof debtSettlementCreateSchema
>;


// --- Modification d'un règlement ---
// PATCH partiel : amount, compte (connu/inconnu), date, description.
// Le backend revalide ATOMIQUEMENT : Σ règlements actifs <= originalAmount.
export const debtSettlementUpdateSchema = z
  .object({
    amount: positiveAmountSchema.optional(),
    accountId: z.string().uuid().nullable().optional(),
    accountUnknown: z.boolean().optional(),
    occurredAt: dateOnlySchema.nullable().optional(),
    dateUnknown: z.boolean().optional(),
    description: z
      .string()
      .trim()
      .max(240, 'Description must be at most 240 characters.')
      .nullable()
      .optional(),
  })
  .superRefine((value, ctx) => {
    const { accountId, accountUnknown, occurredAt, dateUnknown } = value;
    if (accountId !== undefined && accountUnknown === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['accountUnknown'],
        message: 'Do not provide both accountId and accountUnknown.',
      });
    }
    if (accountId == null && accountUnknown === false) {
      ctx.addIssue({
        code: 'custom',
        path: ['accountId'],
        message: 'Provide accountId or set accountUnknown: true.',
      });
    }
    if (occurredAt !== undefined && dateUnknown === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['dateUnknown'],
        message: 'Do not provide both occurredAt and dateUnknown.',
      });
    }
    if (occurredAt == null && dateUnknown === false) {
      ctx.addIssue({
        code: 'custom',
        path: ['occurredAt'],
        message: 'Provide occurredAt or set dateUnknown: true.',
      });
    }
  });
export type DebtSettlementUpdate = z.infer<
  typeof debtSettlementUpdateSchema
>;


// --- DTO public d'un règlement ---
export const debtSettlementPublicSchema = z.object({
  id: z.string().uuid(),
  amount: z.string(),
  currency: currencySchema,
  account: z
    .object({ id: z.string().uuid(), type: accountTypeSchema })
    .nullable(),
  accountUnknown: z.boolean(),
  // Jour réel, ou null si « je ne sais plus » (dateUnknown).
  occurredAt: dateOnlySchema.nullable(),
  dateUnknown: z.boolean(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DebtSettlementPublic = z.infer<
  typeof debtSettlementPublicSchema
>;

// --- DTO analytique d'une dette ---
export const debtPublicSchema = z.object({
  id: z.string().uuid(),
  direction: debtDirectionSchema,
  kind: debtKindSchema,
  currency: currencySchema,
  // Montant initial (source de vérité), en chaîne décimale exacte.
  originalAmount: z.string(),
  // Σ des règlements ACTIFS (dérivé, jamais stocké).
  settledAmount: z.string(),
  // remaining = originalAmount − settledAmount (dérivé, jamais stocké).
  remaining: z.string(),
  counterpartyName: z.string().nullable(),
  description: z.string().nullable(),
  // Échéance réelle, ou null si dueDateUnknown.
  dueDate: dateOnlySchema.nullable(),
  dueDateUnknown: z.boolean(),
  // Statut temporel DÉRIVÉ : OPEN / SETTLED / OVERDUE.
  temporalStatus: debtTemporalStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  // Règlements partiels ACTIFS (historique), du plus ancien au plus récent.
  settlements: z.array(debtSettlementPublicSchema),
});
export type DebtPublic = z.infer<typeof debtPublicSchema>;

// --- Réponses ---
export const debtsResponseSchema = z.object({
  debts: z.array(debtPublicSchema),
});
export type DebtsResponse = z.infer<typeof debtsResponseSchema>;

export const debtMutationResponseSchema = z.object({
  debt: debtPublicSchema,
});
export type DebtMutationResponse = z.infer<typeof debtMutationResponseSchema>;

export const debtSettlementMutationResponseSchema = z.object({
  debt: debtPublicSchema,
  settlement: debtSettlementPublicSchema,
});
export type DebtSettlementMutationResponse = z.infer<
  typeof debtSettlementMutationResponseSchema
>;

