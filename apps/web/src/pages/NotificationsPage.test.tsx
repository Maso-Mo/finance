import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../theme';
import { AuthProvider } from '../auth/AuthContext';
import NotificationsPage from './NotificationsPage';
import type { AppNotificationPublic } from '@finance/shared-types';
import {
  apiCreatePushSubscription,
  apiDeletePushSubscription,
  apiGetNotificationPreferences,
  apiGetNotifications,
  apiGetPushConfig,
  apiGetPushSubscriptions,
  apiMarkNotificationRead,
  apiReadAllNotifications,
  apiRefresh,
  apiUpdateNotificationPreferences,
} from '../auth/api';
import {
  currentPushStatus,
  disableBrowserPush,
  enableBrowserPush,
  isBrowserPushSupported,
  subscriptionToPayload,
} from '../lib/push';

/**
 * PAGE NOTIFICATIONS (étape 12) — centre interne + paramètres Web Push.
 *
 * jsdom ne valide PAS un vrai Web Push système : le module navigateur
 * (../lib/push) est MOCKÉ ici. On vérifie : état vide, lu / read-all,
 * navigation du clic (aucune action financière), fuseau horaire, montants
 * push, activation/désactivation explicites, navigateur incompatible.
 */

vi.mock('../auth/api', () => ({
  apiRefresh: vi.fn(),
  apiLogin: vi.fn(),
  apiLogout: vi.fn(),
  apiRegister: vi.fn(),
  setAccessToken: vi.fn(),
  apiGetNotificationPreferences: vi.fn(),
  apiGetNotifications: vi.fn(),
  apiGetPushConfig: vi.fn(),
  apiGetPushSubscriptions: vi.fn(),
  apiUpdateNotificationPreferences: vi.fn(),
  apiMarkNotificationRead: vi.fn(),
  apiReadAllNotifications: vi.fn(),
  apiCreatePushSubscription: vi.fn(),
  apiDeletePushSubscription: vi.fn(),
}));

vi.mock('../lib/push', () => ({
  enableBrowserPush: vi.fn(),
  disableBrowserPush: vi.fn(),
  isBrowserPushSupported: vi.fn(),
  currentPushStatus: vi.fn(),
  subscriptionToPayload: vi.fn(),
}));

const USER = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'notif@example.com',
};

const EMPTY_LIST = {
  notifications: [] as AppNotificationPublic[],
  total: 0,
  page: 1,
  limit: 20,
  unreadCount: 0,
};

function notificationOf(
  over: Partial<AppNotificationPublic>,
): AppNotificationPublic {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    type: 'PLANNED_EXPENSE_DUE',
    sourceType: 'PLANNED_EXPENSE',
    sourceId: '00000000-0000-4000-8000-0000000000bb',
    localDate: '2026-09-20',
    title: 'Paiement à vérifier',
    body: 'Dépense prévue le 20 sept. 2026 : 50 000 Ar.',
    route: '/planned',
    isRead: false,
    readAt: null,
    createdAt: '2026-09-20T09:00:00.000Z',
    ...over,
  };
}

function renderPage(route = '/notifications') {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <ThemeProvider>
          <AuthProvider>
            <Routes>
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route path="/planned" element={<div>Page dépenses prévues</div>} />
            </Routes>
          </AuthProvider>
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiRefresh).mockResolvedValue(USER);
  vi.mocked(apiGetNotificationPreferences).mockResolvedValue({
    timezone: null,
    browserPushEnabled: false,
    showAmountsInPush: false,
    localTime: '09:00',
  });
  vi.mocked(apiGetNotifications).mockResolvedValue(EMPTY_LIST);
  vi.mocked(apiGetPushConfig).mockResolvedValue({
    pushAvailable: true,
    publicKey: 'public-vapid-test',
  });
  vi.mocked(apiGetPushSubscriptions).mockResolvedValue({ subscriptions: [] });
  vi.mocked(apiUpdateNotificationPreferences).mockResolvedValue({
    timezone: 'UTC',
    browserPushEnabled: false,
    showAmountsInPush: false,
    localTime: '09:00',
  });
  vi.mocked(apiMarkNotificationRead).mockResolvedValue({
    notification: notificationOf({
      isRead: true,
      readAt: '2026-09-20T09:05:00.000Z',
    }),
  });
  vi.mocked(apiReadAllNotifications).mockResolvedValue({ updated: 0 });
  vi.mocked(apiCreatePushSubscription).mockResolvedValue({
    subscription: {
      id: 'sub-1',
      createdAt: '2026-09-20T09:00:00.000Z',
      disabledAt: null,
    },
  });
  vi.mocked(apiDeletePushSubscription).mockResolvedValue(undefined);

  vi.mocked(isBrowserPushSupported).mockReturnValue(true);
  vi.mocked(currentPushStatus).mockReturnValue({
    supported: true,
    permission: 'granted',
    enabled: true,
  });
  vi.mocked(enableBrowserPush).mockResolvedValue({
    ok: true,
    subscription: {
      endpoint: 'https://push.example.test/sub-1',
      keys: { p256dh: 'k-p256dh', auth: 'k-auth' },
    },
  });
  vi.mocked(disableBrowserPush).mockResolvedValue(true);
  vi.mocked(subscriptionToPayload).mockImplementation((subscription) => ({
    endpoint: subscription.endpoint ?? '',
    p256dh: subscription.keys?.p256dh ?? '',
    auth: subscription.keys?.auth ?? '',
  }));
});

async function waitReady() {
  await screen.findByRole('heading', { name: 'Notifications' });
}

describe('NotificationsPage — centre interne', () => {
  it('état vide : « Aucune notification pour le moment. »', async () => {
    renderPage();
    await waitReady();
    expect(screen.getByText('Aucune notification pour le moment.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Paramètres' })).toBeTruthy();
  });

  it('liste non-lues : badge, mark read unitaire, read-all', async () => {
    vi.mocked(apiGetNotifications).mockResolvedValue({
      ...EMPTY_LIST,
      notifications: [
        notificationOf({ id: 'note-1' }),
        notificationOf({ id: 'note-2', title: 'Paiement en retard' }),
      ],
      total: 2,
      unreadCount: 2,
    });
    renderPage();
    await waitReady();
    expect((await screen.findAllByText('Non lue')).length).toBe(2);

    const markButtons = screen.getAllByRole('button', {
      name: 'Marquer comme lu',
    });
    expect(markButtons).toHaveLength(2);
    await userEvent.click(markButtons[0] as HTMLButtonElement);
    await waitFor(() =>
      expect(vi.mocked(apiMarkNotificationRead).mock.calls[0]?.[0]).toBe(
        'note-1',
      ),
    );

    await userEvent.click(
      screen.getByRole('button', { name: 'Tout marquer comme lu' }),
    );
    await waitFor(() => expect(apiReadAllNotifications).toHaveBeenCalled());
  });

  it('clic « Ouvrir » : navigue vers la route, marque lu — aucune écriture financière', async () => {
    vi.mocked(apiGetNotifications).mockResolvedValue({
      ...EMPTY_LIST,
      notifications: [notificationOf({ id: 'note-1' })],
      total: 1,
      unreadCount: 1,
    });
    renderPage();
    await waitReady();
    await userEvent.click(
      await screen.findByRole('link', { name: /Ouvrir Paiement à vérifier/ }),
    );
    expect(await screen.findByText('Page dépenses prévues')).toBeTruthy();
    await waitFor(() =>
      expect(vi.mocked(apiMarkNotificationRead).mock.calls[0]?.[0]).toBe(
        'note-1',
      ),
    );
  });
});

describe('NotificationsPage — paramètres', () => {
  it('fuseau horaire : valeur détectée pré-remplie + enregistrement', async () => {
    renderPage();
    await waitReady();
    const input = screen.getByLabelText('Fuseau horaire') as HTMLInputElement;
    const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(input.value).toBe(detectedTz);
    await userEvent.clear(input);
    await userEvent.type(input, 'Indian/Antananarivo');
    await userEvent.click(
      screen.getByRole('button', { name: 'Enregistrer le fuseau' }),
    );
    await waitFor(() =>
      expect(apiUpdateNotificationPreferences).toHaveBeenCalledWith({
        timezone: 'Indian/Antananarivo',
      }),
    );
  });

  it('montants push : la case appelle la préférence showAmountsInPush', async () => {
    renderPage();
    await waitReady();
    await userEvent.click(
      screen.getByRole('checkbox', {
        name: 'Afficher les montants dans les notifications navigateur',
      }),
    );
    await waitFor(() =>
      expect(apiUpdateNotificationPreferences).toHaveBeenCalledWith({
        showAmountsInPush: true,
      }),
    );
  });

  it('activation EXPLICITE : enable → POST subscription → browserPushEnabled true', async () => {
    renderPage();
    await waitReady();
    await userEvent.click(screen.getByRole('button', { name: 'Activer' }));

    await waitFor(() =>
      expect(enableBrowserPush).toHaveBeenCalledWith('public-vapid-test'),
    );
    await waitFor(() => expect(apiCreatePushSubscription).toHaveBeenCalled());
    await waitFor(() =>
      expect(apiUpdateNotificationPreferences).toHaveBeenCalledWith(
        expect.objectContaining({ browserPushEnabled: true }),
      ),
    );
  });

  it('désactivation : unsubscribe + DELETE backend + browserPushEnabled false', async () => {
    vi.mocked(apiGetNotificationPreferences).mockResolvedValue({
      timezone: 'UTC',
      browserPushEnabled: true,
      showAmountsInPush: false,
      localTime: '09:00',
    });
    vi.mocked(apiGetPushSubscriptions).mockResolvedValue({
      subscriptions: [
        { id: 'sub-1', createdAt: '2026-09-20T09:00:00.000Z', disabledAt: null },
      ],
    });
    renderPage();
    await waitReady();
    await userEvent.click(screen.getByRole('button', { name: 'Désactiver' }));
    await waitFor(() => expect(disableBrowserPush).toHaveBeenCalled());
    await waitFor(() =>
      expect(apiDeletePushSubscription).toHaveBeenCalledWith('sub-1'),
    );
    await waitFor(() =>
      expect(apiUpdateNotificationPreferences).toHaveBeenCalledWith(
        expect.objectContaining({ browserPushEnabled: false }),
      ),
    );
  });

  it('navigateur incompatible → « Non disponible », centre interne toujours là', async () => {
    vi.mocked(isBrowserPushSupported).mockReturnValue(false);
    vi.mocked(currentPushStatus).mockReturnValue({
      supported: false,
      permission: 'denied',
      enabled: false,
    });
    renderPage();
    await waitReady();
    expect(screen.getByText('Non disponible')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Activer' })).toBeNull();
    expect(
      screen.getByText('Aucune notification pour le moment.'),
    ).toBeTruthy();
  });

  it('permission refusée → message respectueux, pas de demande automatique', async () => {
    vi.mocked(currentPushStatus).mockReturnValue({
      supported: true,
      permission: 'denied',
      enabled: false,
    });
    vi.mocked(apiGetNotificationPreferences).mockResolvedValue({
      timezone: 'UTC',
      browserPushEnabled: false,
      showAmountsInPush: false,
      localTime: '09:00',
    });
    renderPage();
    await waitReady();
    expect(screen.getByText(/Refusées par ce navigateur/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Activer' })).toBeNull();
    expect(enableBrowserPush).not.toHaveBeenCalled();
  });
});


