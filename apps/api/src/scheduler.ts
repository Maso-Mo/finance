import cron from 'node-cron';
import { ensureAllActiveOccurrences } from './recurring-expenses/occurrences.service.js';

/**
 * Job périodique de MAINTENANCE de planification (étape 6).
 *
 * Le cron NE paie RIEN, ne crée AUCUNE Transaction et ne débite AUCUN compte :
 * il garantit uniquement l'existence des prochaines occurrences PENDING
 * (mois courant + 3 suivants). Il est IDEMPOTENT : un chevauchement avec un
 * autre passage (redémarrage, lecture) est sans effet (contrainte unique +
 * createMany skipDuplicates).
 *
 * L'application reste correcte même si ce job ne tourne pas pendant plusieurs
 * jours : GET /planned-expenses et GET /reminders rattrapent à la lecture.
 */

const CRON_DEFAULT = '15 0 * * *'; // chaque jour à 00:15 (fuseau du serveur)
let started = false;

function runOnce(): void {
  ensureAllActiveOccurrences().catch((error) => {
    console.error('[scheduler] occurrence maintenance failed:', error);
  });
}

/** Démarre le job (une seule fois) + un rattrapage immédiat au démarrage. */
export function startPlannedExpenseScheduler(): void {
  if (started) {
    return;
  }
  started = true;

  const expression = process.env.OCCURRENCE_CRON ?? CRON_DEFAULT;
  const valid = cron.validate(expression);
  if (!valid) {
    console.error(
      `[scheduler] invalid OCCURRENCE_CRON "${expression}", using default.`,
    );
    return;
  }
  cron.schedule(expression, runOnce);
  // Rattrapage immédiat : « au démarrage de l'API, la génération peut
  // rattraper proprement les occurrences manquantes ».
  runOnce();
}
