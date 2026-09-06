/**
 * Push navigateur (étape 12) — côté web.
 *
 * Le consentement n'est JAMAIS demandé automatiquement (ni au chargement, ni
 * après login/register/navigation) : `enableBrowserPush` n'est appelé qu'au
 * clic EXPLICITE sur « Activer les notifications navigateur ».
 *
 * `Notification.permission` reste la source de vérité du navigateur : un
 * refus (`denied`) est respecté — aucune nouvelle demande automatique.
 */

export type BrowserPushResult =
  | { ok: true; subscription: PushSubscriptionJSON }
  | {
      ok: false;
      reason:
        | 'unsupported'
        | 'unavailable'
        | 'denied'
        | 'not-granted'
        | 'failed';
      message?: string;
    };

export const SW_URL = '/sw.js';

/** Le navigateur supporte-t-il Service Worker + Push + Notification ? */
export function isBrowserPushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** PushSubscription JSON → corps POST /push-subscriptions (aucune clé privée). */
export function subscriptionToPayload(
  subscription: PushSubscriptionJSON,
): { endpoint: string; p256dh: string; auth: string } {
  return {
    endpoint: subscription.endpoint ?? '',
    p256dh: subscription.keys?.p256dh ?? '',
    auth: subscription.keys?.auth ?? '',
  };
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64WithPadding = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64WithPadding);
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/**
 * Flux d'activation — appelé UNIQUEMENT sur clic utilisateur :
 *  1. vérifier le support ;
 *  2. demander la permission ;
 *  3. enregistrer le Service Worker ;
 *  4. obtenir/créer le PushSubscription ;
 *  5. le retourner au frontend pour l'envoyer au backend authentifié.
 */
export async function enableBrowserPush(
  publicKey: string | null,
): Promise<BrowserPushResult> {
  if (!isBrowserPushSupported()) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'Notifications navigateur non prises en charge sur ce navigateur.',
    };
  }
  if (!publicKey) {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'Le Web Push n’est pas configuré sur le serveur.',
    };
  }
  if (Notification.permission === 'denied') {
    return {
      ok: false,
      reason: 'denied',
      message:
        'Notifications refusées dans ce navigateur. Débloquez-les dans les réglages du site pour réessayer.',
    };
  }
  let permission: NotificationPermission = Notification.permission;
  if (permission === 'default') {
    permission = await Notification.requestPermission();
  }
  if (permission !== 'granted') {
    return { ok: false, reason: 'not-granted' };
  }

  try {
    const registration = await navigator.serviceWorker.register(SW_URL);
    await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    return { ok: true, subscription: subscription.toJSON() };
  } catch (error) {
    return {
      ok: false,
      reason: 'failed',
      message: error instanceof Error ? error.message : 'Subscription failed.',
    };
  }
}

/**
 * Désactivation navigateur : désabonne le PushSubscription local si possible
 * (le backend garde une désactivation LOGIQUE via DELETE /push-subscriptions).
 */
export async function disableBrowserPush(): Promise<boolean> {
  if (!isBrowserPushSupported()) {
    return false;
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration(SW_URL);
    if (!registration) {
      return true;
    }
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await subscription.unsubscribe();
    }
    return true;
  } catch {
    return false;
  }
}

/** État courant : support + permission (aucune demande automatique). */
export function currentPushStatus(): {
  supported: boolean;
  permission: string;
  enabled: boolean;
} {
  const supported = isBrowserPushSupported();
  const permission =
    supported && 'Notification' in window ? Notification.permission : 'denied';
  return { supported, permission, enabled: supported && permission === 'granted' };
}
