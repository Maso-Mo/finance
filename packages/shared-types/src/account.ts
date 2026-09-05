import { z } from 'zod';

/**
 * Contrats partagés des comptes financiers (V1).
 * Aucun modèle Prisma n'est exposé ici : uniquement les DTO publics.
 */

// --- Types de comptes V1 (fixes) ---
export const accountTypeSchema = z.enum([
  'BANK',
  'MVOLA',
  'ORANGE_MONEY',
  'AIRTEL_MONEY',
  'CASH',
  'SAVINGS',
]);

export type AccountType = z.infer<typeof accountTypeSchema>;

/** Ordre canonique (affichage + création + backfill). */
export const ACCOUNT_TYPES: readonly AccountType[] = [
  'BANK',
  'MVOLA',
  'ORANGE_MONEY',
  'AIRTEL_MONEY',
  'CASH',
  'SAVINGS',
];

// --- Devise principale V1 ---
export const currencySchema = z.enum(['MGA', 'EUR', 'CAD']);
export type Currency = z.infer<typeof currencySchema>;

export const CURRENCIES: readonly Currency[] = ['MGA', 'EUR', 'CAD'];

// --- Montant monétaire (entrée) ---
// Nombre décimal positif (>= 0), jusqu'à 2 décimales. Refuse NaN, Infinity,
// les valeurs négatives et la syntaxe invalide. Le stockage/calcul reste
// exact (decimal.js côté backend), indépendamment des décimales affichées.
export const amountInputSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'Amount must be a non-negative number (max 2 decimals).');

export type AmountInput = z.infer<typeof amountInputSchema>;

// --- DTO publics ---
export const accountPublicSchema = z.object({
  id: z.string().uuid(),
  type: accountTypeSchema,
  currency: currencySchema,
  // Solde de départ saisi manuellement, exact, en chaîne.
  initialBalance: z.string(),
  // Solde COURANT dérivé (lecture) : initialBalance + revenus − dépenses du
  // journal de transactions (règle finance-core), exact, en chaîne.
  balance: z.string(),
});
export type AccountPublic = z.infer<typeof accountPublicSchema>;

export const accountTargetBalanceSchema = z.object({
  // « Je veux que le solde connu de ce compte devienne X ». Le backend décide :
  //  - aucun mouvement actif  → il met à jour initialBalance ;
  //  - au moins un mouvement  → il crée un AccountAdjustment (correction).
  targetBalance: amountInputSchema,
});
export type AccountTargetBalanceUpdate = z.infer<
  typeof accountTargetBalanceSchema
>;

export const currencyPreferenceSchema = z.object({
  currency: currencySchema,
});
export type CurrencyPreference = z.infer<typeof currencyPreferenceSchema>;

export const dashboardResponseSchema = z.object({
  currency: currencySchema,
  accounts: z.array(accountPublicSchema),
  // Total disponible (règle finance-core), exact, en chaîne.
  totalAvailable: z.string(),
});
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;

export const accountUpdateResponseSchema = z.object({
  account: accountPublicSchema,
  totalAvailable: z.string(),
});
export type AccountUpdateResponse = z.infer<typeof accountUpdateResponseSchema>;
