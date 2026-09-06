import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationsBell } from './NotificationsBell';
import { apiGetNotifications } from '../auth/api';

/**
 * CLOCHE DE NOTIFICATIONS (étape 12) — badge du centre interne.
 * Le compteur vient exclusivement de l'API (isRead=false) — jamais d'un
 * calcul financier côté React.
 */

vi.mock('../auth/api', () => ({
  apiGetNotifications: vi.fn(),
}));

function renderBell() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NotificationsBell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NotificationsBell', () => {
  it('badge masqué quand il n’y a aucune notification non lue', async () => {
    vi.mocked(apiGetNotifications).mockResolvedValue({
      notifications: [],
      total: 0,
      page: 1,
      limit: 1,
      unreadCount: 0,
    });
    renderBell();
    await waitFor(() => expect(apiGetNotifications).toHaveBeenCalled());
    expect(screen.getByRole('link', { name: 'Notifications' })).toBeTruthy();
  });

  it('affiche le badge « 3 » + aria-label avec le compte quand non lues > 0', async () => {
    vi.mocked(apiGetNotifications).mockResolvedValue({
      notifications: [],
      total: 3,
      page: 1,
      limit: 1,
      unreadCount: 3,
    });
    renderBell();
    expect(
      await screen.findByRole('link', { name: 'Notifications : 3 non lues' }),
    ).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });
});
