import cron from 'node-cron';
import { runNotificationMaintenance } from './notification-scheduler.js';

/**
 * Démarreur du scheduler NOTIFICATIONS (étape 12).
 *
 * Cadence : un tick toutes les heures (défaut « 5 * * * * ») + UN rattrapage
 * immédiat au démarrage de l'API (bootstrap) : si l'API était arrêtée à 09:00
 * et redémarre à 11:00, le rappel journalier manquant du jour local est créé.
 *
 * La passe est IDEMPOTENTE : la contrainte UNIQUE `dedupeKey` garantit qu'un
 * même rappel quotidien n'est produit qu'UNE fois, quel que soit le nombre de
 * ticks / de redémarrages / de chevauchements.
 *
 * La maintenance n'est JAMAIS déclenchée par une lecture (les GET sont
 * strictement read-only).
 */
const CRON_DEFAULT = '5 * * * *'; // toutes les heures à HH:05
let started = false;

function runQuietly(): void {
  runNotificationMaintenance().catch((error) => {
    console.error('[notifications-scheduler] maintenance failed:', error);
  });
}

export function startNotificationsScheduler(): void {
  if (started) {
    return;
  }
  started = true;

  const expression = process.env.NOTIFICATIONS_CRON ?? CRON_DEFAULT;
  if (cron.validate(expression)) {
    cron.schedule(expression, runQuietly);
  } else {
    console.error(
      `[notifications-scheduler] invalid NOTIFICATIONS_CRON "${expression}", hourly job disabled.`,
    );
  }
  // Rattrapage immédiat QUOI QU'IL ARRIVE au démarrage (bootstrap explicite).
  runQuietly();
}
