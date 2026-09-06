import { z } from 'zod';
import {
  accountTypeSchema,
  amountInputSchema,
  currencySchema,
} from './account.js';
import { dateOnlySchema } from './transaction.js';

/**
 * Contrats partagés des TRANSFERTS INTERNES RÉELS (étape 9).
 *
 * ⚠ INVARIANT ABSOLU : un transfert n'est NI une Transaction EXPENSE sur la
 * source NI une Transaction INCOME sur la destination. Créer un Transfer ne
 * crée AUCUNE Transaction : il n'impacte QUE les soldes courants dérivés
 * (source −(amount + fee), destination +amount). Aucun modèle Prisma n'est
 * exposé ici (DTO publics uniquement).
 *
 * Règles :
 *  - `amount`     = SOMME CRÉDITÉE sur la destination (strictement > 0) ;
 *  - `feeAmount`  = frais (>= 0, 0 = aucun) TOUJOURS prélevés EN PLUS sur la
 *    SOURCE en V1 ;
 *  - `sourceAccountId` <> `destinationAccountId` (défendu côté API, base et
 *    UI) ;
 *  - date : `occurredAt` (jour réel) OU `dateUnknown: true` explicite. Jamais
 *    de « aujourd'hui » automatique : aucune date + dateUnknown absent → refus.
 *  - montants transmis en chaînes décimales exactes (jamais de flottant).
 */

// --- Identifiants ---
const uuidSchema = z.string().uuid();

// --- Montants (chaînes décimales exactes, cf. account.amountInputSchema) ---
// Montant crédité sur la destination : STRICTEMENT positif.
export const transferAmountSchema = amountInputSchema.refine(
  (value) => /[1-9]/.test(value),
  'Transfer amount must be greater than 0.',
);

// Frais : nuls ou positifs (la regex de base rejette négatifs/NaN/Infinity).
export const transferFeeSchema = amountInputSchema;

/**
 * Corps de création ET de modification (PATCH = remplacement atomique complet
 * : le nouvel état remplace l'ancien — source, destination, montant, frais,
 * date, description).
 */
export const transferUpsertSchema = z
  .object({
    sourceAccountId: uuidSchema,
    destinationAccountId: uuidSchema,
    amount: transferAmountSchema,
    feeAmount: transferFeeSchema.optional(),
    // Jour réel du transfert. Aucun défaut « aujourd'hui » : date fournie OU
    // dateUnknown: true explicite (« Je ne sais plus »).
    occurredAt: dateOnlySchema.optional(),
    dateUnknown: z.boolean().optional(),
    description: z
      .string()
      .trim()
      .max(120, 'Description must be at most 120 characters.')
      .optional(),
  })
  .superRefine((value, ctx) => {
    // --- Date connue XOR « je ne sais plus » explicite ---
    const dateKnown = value.occurredAt !== undefined;
    const dateExplicitUnknown = value.dateUnknown === true;
    if (dateKnown && dateExplicitUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['occurredAt'],
        message: 'Do not provide both occurredAt and dateUnknown.',
      });
    } else if (!dateKnown && !dateExplicitUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['dateUnknown'],
        message: 'Provide occurredAt or set dateUnknown: true.',
      });
    }

    // --- Source et destination distinctes ---
    if (
      value.sourceAccountId !== undefined &&
      value.destinationAccountId !== undefined &&
      value.sourceAccountId === value.destinationAccountId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['destinationAccountId'],
        message: 'Source and destination accounts must be different.',
      });
    }
  });
export type TransferUpsert = z.infer<typeof transferUpsertSchema>;

// La création et la modification partagent le même contrat complet (remplacement).
export const transferCreateSchema = transferUpsertSchema;
export type TransferCreate = TransferUpsert;
export const transferUpdateSchema = transferUpsertSchema;
export type TransferUpdate = TransferUpsert;

// --- DTO publics ---
export const transferAccountPublicSchema = z.object({
  id: z.string().uuid(),
  type: accountTypeSchema,
});

export const transferPublicSchema = z.object({
  id: z.string().uuid(),
  // Compte DEBITÉ : −(amount + fee).
  source: transferAccountPublicSchema,
  // Compte CRÉDITÉ : +amount.
  destination: transferAccountPublicSchema,
  // Somme créditée sur la destination, exacte, en chaîne.
  amount: z.string(),
  // Frais prélevés EN PLUS sur la source (0 = aucun).
  feeAmount: z.string(),
  currency: currencySchema,
  // Jour réel, ou null si l'utilisateur a indiqué ne pas savoir.
  occurredAt: dateOnlySchema.nullable(),
  dateUnknown: z.boolean(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TransferPublic = z.infer<typeof transferPublicSchema>;

export const transferMutationResponseSchema = z.object({
  transfer: transferPublicSchema,
});
export type TransferMutationResponse = z.infer<
  typeof transferMutationResponseSchema
>;

/** Historique GLOBAL paginé (transfers ACTIFS uniquement). */
export const transfersResponseSchema = z.object({
  transfers: z.array(transferPublicSchema),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
});
export type TransfersResponse = z.infer<typeof transfersResponseSchema>;
