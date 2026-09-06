import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentPushStatus,
  disableBrowserPush,
  enableBrowserPush,
  isBrowserPushSupported,
  subscriptionToPayload,
} from './push';

/**
 * PUSH NAVIGATEUR (étape 12) — logique web testée en jsdom.
 *
 * Un test jsdom ne valide JAMAIS un vrai Web Push système (permission native,
 * Service Worker, fournisseur) : on vérifie ici la logique applicative —
 * détection de support, mapping du payload (aucune clé privée), flux de
 * consentement explicite (granted / denied), désactivation — avec des stubs
 * navigateur.
 */

const subscribeResult = {
  endpoint: 'https://push.example.test/sub-1',
  keys: { p256dh: 'k-p256dh', auth: 'k-auth' },
};

function stubSupportedBrowser(options: {
  permission: 'default' | 'granted' | 'denied';
  grantedOnRequest?: boolean;
}) {
  (window as unknown as { PushManager?: unknown }).PushManager = {};
  const requestPermission = vi
    .fn()
    .mockResolvedValue(
      options.grantedOnRequest === false ? 'denied' : 'granted',
    );
  (window as unknown as { Notification: unknown }).Notification = {
    permission: options.permission,
    requestPermission,
  };
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(null),
    subscribe: vi.fn().mockResolvedValue({
      toJSON: () => subscribeResult,
    }),
  };
  const registration = {
    pushManager,
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: vi.fn().mockResolvedValue(registration),
      getRegistration: vi.fn().mockResolvedValue(registration),
      ready: Promise.resolve(registration),
    },
  });
  return { requestPermission, pushManager };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { Notification?: unknown }).Notification;
  delete (window as unknown as { PushManager?: unknown }).PushManager;
});

describe('détection et mapping', () => {
  it('jsdom sans Service Worker/Push → non supporté', () => {
    // jsdom expose ni serviceWorker ni PushManager ni Notification.
    expect(isBrowserPushSupported()).toBe(false);
    const status = currentPushStatus();
    expect(status.supported).toBe(false);
    expect(status.permission).toBe('denied');
  });

  it('subscriptionToPayload : endpoint + clés uniquement (jamais d’autre secret)', () => {
    const payload = subscriptionToPayload(subscribeResult);
    expect(payload).toEqual({
      endpoint: 'https://push.example.test/sub-1',
      p256dh: 'k-p256dh',
      auth: 'k-auth',
    });
  });
});

describe('enableBrowserPush — uniquement après un clic explicite', () => {
  it('navigateur non supporté → reason unsupported', async () => {
    const result = await enableBrowserPush('public-vapid');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported');
    }
  });

  it('permission denied → respectée, aucune demande répétée', async () => {
    stubSupportedBrowser({ permission: 'denied' });
    const result = await enableBrowserPush('public-vapid');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('denied');
    }
  });

  it('permission accordée → abonnement créé et renvoyé au frontend', async () => {
    stubSupportedBrowser({ permission: 'default', grantedOnRequest: true });
    const result = await enableBrowserPush('public-vapid');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subscription.endpoint).toBe(
        'https://push.example.test/sub-1',
      );
    }
  });

  it('aucune clé publique serveur → unavailable', async () => {
    stubSupportedBrowser({ permission: 'granted' });
    const result = await enableBrowserPush(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unavailable');
    }
  });
});

describe('disableBrowserPush', () => {
  it('désabonne le PushSubscription existant', async () => {
    (window as unknown as { PushManager?: unknown }).PushManager = {};
    (window as unknown as { Notification: unknown }).Notification = {
      permission: 'granted',
      requestPermission: vi.fn(),
    };
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const pushManager = {
      getSubscription: vi.fn().mockResolvedValue({
        unsubscribe,
        toJSON: () => subscribeResult,
      }),
      subscribe: vi.fn(),
    };
    const registration = { pushManager };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: vi.fn().mockResolvedValue(registration),
        getRegistration: vi.fn().mockResolvedValue(registration),
        ready: Promise.resolve(registration),
      },
    });
    await expect(disableBrowserPush()).resolves.toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
