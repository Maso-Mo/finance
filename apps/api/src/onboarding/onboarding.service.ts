import { prisma } from '../db.js';
import { ApiError } from '../http-error.js';
import type {
  OnboardingCompleteResponse,
  OnboardingGetResponse,
} from '@finance/shared-types';

/**
 * Service de la PRISE EN MAIN GUIDÉE (onboarding) — état persistant minimal.
 *
 * Règles défendues ici :
 *  - GET  : lecture seule de l'état (jamais d'écriture, jamais de génération) ;
 *  - POST : mémorise la date de fin — idempotent, sans corps requis, et ne
 *    touche à AUCUNE donnée financière (aucune Transaction/Account/statut) ;
 *  - la complétion ne verrouille aucune fonctionnalité : l'utilisateur peut
 *    relancer le guide manuellement sans jamais réinitialiser l'état.
 */
export async function getOnboardingStatus(
  userId: string,
): Promise<OnboardingGetResponse> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { onboardingCompletedAt: true },
  });
  if (!row) {
    throw new ApiError(404, 'User not found.');
  }
  return { completed: row.onboardingCompletedAt !== null };
}

export async function completeOnboarding(
  userId: string,
): Promise<OnboardingCompleteResponse> {
  await prisma.user.update({
    where: { id: userId },
    data: { onboardingCompletedAt: new Date() },
  });
  return { completed: true };
}
