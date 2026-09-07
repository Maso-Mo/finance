import { z } from 'zod';

/**
 * Contrats partagés de la PRISE EN MAIN GUIDÉE (onboarding) entre web et api.
 *
 * L'état est volontairement minimal et PERSISTANT côté backend :
 *  - GET  /me/onboarding          → { completed: boolean } (read-only strict) ;
 *  - POST /me/onboarding/complete → mémorise la date de fin (idempotent, aucun
 *    corps requis) et répond { completed: true }.
 *
 * Règles :
 *  - la complétion ne verrouille JAMAIS une fonctionnalité (guide relançable
 *    manuellement, y compris après complétion) ;
 *  - le POST ne touche aucune donnée financière (aucune Transaction, aucun
 *    compte, aucun budget, aucun statut métier) ;
 *  - aucun secret ni type Prisma interne n'est partagé ici.
 */

// --- Statut de l'onboarding ---
export const onboardingStatusSchema = z.object({
  completed: z.boolean(),
});
export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>;

// --- Réponses (schémas dédiés pour rester explicites côté contrat) ---
export const onboardingGetResponseSchema = onboardingStatusSchema;
export type OnboardingGetResponse = z.infer<typeof onboardingGetResponseSchema>;

export const onboardingCompleteResponseSchema = onboardingStatusSchema;
export type OnboardingCompleteResponse = z.infer<
  typeof onboardingCompleteResponseSchema
>;
