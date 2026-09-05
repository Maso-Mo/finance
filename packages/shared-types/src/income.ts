import { z } from 'zod';
import { currencySchema } from './account.js';
import {
  dateOnlySchema,
  positiveAmountSchema,
  transactionAllocationInputSchema,
  transactionPublicSchema,
} from './transaction.js';

/**
 * Contrats partagés des REVENUS FUTURS (étape 7).
 *
 * ⚠ RÈGLE ABSOLUE : UN REVENU FUTUR N'EST PAS DE L'ARGENT REÇU.
 *  - PENDING (CONFIRMED comme UNCERTAIN) : aucun impact sur un compte, le
 *    Total disponible ou les statistiques réelles ;
 *  - il ne devient une vraie Transaction INCOME qu'après confirmation
 *    explicite (« Oui, je l'ai reçu ») via
 *    POST /expected-incomes/:id/confirm-received.
 *
 * « CONFIRMED / UNCERTAIN » décrit la CERTITUDE du revenu futur (attendu vs
 * espéré), jamais son statut de réception. Le statut temporel
 * (à venir / aujourd'hui / dans la période / en retard) est DÉRIVÉ de la date
 * exacte ou de la plage + du statut (jamais stocké, jamais choisi à la place
 * de l'utilisateur).
 *
 * Deux formes temporelles, mutuellement exclusives (V1 : jamais aucune
 * absence) :
 *  - date EXACTE  → expectedDate (YYYY-MM-DD) ;
 *  - PLAGE        → windowStart + windowEnd (les deux, start <= end).
 * Le système n'invente JAMAIS une date exacte dans une plage.
 */

// --- Certitude du revenu futur ---
export const expectedIncomeCertaintySchema = z.enum([
  'CONFIRMED',
  'UNCERTAIN',
]);
export type ExpectedIncomeCertainty = z.infer<
  typeof expectedIncomeCertaintySchema
>;

export const EXPECTED_INCOME_CERTAINTIES: readonly ExpectedIncomeCertainty[] = [
  'CONFIRMED',
  'UNCERTAIN',
];

// --- Statut du revenu futur (réception, pas certitude) ---
export const expectedIncomeStatusSchema = z.enum([
  'PENDING',
  'RECEIVED',
  'CANCELED',
]);
export type ExpectedIncomeStatus = z.infer<typeof expectedIncomeStatusSchema>;

export const EXPECTED_INCOME_STATUSES: readonly ExpectedIncomeStatus[] = [
  'PENDING',
  'RECEIVED',
  'CANCELED',
];

// --- Catégorie temporelle dérivée (rappel « Reçu ? ») ---
//  - date exacte  : upcoming / dueToday / overdue ;
//  - plage        : upcoming (avant start) / inWindow (start..end inclus) /
//                   overdue (après end).
export const incomeReminderBucketSchema = z.enum([
  'upcoming',
  'dueToday',
  'inWindow',
  'overdue',
]);
export type IncomeReminderBucket = z.infer<typeof incomeReminderBucketSchema>;
// --- Corps de création ET de modification ---
// PATCH = remplacement complet des champs éditables d'un revenu PENDING
// (montant, certitude, description, et la forme temporelle ENTIÈRE : exacte
// OU plage). Aucun champ vide ambigu possible.
export const expectedIncomeUpsertSchema = z
  .object({
    amount: positiveAmountSchema,
    certainty: expectedIncomeCertaintySchema,
    description: z
      .string()
      .trim()
      .max(120, 'Description must be at most 120 characters.')
      .optional(),
    // Une SEULE forme active : expectedDate XOR (windowStart + windowEnd).
    expectedDate: dateOnlySchema.optional(),
    windowStart: dateOnlySchema.optional(),
    windowEnd: dateOnlySchema.optional(),
  })
  .superRefine((value, ctx) => {
    const { expectedDate, windowStart, windowEnd } = value;
    const hasExact = expectedDate !== undefined;
    const hasStart = windowStart !== undefined;
    const hasEnd = windowEnd !== undefined;

    if (hasExact && (hasStart || hasEnd)) {
      ctx.addIssue({
        code: 'custom',
        path: ['expectedDate'],
        message:
          'Provide either a single expectedDate OR a window (windowStart + windowEnd), never both.',
      });
      return;
    }
    if (hasExact) {
      return; // date exacte seule : valide.
    }
    if (!hasStart || !hasEnd) {
      ctx.addIssue({
        code: 'custom',
        path: ['windowStart'],
        message:
          'Provide a window with both windowStart and windowEnd (or a single expectedDate).',
      });
      return;
    }
    if (windowEnd! < windowStart!) {
      ctx.addIssue({
        code: 'custom',
        path: ['windowEnd'],
        message: 'windowEnd must not be before windowStart.',
      });
    }
  });
export type ExpectedIncomeUpsert = z.infer<typeof expectedIncomeUpsertSchema>;

// La création et la modification partagent le même contrat complet.
export const expectedIncomeCreateSchema = expectedIncomeUpsertSchema;
export type ExpectedIncomeCreate = ExpectedIncomeUpsert;
export const expectedIncomeUpdateSchema = expectedIncomeUpsertSchema;
export type ExpectedIncomeUpdate = ExpectedIncomeUpsert;
// --- DTO public d'un revenu futur ---
export const expectedIncomePublicSchema = z.object({
  id: z.string().uuid(),
  // Montant ATTENDU, positif, exact (chaîne). Même reçu, le revenu futur
  // conserve sa valeur prévue : la valeur réellement reçue vit dans la
  // Transaction INCOME liée.
  amount: z.string(),
  currency: currencySchema,
  certainty: expectedIncomeCertaintySchema,
  status: expectedIncomeStatusSchema,
  description: z.string().nullable(),
  // Une seule forme active en base (invariant service + Zod) : expectedDate
  // OU windowStart + windowEnd. Les trois ne sont jamais remplis ensemble.
  expectedDate: dateOnlySchema.nullable(),
  windowStart: dateOnlySchema.nullable(),
  windowEnd: dateOnlySchema.nullable(),
  // Lien vers la vraie Transaction INCOME créée lors du « Oui, je l'ai reçu ».
  receivedTransactionId: z.string().uuid().nullable(),
  // Catégorie temporelle dérivée (null si le revenu n'est plus PENDING).
  reminderBucket: incomeReminderBucketSchema.nullable(),
  // Transaction réelle complète quand le revenu est RECEIVED (sinon null).
  receivedTransaction: transactionPublicSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExpectedIncomePublic = z.infer<typeof expectedIncomePublicSchema>;

export const expectedIncomesResponseSchema = z.object({
  // Jour local utilisé pour dériver reminderBucket (YYYY-MM-DD).
  today: dateOnlySchema,
  expectedIncomes: z.array(expectedIncomePublicSchema),
});
export type ExpectedIncomesResponse = z.infer<
  typeof expectedIncomesResponseSchema
>;

export const expectedIncomeMutationResponseSchema = z.object({
  expectedIncome: expectedIncomePublicSchema,
});
export type ExpectedIncomeMutationResponse = z.infer<
  typeof expectedIncomeMutationResponseSchema
>;
// --- Confirmation « Oui, je l'ai reçu » : le VRAI revenu ---
// Formulaire du réel : montant réellement reçu (pré-rempli avec l'attendu,
// mais corrigeable), date réelle ou « je ne sais plus », compte(s) réel(s) ou
// « je ne sais plus ». Les revenus n'ont pas de catégorie de dépense.
export const expectedIncomeConfirmReceivedSchema = z
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
  });
export type ExpectedIncomeConfirmReceived = z.infer<
  typeof expectedIncomeConfirmReceivedSchema
>;

export const expectedIncomeConfirmReceivedResponseSchema = z.object({
  expectedIncome: expectedIncomePublicSchema,
  transaction: transactionPublicSchema,
});
export type ExpectedIncomeConfirmReceivedResponse = z.infer<
  typeof expectedIncomeConfirmReceivedResponseSchema
>;

// --- Rappels internes « Reçu ? » (read-only, états dérivés) ---
export const incomeRemindersResponseSchema = z.object({
  // Jour local transmis par le frontend (YYYY-MM-DD), base des calculs.
  today: dateOnlySchema,
  overdue: z.array(expectedIncomePublicSchema),
  dueToday: z.array(expectedIncomePublicSchema),
  inWindow: z.array(expectedIncomePublicSchema),
  upcoming: z.array(expectedIncomePublicSchema),
});
export type IncomeRemindersResponse = z.infer<
  typeof incomeRemindersResponseSchema
>;
