import { z } from 'zod';
import { amountInputSchema, accountTypeSchema } from './account.js';
import { monthKeySchema } from './budget.js';
import { debtDirectionSchema, debtKindSchema } from './debt.js';
import { expectedIncomeCertaintySchema } from './income.js';
import {
  dateOnlySchema,
  positiveAmountSchema,
  transactionTypeSchema,
} from './transaction.js';

/**
 * Contrats partagés de l'ASSISTANT IA FINANCIER TEXTUEL (étape 13).
 *
 * ⚠ RÈGLES DE SÉCURITÉ ABSOLUES (rappelées à chaque couche) :
 *  - le LLM n'écrit JAMAIS en base : aucune mutation ne sort d'une requête
 *    `/assistant/message` ; seule la confirmation explicite d'une proposal
 *    (POST confirm) déclenche l'exécution déterministe d'un service métier ;
 *  - le frontend ne reçoit JAMAIS le payload financier brut d'une proposal :
 *    uniquement `proposalId` + un `summary` structuré prêt à afficher ;
 *  - les actions sont TYPÉES par `actionType` (jamais de payload libre) ;
 *  - le modèle renvoie des RÉFÉRENCES symboliques (type de compte, code ou
 *    nom de catégorie) et JAMAIS des identifiants internes : le backend
 *    résout ces références vers les ids réels de l'utilisateur authentifié,
 *    ce qui rend toute « invention » de compte/catégorie impossible ;
 *  - les ids de CIBLE (transactionId, debtId, …) doivent provenir des
 *    outils read-only ; le backend valide leur existence et leur ownership
 *    avant de créer une proposition.
 */

// ---------------------------------------------------------------------------
// Requête d'un message assistant
// ---------------------------------------------------------------------------

export const assistantMessageRequestSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, 'Le message est vide.')
    .max(2000, 'Message trop long (2000 caractères maximum).'),
  // Brouillon de clarification en cours (même intention que le message
  // précédent) — le backend le recharge pour compléter l'intention.
  draftId: z.string().uuid().optional(),
  // Contexte local du navigateur — jamais déduit du serveur.
  timezone: z.string().max(80).optional(),
  localDate: dateOnlySchema.optional(),
});
export type AssistantMessageRequest = z.infer<
  typeof assistantMessageRequestSchema
>;

// ---------------------------------------------------------------------------
// Références symboliques (sortie du modèle → résolution backend)
// ---------------------------------------------------------------------------

// Champ « compte » : type de compte OU inconnu explicite (« je ne sais plus
// quel compte »). Aucun champ vide ne remplace un « je ne sais plus ».
export const assistantAccountRefSchema = z
  .object({
    accountType: accountTypeSchema.optional(),
    accountUnknown: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const known = value.accountType !== undefined;
    const explicitUnknown = value.accountUnknown === true;
    if (known && explicitUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['accountType'],
        message: 'Do not provide both accountType and accountUnknown.',
      });
    } else if (!known && !explicitUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['accountType'],
        message: 'Provide accountType or set accountUnknown: true.',
      });
    }
  });
export type AssistantAccountRef = z.infer<typeof assistantAccountRefSchema>;

// Champ « date » : jour réel OU « je ne sais plus » explicite.
export const assistantDateRefSchema = z
  .object({
    occurredAt: dateOnlySchema.optional(),
    dateUnknown: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const known = value.occurredAt !== undefined;
    const explicitUnknown = value.dateUnknown === true;
    if (known && explicitUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['occurredAt'],
        message: 'Do not provide both occurredAt and dateUnknown.',
      });
    } else if (!known && !explicitUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['occurredAt'],
        message: 'Provide occurredAt or set dateUnknown: true.',
      });
    }
  });
export type AssistantDateRef = z.infer<typeof assistantDateRefSchema>;

// Champ « catégorie de dépense » : code ou nom EXACT d'une catégorie système
// (ex. « restaurant » / « Restaurant »), OU « je ne sais plus » explicite.
export const assistantCategoryRefSchema = z
  .object({
    categoryRef: z
      .string()
      .trim()
      .min(1)
      .max(60, 'Invalid category reference.')
      .optional(),
    categoryUnknown: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const known = value.categoryRef !== undefined;
    const explicitUnknown = value.categoryUnknown === true;
    if (known && explicitUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['categoryRef'],
        message: 'Do not provide both categoryRef and categoryUnknown.',
      });
    } else if (!known && !explicitUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['categoryRef'],
        message: 'Provide categoryRef or set categoryUnknown: true.',
      });
    }
  });
export type AssistantCategoryRef = z.infer<typeof assistantCategoryRefSchema>;

// ---------------------------------------------------------------------------
// Intentions d'action (sortie STRUCTURÉE du modèle, validée par le backend)
// ---------------------------------------------------------------------------

// Création OU modification d'une transaction du journal (dépense/revenu).
// La résolution des références et la validation comptable finale restent
// 100 % backend (services existants de l'étape 5).
export const assistantTransactionIntentSchema = z
  .object({
    type: transactionTypeSchema,
    amount: positiveAmountSchema,
    description: z
      .string()
      .trim()
      .max(120, 'Description must be at most 120 characters.')
      .optional(),
    ...assistantDateRefSchema.shape,
    ...assistantAccountRefSchema.shape,
    ...assistantCategoryRefSchema.shape,
  })
  .superRefine((value, ctx) => {
    // Catégorie : obligatoire pour une EXPENSE (connue OU inconnue explicite) ;
    // un revenu n'a jamais de catégorie de dépense.
    if (value.type === 'INCOME') {
      if (value.categoryRef !== undefined || value.categoryUnknown === true) {
        ctx.addIssue({
          code: 'custom',
          path: ['categoryRef'],
          message: 'Income transactions do not have an expense category.',
        });
      }
    }
  });
export type AssistantTransactionIntent = z.infer<
  typeof assistantTransactionIntentSchema
>;

// Création OU modification d'un transfert interne réel. `savingsPlanId`
// (facultatif) ne s'utilise QUE pour une contribution EXPLICITE à un plan
// d'épargne lorsque la destination est SAVINGS (jamais déduit).
export const assistantTransferIntentSchema = z
  .object({
    sourceAccountType: accountTypeSchema,
    destinationAccountType: accountTypeSchema,
    amount: positiveAmountSchema,
    // Frais >= 0, TOUJOURS prélevés en plus sur la source (règle étape 9).
    feeAmount: amountInputSchema.optional(),
    description: z
      .string()
      .trim()
      .max(120, 'Description must be at most 120 characters.')
      .optional(),
    ...assistantDateRefSchema.shape,
    savingsPlanId: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.sourceAccountType === value.destinationAccountType) {
      ctx.addIssue({
        code: 'custom',
        path: ['destinationAccountType'],
        message: 'Source and destination accounts must be different.',
      });
    }
    if (
      value.savingsPlanId !== undefined &&
      value.destinationAccountType !== 'SAVINGS'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['savingsPlanId'],
        message: 'A savings contribution must target the SAVINGS account.',
      });
    }
  });
export type AssistantTransferIntent = z.infer<
  typeof assistantTransferIntentSchema
>;

// Dépense FUTURE PONCTUELLE (jamais une dépense réelle).
export const assistantPlannedExpenseCreateIntentSchema = z.object({
  amount: positiveAmountSchema,
  dueDate: dateOnlySchema,
  description: z
    .string()
    .trim()
    .max(120, 'Description must be at most 120 characters.')
    .optional(),
  categoryRef: z
    .string()
    .trim()
    .min(1)
    .max(60, 'Invalid category reference.')
    .optional(),
  categoryUnknown: z.boolean().optional(),
});
export type AssistantPlannedExpenseCreateIntent = z.infer<
  typeof assistantPlannedExpenseCreateIntentSchema
>;

// Modification d'une dépense future PENDING (tous champs facultatifs).
export const assistantPlannedExpensePatchSchema = z.object({
  amount: positiveAmountSchema.optional(),
  dueDate: dateOnlySchema.optional(),
  description: z
    .string()
    .trim()
    .max(120, 'Description must be at most 120 characters.')
    .nullable()
    .optional(),
  categoryRef: z
    .string()
    .trim()
    .min(1)
    .max(60, 'Invalid category reference.')
    .optional(),
  categoryUnknown: z.boolean().optional(),
});
export type AssistantPlannedExpensePatch = z.infer<
  typeof assistantPlannedExpensePatchSchema
>;

// Confirmation « Oui, payé » d'une dépense planifiée : la VRAIE dépense réelle
// (compte/date/catégorie réels OU « je ne sais plus » explicites).
export const assistantPlannedExpenseConfirmIntentSchema = z.object({
  plannedExpenseId: z.string().uuid(),
  amount: positiveAmountSchema,
  description: z
    .string()
    .trim()
    .max(120, 'Description must be at most 120 characters.')
    .optional(),
  ...assistantDateRefSchema.shape,
  ...assistantAccountRefSchema.shape,
  ...assistantCategoryRefSchema.shape,
});
export type AssistantPlannedExpenseConfirmIntent = z.infer<
  typeof assistantPlannedExpenseConfirmIntentSchema
>;

// Revenu FUTUR (création OU modification) : certitude CONFIRMED/UNCERTAIN +
// date exacte OU plage (les deux exclusives — jamais une date inventée dans
// une plage). Un revenu PENDING n'est jamais de l'argent disponible.
export const assistantExpectedIncomeIntentSchema = z
  .object({
    amount: positiveAmountSchema,
    certainty: expectedIncomeCertaintySchema,
    description: z
      .string()
      .trim()
      .max(120, 'Description must be at most 120 characters.')
      .optional(),
    expectedDate: dateOnlySchema.optional(),
    windowStart: dateOnlySchema.optional(),
    windowEnd: dateOnlySchema.optional(),
  })
  .superRefine((value, ctx) => {
    const hasExact = value.expectedDate !== undefined;
    const hasStart = value.windowStart !== undefined;
    const hasEnd = value.windowEnd !== undefined;
    if (hasExact && (hasStart || hasEnd)) {
      ctx.addIssue({
        code: 'custom',
        path: ['expectedDate'],
        message: 'Provide either a single expectedDate or a window, never both.',
      });
    }
    if (hasStart && hasEnd && value.windowStart! > value.windowEnd!) {
      ctx.addIssue({
        code: 'custom',
        path: ['windowEnd'],
        message: 'windowEnd must be after or equal to windowStart.',
      });
    }
  });
export type AssistantExpectedIncomeIntent = z.infer<
  typeof assistantExpectedIncomeIntentSchema
>;

// Confirmation « Oui, je l'ai reçu » d'un revenu futur : le VRAI revenu réel
// (compte/date réels OU « je ne sais plus » explicites).
export const assistantExpectedIncomeConfirmIntentSchema = z.object({
  expectedIncomeId: z.string().uuid(),
  amount: positiveAmountSchema,
  description: z
    .string()
    .trim()
    .max(120, 'Description must be at most 120 characters.')
    .optional(),
  ...assistantDateRefSchema.shape,
  ...assistantAccountRefSchema.shape,
});
export type AssistantExpectedIncomeConfirmIntent = z.infer<
  typeof assistantExpectedIncomeConfirmIntentSchema
>;

// Budget mensuel (limite analytique — jamais de l'argent). catégorie absente
// ⇒ budget GLOBAL du mois.
export const assistantBudgetIntentSchema = z.object({
  month: monthKeySchema,
  amount: positiveAmountSchema,
  categoryRef: z
    .string()
    .trim()
    .min(1)
    .max(60, 'Invalid category reference.')
    .optional(),
});
export type AssistantBudgetIntent = z.infer<typeof assistantBudgetIntentSchema>;

// --- Dettes / créances (étape 11) ---
// `kind` INCOME_ADVANCE_RECEIVABLE (« avance ») UNIQUEMENT si l'utilisateur la
// qualifie EXPLICITEMENT ainsi et UNIQUEMENT sur OWED_TO_ME (jamais déduit).
export const assistantDebtCreateIntentSchema = z
  .object({
    direction: debtDirectionSchema,
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
    dueDate: dateOnlySchema.optional(),
    dueDateUnknown: z.boolean().optional(),
    // Règlement initial éventuel (ex. partie déjà payée/reçue immédiatement).
    initialSettlement: z
      .object({
        amount: positiveAmountSchema,
        description: z
          .string()
          .trim()
          .max(120, 'Description must be at most 120 characters.')
          .optional(),
        ...assistantDateRefSchema.shape,
        ...assistantAccountRefSchema.shape,
      })
      .optional(),
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
export type AssistantDebtCreateIntent = z.infer<
  typeof assistantDebtCreateIntentSchema
>;

// Règlement d'une dette/créance EXISTANTE (réduit le restant ; jamais une
// Transaction EXPENSE/INCOME, sauf avance : le workflow métier s'en charge).
export const assistantDebtSettlementIntentSchema = z.object({
  debtId: z.string().uuid(),
  amount: positiveAmountSchema,
  description: z
    .string()
    .trim()
    .max(120, 'Description must be at most 120 characters.')
    .optional(),
  ...assistantDateRefSchema.shape,
  ...assistantAccountRefSchema.shape,
});
export type AssistantDebtSettlementIntent = z.infer<
  typeof assistantDebtSettlementIntentSchema
>;

// Plan d'épargne MENSUEL (limite/objectif ANALYTIQUE — jamais de l'argent).
// Modes : FIXED (fixedAmount) OU PERCENTAGE (percentage), mutuellement exclusifs.
export const assistantSavingsPlanIntentSchema = z
  .object({
    month: monthKeySchema,
    mode: z.enum(['FIXED', 'PERCENTAGE']),
    fixedAmount: positiveAmountSchema.optional(),
    percentage: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/, 'Percentage must be a positive decimal.')
      .refine((v) => Number(v) > 0 && Number(v) <= 100, 'Percentage must be in ]0, 100].')
      .optional(),
  })
  .superRefine((value, ctx) => {
    const { mode, fixedAmount, percentage } = value;
    if (mode === 'FIXED') {
      if (fixedAmount === undefined) {
        ctx.addIssue({ code: 'custom', path: ['fixedAmount'], message: 'A FIXED plan requires fixedAmount.' });
      }
      if (percentage !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['percentage'], message: 'A FIXED plan must not include a percentage.' });
      }
    } else if (percentage === undefined) {
      ctx.addIssue({ code: 'custom', path: ['percentage'], message: 'A PERCENTAGE plan requires a percentage.' });
    } else if (fixedAmount !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['fixedAmount'], message: 'A PERCENTAGE plan must not include a fixed amount.' });
    }
  });
export type AssistantSavingsPlanIntent = z.infer<
  typeof assistantSavingsPlanIntentSchema
>;


// ---------------------------------------------------------------------------
// Action ASSISTANT — union discriminée stricte (jamais de payload libre)
// ---------------------------------------------------------------------------

export const assistantActionTypeSchema = z.enum([
  'TRANSACTION_CREATE',
  'TRANSACTION_UPDATE',
  'TRANSACTION_DELETE',
  'TRANSFER_CREATE',
  'TRANSFER_UPDATE',
  'TRANSFER_DELETE',
  'PLANNED_EXPENSE_CREATE',
  'PLANNED_EXPENSE_UPDATE',
  'PLANNED_EXPENSE_CONFIRM_PAID',
  'PLANNED_EXPENSE_CANCEL',
  'EXPECTED_INCOME_CREATE',
  'EXPECTED_INCOME_UPDATE',
  'EXPECTED_INCOME_CONFIRM_RECEIVED',
  'EXPECTED_INCOME_CANCEL',
  'BUDGET_CREATE',
  'BUDGET_UPDATE',
  'BUDGET_DELETE',
  'DEBT_CREATE',
  'DEBT_SETTLEMENT_CREATE',
  'SAVINGS_PLAN_CREATE',
  'SAVINGS_PLAN_UPDATE',
  'SAVINGS_PLAN_DELETE',
]);
export type AssistantActionType = z.infer<typeof assistantActionTypeSchema>;

export const ASSISTANT_ACTION_TYPES: readonly AssistantActionType[] =
  assistantActionTypeSchema.options;

export const assistantActionSchema = z.discriminatedUnion('actionType', [
  z.object({
    actionType: z.literal('TRANSACTION_CREATE'),
    transaction: assistantTransactionIntentSchema,
  }),
  z.object({
    actionType: z.literal('TRANSACTION_UPDATE'),
    transactionId: z.string().uuid(),
    transaction: assistantTransactionIntentSchema,
  }),
  z.object({
    actionType: z.literal('TRANSACTION_DELETE'),
    transactionId: z.string().uuid(),
  }),
  z.object({
    actionType: z.literal('TRANSFER_CREATE'),
    transfer: assistantTransferIntentSchema,
  }),
  z.object({
    actionType: z.literal('TRANSFER_UPDATE'),
    transferId: z.string().uuid(),
    transfer: assistantTransferIntentSchema,
  }),
  z.object({
    actionType: z.literal('TRANSFER_DELETE'),
    transferId: z.string().uuid(),
  }),
  z.object({
    actionType: z.literal('PLANNED_EXPENSE_CREATE'),
    plannedExpense: assistantPlannedExpenseCreateIntentSchema,
  }),
  z.object({
    actionType: z.literal('PLANNED_EXPENSE_UPDATE'),
    plannedExpenseId: z.string().uuid(),
    patch: assistantPlannedExpensePatchSchema,
  }),
  z.object({
    actionType: z.literal('PLANNED_EXPENSE_CONFIRM_PAID'),
    confirmation: assistantPlannedExpenseConfirmIntentSchema,
  }),
  z.object({
    actionType: z.literal('PLANNED_EXPENSE_CANCEL'),
    plannedExpenseId: z.string().uuid(),
  }),
  z.object({
    actionType: z.literal('EXPECTED_INCOME_CREATE'),
    expectedIncome: assistantExpectedIncomeIntentSchema,
  }),
  z.object({
    actionType: z.literal('EXPECTED_INCOME_UPDATE'),
    expectedIncomeId: z.string().uuid(),
    expectedIncome: assistantExpectedIncomeIntentSchema,
  }),
  z.object({
    actionType: z.literal('EXPECTED_INCOME_CONFIRM_RECEIVED'),
    confirmation: assistantExpectedIncomeConfirmIntentSchema,
  }),
  z.object({
    actionType: z.literal('EXPECTED_INCOME_CANCEL'),
    expectedIncomeId: z.string().uuid(),
  }),
  z.object({
    actionType: z.literal('BUDGET_CREATE'),
    budget: assistantBudgetIntentSchema,
  }),
  z.object({
    actionType: z.literal('BUDGET_UPDATE'),
    budgetId: z.string().uuid(),
    amount: positiveAmountSchema,
  }),
  z.object({
    actionType: z.literal('BUDGET_DELETE'),
    budgetId: z.string().uuid(),
  }),
  z.object({
    actionType: z.literal('DEBT_CREATE'),
    debt: assistantDebtCreateIntentSchema,
  }),
  z.object({
    actionType: z.literal('DEBT_SETTLEMENT_CREATE'),
    settlement: assistantDebtSettlementIntentSchema,
  }),
  z.object({
    actionType: z.literal('SAVINGS_PLAN_CREATE'),
    savingsPlan: assistantSavingsPlanIntentSchema,
  }),
  z.object({
    actionType: z.literal('SAVINGS_PLAN_UPDATE'),
    savingsPlanId: z.string().uuid(),
    savingsPlan: assistantSavingsPlanIntentSchema,
  }),
  z.object({
    actionType: z.literal('SAVINGS_PLAN_DELETE'),
    savingsPlanId: z.string().uuid(),
  }),
]);
export type AssistantAction = z.infer<typeof assistantActionSchema>;

// ---------------------------------------------------------------------------
// Résultat STRUCTURÉ du moteur IA (une seule tentative de réparation max).
// Le modèle ne peut JAMAIS sortir une action non validée par cette union.
// ---------------------------------------------------------------------------

export const assistantEngineResultSchema = z.discriminatedUnion('kind', [
  z.object({
    // Réponse READ-ONLY à une question financière (données des outils).
    kind: z.literal('ANSWER'),
    text: z.string().trim().min(1).max(4000),
  }),
  z.object({
    // Demande de précision décidée par le modèle (ambiguïté non structurable).
    kind: z.literal('ASK_CLARIFICATION'),
    question: z.string().trim().min(1).max(1000),
  }),
  z.object({
    // Proposition d'action (l'intention peut être INCOMPLÈTE : le backend
    // détecte les champs réellement manquants et pose une clarification
    // déterministe via un AssistantDraft).
    kind: z.literal('PROPOSE_ACTION'),
    text: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional(),
    action: assistantActionSchema,
  }),
  z.object({
    kind: z.literal('UNSUPPORTED'),
    text: z.string().trim().min(1).max(1000),
  }),
]);
export type AssistantEngineResult = z.infer<typeof assistantEngineResultSchema>;

// Appel d'outil du protocole interne (les outils sont déclarés au modèle dans
// le prompt ; le backend n'exécute QUE les outils read-only de sa registry).
export const assistantEngineToolCallSchema = z.object({
  name: z.string().trim().min(1).max(60),
  args: z.record(z.string(), z.unknown()).optional(),
});
export type AssistantEngineToolCall = z.infer<
  typeof assistantEngineToolCallSchema
>;

// Une « passe » du moteur : appels d'outils OU résultat final.
export const assistantEngineTurnSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('TOOL_CALLS'),
    calls: z.array(assistantEngineToolCallSchema).min(1).max(4),
  }),
  z.object({ kind: z.literal('RESULT'), result: assistantEngineResultSchema }),
]);
export type AssistantEngineTurn = z.infer<typeof assistantEngineTurnSchema>;

// Champs réellement manquants détectés par le BACKEND (liste courte, ex.
// ["account","category","date"]) — le LLM ne les déduit jamais lui-même.
export const assistantMissingFieldSchema = z.enum([
  'type',
  'amount',
  'date',
  'account',
  'category',
  'certainty',
  'dueDate',
  'expectedDate',
  'target',
  'counterparty',
  'month',
  'plan',
]);
export type AssistantMissingField = z.infer<typeof assistantMissingFieldSchema>;

// ---------------------------------------------------------------------------
// DTO publics de l'API /assistant (le payload financier n'est JAMAIS exposé)
// ---------------------------------------------------------------------------

// GET /assistant/status — mode dégradé si aucune configuration IA.
export const assistantStatusSchema = z.object({
  available: z.boolean(),
  provider: z.string().nullable(),
  // Limites techniques du moteur (documentées, exposées au frontend).
  maxToolCalls: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  draftTtlMinutes: z.number().int().positive(),
  proposalTtlMinutes: z.number().int().positive(),
});
export type AssistantStatus = z.infer<typeof assistantStatusSchema>;

// Résumé structuré SÛR d'une proposition (généré par le backend depuis le
// payload validé ; le frontend n'a jamais besoin du payload brut).
export const assistantProposalSummarySchema = z.object({
  // Titre de la carte, ex. « Dépense à enregistrer ».
  title: z.string().trim().min(1).max(120),
  // Lignes label → valeur, ex. { label: 'Montant', value: '40 000 Ar' }.
  lines: z
    .array(z.object({ label: z.string().trim().min(1).max(40), value: z.string().trim().min(1).max(200) }))
    .max(14),
  // Libellé du bouton de confirmation, ex. « Confirmer la dépense ».
  confirmLabel: z.string().trim().min(1).max(60),
  // Libellé neutre de l'action exécutée, ex. « Dépense enregistrée. »
  doneMessage: z.string().trim().min(1).max(160),
});
export type AssistantProposalSummary = z.infer<
  typeof assistantProposalSummarySchema
>;

export const assistantProposalStatusSchema = z.enum([
  'PENDING',
  'EXECUTED',
  'CANCELED',
  'EXPIRED',
  'FAILED',
]);
export type AssistantProposalStatus = z.infer<
  typeof assistantProposalStatusSchema
>;

export const assistantProposalPublicSchema = z.object({
  id: z.string().uuid(),
  actionType: assistantActionTypeSchema,
  summary: assistantProposalSummarySchema,
  status: assistantProposalStatusSchema,
  expiresAt: z.string(),
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
  executedAt: z.string().nullable(),
  canceledAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  resultingResourceType: z.string().nullable(),
  resultingResourceId: z.string().nullable(),
});
export type AssistantProposalPublic = z.infer<
  typeof assistantProposalPublicSchema
>;

// --- Réponses de POST /assistant/message ---
export const assistantAnswerResponseSchema = z.object({
  kind: z.literal('ANSWER'),
  text: z.string(),
});
export type AssistantAnswerResponse = z.infer<
  typeof assistantAnswerResponseSchema
>;

export const assistantAskClarificationResponseSchema = z.object({
  kind: z.literal('ASK_CLARIFICATION'),
  text: z.string(),
  // Brouillon à transmettre avec la prochaine réponse (même intention).
  draftId: z.string().uuid().nullable(),
});
export type AssistantAskClarificationResponse = z.infer<
  typeof assistantAskClarificationResponseSchema
>;

export const assistantProposeActionResponseSchema = z.object({
  kind: z.literal('PROPOSE_ACTION'),
  // Message optionnel accompagnant la carte.
  text: z.string().nullable(),
  proposal: assistantProposalPublicSchema,
});
export type AssistantProposeActionResponse = z.infer<
  typeof assistantProposeActionResponseSchema
>;

export const assistantUnsupportedResponseSchema = z.object({
  kind: z.literal('UNSUPPORTED'),
  text: z.string(),
});
export type AssistantUnsupportedResponse = z.infer<
  typeof assistantUnsupportedResponseSchema
>;

export const assistantMessageResponseSchema = z.discriminatedUnion('kind', [
  assistantAnswerResponseSchema,
  assistantAskClarificationResponseSchema,
  assistantProposeActionResponseSchema,
  assistantUnsupportedResponseSchema,
]);
export type AssistantMessageResponse = z.infer<
  typeof assistantMessageResponseSchema
>;

// --- Réponse de POST /assistant/proposals/:id/confirm ---
// `result` n'est présent qu'après une exécution RÉUSSIE (audit minimal).
export const assistantProposalConfirmResponseSchema = z.object({
  proposal: assistantProposalPublicSchema,
  result: z
    .object({
      message: z.string(),
      resourceType: z.string().nullable(),
      resourceId: z.string().nullable(),
    })
    .nullable(),
});
export type AssistantProposalConfirmResponse = z.infer<
  typeof assistantProposalConfirmResponseSchema
>;



