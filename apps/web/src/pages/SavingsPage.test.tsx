import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../theme';
import { AuthProvider } from '../auth/AuthContext';
import SavingsPage from './SavingsPage';
import type {
  AccountPublic,
  DashboardResponse,
  SavingsContributionPublic,
  SavingsMonthView,
  SavingsPlanPublic,
  TransferPublic,
} from '@finance/shared-types';
import {
  apiAddSavingsContribution,
  apiCreateSavingsPlan,
  apiDeleteSavingsPlan,
  apiGetAccounts,
  apiGetNotifications,
  apiGetSavingsMonth,
  apiRefresh,
  apiUpdateSavingsPlan,
} from '../auth/api';

vi.mock('../auth/api', () => ({
  apiRefresh: vi.fn(),
  apiLogin: vi.fn(),
  apiLogout: vi.fn(),
  apiRegister: vi.fn(),
  setAccessToken: vi.fn(),
  apiGetAccounts: vi.fn(),
  apiGetNotifications: vi.fn(),
  apiGetSavingsMonth: vi.fn(),
  apiCreateSavingsPlan: vi.fn(),
  apiUpdateSavingsPlan: vi.fn(),
  apiDeleteSavingsPlan: vi.fn(),
  apiAddSavingsContribution: vi.fn(),
}));

const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'a@example.com' };
const CURRENT_MONTH = new Date().toISOString().slice(0, 7);

const CASH: AccountPublic = {
  id: '00000000-0000-4000-8000-000000000101', type: 'CASH', currency: 'MGA',
  initialBalance: '0', balance: '500000',
};
const MVOLA: AccountPublic = {
  id: '00000000-0000-4000-8000-000000000102', type: 'MVOLA', currency: 'MGA',
  initialBalance: '0', balance: '300000',
};
const SAVINGS: AccountPublic = {
  id: '00000000-0000-4000-8000-000000000103', type: 'SAVINGS', currency: 'MGA',
  initialBalance: '0', balance: '500000',
};
const ACCOUNTS: AccountPublic[] = [CASH, MVOLA, SAVINGS];
const DASHBOARD: DashboardResponse = {
  currency: 'MGA', accounts: ACCOUNTS, totalAvailable: '800000',
};

function planOf(overrides: Partial<SavingsPlanPublic>): SavingsPlanPublic {
  return {
    id: '00000000-0000-4000-8000-000000000201',
    month: CURRENT_MONTH,
    mode: 'FIXED',
    fixedAmount: '100000',
    percentage: null,
    currency: 'MGA',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function transferOf(overrides: Partial<TransferPublic> = {}): TransferPublic {
  return {
    id: '00000000-0000-4000-8000-000000000301',
    source: { id: CASH.id, type: 'CASH' },
    destination: { id: SAVINGS.id, type: 'SAVINGS' },
    amount: '40000',
    feeAmount: '1000',
    currency: 'MGA',
    occurredAt: '2026-09-06',
    dateUnknown: false,
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function contributionOf(overrides: Partial<SavingsContributionPublic> = {}): SavingsContributionPublic {
  return {
    id: '00000000-0000-4000-8000-000000000401',
    transfer: transferOf(),
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function viewOf(overrides: Partial<SavingsMonthView>): SavingsMonthView {
  return {
    month: CURRENT_MONTH,
    currency: 'MGA',
    savingsAccount: { id: SAVINGS.id, balance: '500000' },
    plan: null,
    target: null,
    eligibleIncome: null,
    contributed: null,
    remaining: null,
    progress: null,
    contributions: [],
    ...overrides,
  };
}

const VIEW_FIXED = viewOf({
  plan: planOf({}),
  target: '100000',
  eligibleIncome: null,
  contributed: '100000',
  remaining: '0',
  progress: 'REACHED',
  contributions: [contributionOf()],
});
const VIEW_NO_INCOME = viewOf({
  plan: planOf({ mode: 'PERCENTAGE', fixedAmount: null, percentage: '20' }),
  target: '0',
  eligibleIncome: '0',
  contributed: '0',
  remaining: '0',
  progress: 'NO_INCOME_YET',
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/savings']}>
        <ThemeProvider>
          <AuthProvider>
            <SavingsPage />
          </AuthProvider>
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiRefresh).mockResolvedValue(USER);
  vi.mocked(apiGetNotifications).mockResolvedValue({ notifications: [], total: 0, page: 1, limit: 1, unreadCount: 0 });
  vi.mocked(apiGetAccounts).mockResolvedValue(DASHBOARD);
  vi.mocked(apiGetSavingsMonth).mockResolvedValue(viewOf({}));
});

async function waitPage() {
  await screen.findByRole('heading', { name: 'Épargne' });
  // Attendre la fin du premier chargement des requêtes (données du mois).
  await waitFor(() => expect(screen.queryByText('Chargement…')).toBeNull());
}

describe('SavingsPage — solde réel et progression distincts', () => {
  it('affiche le solde réel de l’Épargne et la progression du plan', async () => {
    vi.mocked(apiGetSavingsMonth).mockResolvedValue(VIEW_FIXED);
    renderPage();
    await waitPage();

    // Solde RÉEL du compte Épargne (500 000 Ar)…
    expect(screen.getByText('Épargne réelle')).toBeTruthy();
    expect(screen.getByText('500 000 Ar')).toBeTruthy();
    // …distinct de la contribution du mois (100 000 Ar) — ici = l’objectif.
    expect(screen.getByText('Déjà épargné')).toBeTruthy();
    expect(screen.getAllByText('100 000 Ar').length).toBeGreaterThan(0);
    expect(screen.getByText('Reste')).toBeTruthy();
    expect(screen.getByText('0 Ar')).toBeTruthy();
    expect(screen.getByText('Objectif atteint')).toBeTruthy();
    // Historique : contribution unique (CASH → Épargne, frais affichés).
    expect(screen.getByText('Cash → Épargne')).toBeTruthy();
    expect(screen.getByText('40 000 Ar')).toBeTruthy();
    expect(screen.getByText('Frais : 1 000 Ar')).toBeTruthy();
  });

  it('PERCENTAGE sans revenus reçus → attente affichée, pas « objectif atteint »', async () => {
    vi.mocked(apiGetSavingsMonth).mockResolvedValue(VIEW_NO_INCOME);
    renderPage();
    await waitPage();

    expect(screen.getByText('En attente de revenus')).toBeTruthy();
    expect(
      screen.getByText(/En attente de revenus reçus ce mois-ci/i),
    ).toBeTruthy();
  });

  it('sans objectif, propose « Définir un objectif du mois »', async () => {
    renderPage();
    await waitPage();
    expect(
      screen.getByRole('button', { name: 'Définir un objectif du mois' }),
    ).toBeTruthy();
  });
});

describe('SavingsPage — définir / modifier un objectif', () => {
  it('crée un plan FIXED avec confirmation', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitPage();

    await user.click(
      screen.getByRole('button', { name: 'Définir un objectif du mois' }),
    );
    await user.type(
      screen.getByLabelText('Objectif du mois (montant fixe)'),
      '100000',
    );
    await user.click(screen.getByRole('button', { name: 'Vérifier' }));

    expect(screen.getByText('Confirmer cet objectif ?')).toBeTruthy();
    expect(screen.getByText('100 000 Ar')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Confirmer' }));

    expect(apiCreateSavingsPlan).toHaveBeenCalledWith({
      month: CURRENT_MONTH,
      mode: 'FIXED',
      fixedAmount: '100000',
    });
  });

  it('crée un plan PERCENTAGE et affiche l’aide « revenus réellement reçus »', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitPage();

    await user.click(
      screen.getByRole('button', { name: 'Définir un objectif du mois' }),
    );
    await user.click(
      screen.getByRole('radio', { name: /Pourcentage des revenus reçus/i }),
    );
    expect(
      screen.getByText(/L’objectif évoluera en fonction des revenus réellement/i),
    ).toBeTruthy();
    await user.type(
      screen.getByLabelText('Pourcentage à épargner'),
      '20',
    );
    await user.click(screen.getByRole('button', { name: 'Vérifier' }));
    expect(screen.getByText('20 %')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Confirmer' }));

    expect(apiCreateSavingsPlan).toHaveBeenCalledWith({
      month: CURRENT_MONTH,
      mode: 'PERCENTAGE',
      percentage: '20',
    });
  });

  it('modifie un plan existant', async () => {
    const user = userEvent.setup();
    vi.mocked(apiGetSavingsMonth).mockResolvedValue(VIEW_FIXED);
    renderPage();
    await waitPage();

    await user.click(
      screen.getByRole('button', { name: 'Modifier l’objectif' }),
    );
    await user.clear(screen.getByLabelText('Objectif du mois (montant fixe)'));
    await user.type(
      screen.getByLabelText('Objectif du mois (montant fixe)'),
      '60000',
    );
    await user.click(screen.getByRole('button', { name: 'Vérifier' }));
    await user.click(screen.getByRole('button', { name: 'Confirmer' }));

    expect(apiUpdateSavingsPlan).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000201',
      { month: CURRENT_MONTH, mode: 'FIXED', fixedAmount: '60000' },
    );
  });
});

describe('SavingsPage — contribution « J’ai épargné »', () => {
  it('prévisualise débit / crédit / contribution puis confirme', async () => {
    const user = userEvent.setup();
    vi.mocked(apiGetSavingsMonth).mockResolvedValue(VIEW_FIXED);
    renderPage();
    await waitPage();

    await user.click(screen.getByRole('button', { name: 'J’ai épargné' }));

    await user.selectOptions(
      screen.getByLabelText("Compte d'origine"),
      MVOLA.id,
    );
    await user.type(
      screen.getByLabelText('Montant crédité sur Épargne'),
      '40000',
    );
    await user.click(
      screen.getByRole('checkbox', {
        name: /Frais prélevés en plus sur le compte d'origine/i,
      }),
    );
    await user.type(screen.getByLabelText('Montant des frais'), '1000');
    fireEvent.change(screen.getByLabelText('Date réelle du transfert'), {
      target: { value: '2026-09-06' },
    });

    // Débit = montant + frais ; crédit et contribution = montant seul.
    expect(screen.getByText('Débité de MVola')).toBeTruthy();
    expect(screen.getByText('41 000 Ar')).toBeTruthy();
    expect(screen.getAllByText('Contribution à l’objectif').length).toBeGreaterThan(0);
    expect(screen.getAllByText('40 000 Ar').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Vérifier' }));
    expect(screen.getByText('Confirmer cette contribution ?')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Confirmer' }));

    await waitFor(() =>
      expect(apiAddSavingsContribution).toHaveBeenCalledWith(
        '00000000-0000-4000-8000-000000000201',
        {
          sourceAccountId: MVOLA.id,
          amount: '40000',
          feeAmount: '1000',
          occurredAt: '2026-09-06',
        },
      ),
    );
  });

  it('date réellement inconnue acceptée (case « je ne sais plus »)', async () => {
    const user = userEvent.setup();
    vi.mocked(apiGetSavingsMonth).mockResolvedValue(VIEW_FIXED);
    renderPage();
    await waitPage();

    await user.click(screen.getByRole('button', { name: 'J’ai épargné' }));
    await user.selectOptions(screen.getByLabelText("Compte d'origine"), CASH.id);
    await user.type(screen.getByLabelText('Montant crédité sur Épargne'), '25000');
    await user.click(
      screen.getByRole('checkbox', { name: /Je ne sais plus \(date\)/i }),
    );
    await user.click(screen.getByRole('button', { name: 'Vérifier' }));
    await user.click(screen.getByRole('button', { name: 'Confirmer' }));

    await waitFor(() =>
      expect(apiAddSavingsContribution).toHaveBeenCalledWith(
        '00000000-0000-4000-8000-000000000201',
        {
          sourceAccountId: CASH.id,
          amount: '25000',
          feeAmount: '0',
          dateUnknown: true,
        },
      ),
    );
  });
});

describe('SavingsPage — suppression d’un objectif', () => {
  it('demande confirmation puis supprime logiquement le plan', async () => {
    const user = userEvent.setup();
    vi.mocked(apiGetSavingsMonth).mockResolvedValue(VIEW_FIXED);
    renderPage();
    await waitPage();

    await user.click(
      screen.getByRole('button', { name: 'Supprimer l’objectif' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Supprimer cet objectif ?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Supprimer' }));

    await waitFor(() =>
      expect(apiDeleteSavingsPlan).toHaveBeenCalledWith(
        '00000000-0000-4000-8000-000000000201',
      ),
    );
  });
});
