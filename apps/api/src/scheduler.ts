import cron from 'node-cron';
import { ensureAllActiveOccurrences } from './recurring-expenses/occurrences.service.js';

/**
 * Job périodique de MAINTENANCE de planification (étape 6).
 *
 * Le cron NE paie RIEN, ne crée AUCUNE Transaction et ne débite AUCUN compte :
 * il garantit uniquement l'existence des prochaines occurrences PENDING
 * (mois courant + 3 suivants). Il est IDEMPOTENT : un chevauchement avec un
 * autre passage (redémarrage, mutation concurrente d'une règle) est sans
 * effet (contrainte unique + createMany skipDuplicates).
 *
 * La maintenance n'est JAMAIS déclenchée par une lecture (les routes GET sont
 * strictement read-only). Les seuls déclencheurs sont explicites :
 *  - bootstrap : `startPlannedExpenseScheduler()` exécute immédiatement une
 *    passe au démarrage de l'API (API arrêtée plusieurs jours → redémarrage →
 *    rattrapage des mois manquants) ;
 *  - cron quotidien : le même point d'entrée maintient ensuite l'horizon.
 */

const CRON_DEFAULT = '15 0 * * *'; // chaque jour à 00:15 (fuseau du serveur)
let started = false;

/**
 * Passe de maintenance idempotente (cron quotidien + bootstrap au démarrage).
 * Exportée en tant que `Promise` afin que les tests puissent attendre la fin
 * de la passe (le bootstrap et le cron utilisent exactement cette logique).
 */
export async function runOccurrenceMaintenance(): Promise<void> {
  await ensureAllActiveOccurrences();
}

/** Variante silencieuse pour le cron / le bootstrap (log en cas d'échec). */
function runOccurrenceMaintenanceQuietly(): void {
  runOccurrenceMaintenance().catch((error) => {
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
  if (cron.validate(expression)) {
    cron.schedule(expression, runOccurrenceMaintenanceQuietly);
  } else {
    console.error(
      `[scheduler] invalid OCCURRENCE_CRON "${expression}", daily job disabled.`,
    );
  }
  // Rattrapage immédiat QUOI QU'IL ARRIVE : au démarrage de l'API, la
  // génération peut rattraper proprement les occurrences manquantes, même si
  // l'API a été arrêtée pendant plusieurs jours.
  runOccurrenceMaintenanceQuietly();
}
