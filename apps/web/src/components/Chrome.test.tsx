import { describe, expect, it, beforeEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../theme';
import { AuthProvider } from '../auth/AuthContext';
import { OnboardingProvider, OnboardingTour } from '../onboarding';
import Chrome from './chrome';
import {
  apiRefresh,
  apiGetNotifications,
  apiGetOnboarding,
  apiCompleteOnboarding,
} from '../auth/api';

vi.mock('../auth/api', () => ({
  apiRefresh: vi.fn(),
  apiLogin: vi.fn(),
  apiLogout: vi.fn(),
  apiRegister: vi.fn(),
  setAccessToken: vi.fn(),
  apiGetNotifications: vi.fn(),
  apiGetOnboarding: vi.fn(),
  apiCompleteOnboarding: vi.fn(),
}));

const USER = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'alice',
  email: 'alice@example.com',
};

function renderChrome() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <ThemeProvider>
          <AuthProvider>
            <OnboardingProvider>
              <Routes>
                <Route path="/" element={<Chrome />}>
                  <Route
                    index
                    element={
                      <div id="guide-total">
                        <h1>Tableau de bord</h1>
                      </div>
                    }
                  />
                </Route>
              </Routes>
              <OnboardingTour />
            </OnboardingProvider>
          </AuthProvider>
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiRefresh).mockResolvedValue(USER);
  vi.mocked(apiGetNotifications).mockResolvedValue({
    notifications: [],
    total: 0,
    page: 1,
    limit: 1,
    unreadCount: 0,
  });
  vi.mocked(apiGetOnboarding).mockResolvedValue({ completed: true });
  vi.mocked(apiCompleteOnboarding).mockResolvedValue({ completed: true });
});

describe('Chrome — ancres de la prise en main guidée', () => {
  it('expose « Relancer le guide » (relaunch-guide) dans le chrome', async () => {
    renderChrome();
    await screen.findByRole('heading', { name: 'Tableau de bord' });

    const relaunch = await screen.findAllByTestId('relaunch-guide');
    expect(relaunch.length).toBeGreaterThan(0);
  });

  it('pose les ancres data-guide attendues par le tour', async () => {
    const { container } = renderChrome();
    await screen.findByRole('heading', { name: 'Tableau de bord' });

    expect(container.querySelector('[data-guide="nav"]')).not.toBeNull();
    expect(container.querySelector('[data-guide="assistant"]')).not.toBeNull();
    expect(container.querySelector('[data-guide="bell"]')).not.toBeNull();
    expect(container.querySelector('[data-guide="plus"]')).not.toBeNull();
  });

  it('relancer le guide depuis le chrome ouvre le tour à l’accueil', async () => {
    const user = userEvent.setup();
    renderChrome();
    await screen.findByRole('heading', { name: 'Tableau de bord' });

    const relaunchButtons = await screen.findAllByTestId('relaunch-guide');
    await user.click(relaunchButtons[0]!);

    const dialog = await screen.findByRole('dialog', { name: /Total disponible/ });
    expect(dialog).toHaveTextContent('Étape 1 / 13');
  });
});
