/**
 * Transport Web Push (étape 12).
 *
 * Unique point d'appel de la librairie `web-push` (protocole VAPID). Ce
 * module est volontairement MINCE et MOCKABLE : les tests API remplacent
 * `sendWebPush` par un stub pour simuler succès, 404/410 (abonnement expiré)
 * ou erreurs temporaires, sans jamais toucher un vrai fournisseur Push.
 *
 * Sécurité :
 *  - si VAPID n'est pas configuré → résultat `NOT_CONFIGURED` (le centre
 *    interne et le scheduler restent fonctionnels) ;
 *  - les erreurs sont normalisées en codes courts ; l'endpoint complet et les
 *    clés ne sont JAMAIS loggés.
 */
import webpush from 'web-push';
import { isWebPushConfigured, readVapidConfig } from './push-config.js';

export interface PushSubscriptionMaterial {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushSendResult =
  | { ok: true }
  | { ok: false; code: string };

let vapidInitialized = false;

function ensureVapid(): void {
  if (vapidInitialized) {
    return;
  }
  vapidInitialized = true;
  const config = readVapidConfig();
  if (config.publicKey && config.privateKey) {
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  }
}

/**
 * Envoie une notification Web Push. Ne lève JAMAIS : l'échec d'une livraison
 * ne doit jamais faire tomber le scheduler ni le centre de notifications.
 */
export async function sendWebPush(
  subscription: PushSubscriptionMaterial,
  payload: unknown,
): Promise<PushSendResult> {
  if (!isWebPushConfigured()) {
    return { ok: false, code: 'NOT_CONFIGURED' };
  }
  ensureVapid();
  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.p256dh,
          auth: subscription.auth,
        },
      },
      JSON.stringify(payload),
      // TTL 24 h : si le navigateur est hors-ligne, le fournisseur ne
      // réessaie pas au-delà du jour du rappel.
      { TTL: 60 * 60 * 24 },
    );
    return { ok: true };
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 404 || statusCode === 410) {
      // Abonnement expiré/désinscrit côté fournisseur : à désactiver.
      return { ok: false, code: 'SUBSCRIPTION_GONE' };
    }
    return { ok: false, code: 'SEND_FAILED' };
  }
}
