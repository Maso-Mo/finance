import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../theme';
import { AuthProvider } from '../auth/AuthContext';
import BudgetsPage from './BudgetsPage';
import type {
  CategoriesResponse,
  CategoryBudgetLine,
  CategoryPublic,
  FinancialForecastResponse,
  GlobalBudgetLine,
  MonthlyBudgetsResponse,
} from '@finance/shared-types';
import {
  apiCreateBudget,
  apiDeleteBudget,
  apiGetBudgets,
  apiGetCategories,
  apiGetForecast,
  apiLogin,
  apiLogout,
  apiRefresh,
  apiRegister,
  apiUpdateBudget,
  setAccessToken,
} from '../auth/api';

vi.mock('../auth/api', () => ({
  apiRefresh: vi.fn(),
  apiLogin: vi.fn(),
  apiLogout: vi.fn(),
  apiRegister: vi.fn(),
  setAccessToken: vi.fn(),
  apiGetCategories: vi.fn(),
  apiGetBudgets: vi.fn(),
  apiGetForecast: vi.fn(),
  apiCreateBudget: vi.fn(),
  apiUpdateBudget: vi.fn(),
  apiDeleteBudget: vi.fn(),
}));

const USER = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'budget@example.com',
};

const RESTAURANT: CategoryPublic = {
  id: 'cat-restaurant',
  code: 'restaurant',
  name: 'Restaurant',
  isSystem: true,
};
const TRANSPORT: CategoryPublic = {
  id: 'cat-transport',
  code: 'transport',
  name: 'Transport',
  isSystem: true,
};
const CATEGORIES: CategoryPublic[] = [RESTAURANT, TRANSPORT];
const CATEGORIES_RESPONSE: CategoriesResponse = { categories: CATEGORIES };

const MONTHS_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

function monthLabel(key: string): string {
  const name = MONTHS_FR[(Number(key.slice(5, 7)) || 1) - 1];
  return `${name} ${key.slice(0, 4)}`;
}

function shift(key: string, offset: number): string {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  const total = y * 12 + (m - 1) + offset;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

function emptyOverview(month: string): MonthlyBudgetsResponse {
  return {
    month,
    today: '2026-09-10',
    currency: 'MGA',
    spent: '0',
    spendingForecast: '0',
    globalBudget: null,
    categoryBudgets: [],
  };
}

function emptyForecast(month: string): FinancialForecastResponse {
  return {
    month,
    today: `${month}-10`,
    currency: 'MGA',
    availableToday: '0',
    pendingPlannedExpensesTotal: '0',
    confirmedExpectedIncomeTotal: '0',
    uncertainIncomePotential: '0',
    monthEndAvailableForecast: '0',
  };
}

function forecastLine(
  over: Partial<FinancialForecastResponse>,
): FinancialForecastResponse {
  const month = over.month ?? '2026-09';
  return {
    ...emptyForecast(month),
    ...over,
  };
}

function globalLine(over: Partial<GlobalBudgetLine>): GlobalBudgetLine {
  return {
    id: 'budget-global',
    month: '2026-09',
    amount: '1000000',
    currency: 'MGA',
    remaining: '850000',
    status: 'VERT',
    spendingForecast: '450000',
    ...over,
  };
}

function categoryLine(over: Partial<CategoryBudgetLine>): CategoryBudgetLine {
  return {
    id: 'budget-restaurant',
    month: '2026-09',
    amount: '200000',
    currency: 'MGA',
    category: { id: RESTAURANT.id, name: RESTAURANT.name },
    spent: '150000',
    remaining: '50000',
    status: 'VERT',
    spendingForecast: '450000',
    ...over,
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/budgets']}>
        <ThemeProvider>
          <AuthProvider>
            <BudgetsPage />
          </AuthProvider>
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

let currentOverview: (month: string) => MonthlyBudgetsResponse = emptyOverview;
let currentForecast: (month: string) => FinancialForecastResponse = emptyForecast;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiRefresh).mockResolvedValue(USER);
  vi.mocked(apiGetCategories).mockResolvedValue(CATEGORIES_RESPONSE);
  currentOverview = emptyOverview;
  currentForecast = emptyForecast;
  vi.mocked(apiGetBudgets).mockImplementation(async (month: string) =>
    currentOverview(month),
  );
  vi.mocked(apiGetForecast).mockImplementation(async (today: string) =>
    currentForecast(today.slice(0, 7)),
  );
});

async function waitForData() {
  await screen.findByRole('heading', { name: 'Budgets' });
  await waitFor(() => expect(apiGetBudgets).toHaveBeenCalled());
}

async function waitForForecast() {
  await waitFor(() => expect(apiGetForecast).toHaveBeenCalled());
}

function firstMonth(): string {
  const calls = vi.mocked(apiGetBudgets).mock.calls;
  const call = calls[0];
  if (!call) {
    throw new Error('apiGetBudgets was not called before firstMonth().');
  }
  return call[0] as string;
}

describe('BudgetsPage — budgets mensuels', () => {
  it('affiche le titre et les états vides (ni budget global, ni budget catégorie)', async () => {
    renderPage();
    await waitForData();
    expect(screen.getByText('Budgets')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Définir un budget global' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Aucun budget par catégorie pour ce mois. Choisissez « Ajouter un budget par catégorie » pour limiter une catégorie de dépenses.',
      ),
    ).toBeTruthy();
  });

  it('permet de naviguer entre les mois (‹ / ›) → rechargement du bon mois', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForData();
    const initial = firstMonth();
    const next = shift(initial, 1);
    await user.click(screen.getByRole('button', { name: 'Mois suivant' }));
    await waitFor(() => {
      const calls = vi.mocked(apiGetBudgets).mock.calls;
      expect(calls.some((call) => call[0] === next)).toBe(true);
    });
    expect(screen.getByText(monthLabel(next))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Mois précédent' }));
    await waitFor(() => {
      const calls = vi.mocked(apiGetBudgets).mock.calls;
      expect(calls.some((call) => call[0] === initial)).toBe(true);
    });
  });

  it('budget RESTAURANT VERT : budget / dépensé / restant / prévision en texte', async () => {
    const month = '2026-09';
    currentOverview = () => ({
      ...emptyOverview(month),
      spent: '150000',
      spendingForecast: '450000',
      categoryBudgets: [categoryLine({ month })],
    });
    renderPage();
    await waitForData();
    expect(screen.getByText('Restaurant')).toBeTruthy();
    expect(screen.getAllByText('Vert')).toHaveLength(1);
    expect(screen.getAllByText('150 000 Ar').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('200 000 Ar')).toBeTruthy();
    expect(screen.getByText('50 000 Ar')).toBeTruthy();
    expect(screen.getAllByText('450 000 Ar').length).toBeGreaterThanOrEqual(1);
  });

  it('budget DÉPASSÉ : restant négatif et badge textuel « Dépassé »', async () => {
    const month = '2026-09';
    currentOverview = () => ({
      ...emptyOverview(month),
      spent: '230000',
      spendingForecast: '300000',
      categoryBudgets: [
        categoryLine({
          month,
          spent: '230000',
          remaining: '-30000',
          status: 'DEPASSE',
        }),
      ],
    });
    renderPage();
    await waitForData();
    expect(screen.getAllByText('Dépassé')).toHaveLength(1);
    expect(screen.getAllByText('-30 000 Ar').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('300 000 Ar').length).toBeGreaterThanOrEqual(1);
  });

  it('budget GLOBAL Vert : bloc Budget / Dépensé / Restant / Prévision / badge', async () => {
    const month = '2026-09';
    currentOverview = () => ({
      ...emptyOverview(month),
      spent: '150000',
      spendingForecast: '450000',
      globalBudget: globalLine({ month }),
    });
    renderPage();
    await waitForData();
    const heading = screen.getByRole('heading', { name: 'Budget global' });
    const block = heading.closest('section') as HTMLElement;
    expect(within(block).getByText('1 000 000 Ar')).toBeTruthy();
    expect(within(block).getByText('Vert')).toBeTruthy();
    expect(within(block).getByText('850 000 Ar')).toBeTruthy();
    expect(within(block).getByText('450 000 Ar')).toBeTruthy();
  });

  it('ajout d’un budget GLOBAL via le formulaire', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForData();
    const initial = firstMonth();
    await user.click(
      screen.getByRole('button', { name: 'Définir un budget global' }),
    );
    await user.type(
      screen.getByLabelText('Montant du budget global'),
      '1000000',
    );
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() =>
      expect(apiCreateBudget).toHaveBeenCalledWith({
        month: initial,
        amount: '1000000',
      }),
    );
  });

  it('ajout d’un budget par CATÉGORIE (choix + montant)', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForData();
    const initial = firstMonth();
    await user.click(
      screen.getByRole('button', { name: 'Ajouter un budget par catégorie' }),
    );
    await user.selectOptions(
      screen.getByLabelText('Catégorie'),
      TRANSPORT.id,
    );
    await user.type(
      screen.getByLabelText('Montant du budget catégorie'),
      '150000',
    );
    await user.click(screen.getByRole('button', { name: 'Créer le budget' }));
    await waitFor(() =>
      expect(apiCreateBudget).toHaveBeenCalledWith({
        month: initial,
        categoryId: TRANSPORT.id,
        amount: '150000',
      }),
    );
  });

  it('modification du montant du budget GLOBAL', async () => {
    const user = userEvent.setup();
    const month = '2026-09';
    currentOverview = () => ({
      ...emptyOverview(month),
      spent: '150000',
      spendingForecast: '450000',
      globalBudget: globalLine({ month }),
    });
    renderPage();
    await waitForData();
    await user.click(screen.getByRole('button', { name: 'Modifier' }));
    const input = screen.getByLabelText('Montant du budget global');
    await user.clear(input);
    await user.type(input, '1200000');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() =>
      expect(apiUpdateBudget).toHaveBeenCalledWith('budget-global', '1200000'),
    );
  });

  it('modification du montant d’un budget catégorie', async () => {
    const user = userEvent.setup();
    const month = '2026-09';
    currentOverview = () => ({
      ...emptyOverview(month),
      spent: '150000',
      spendingForecast: '450000',
      categoryBudgets: [categoryLine({ month })],
    });
    renderPage();
    await waitForData();
    const row = screen.getByText('Restaurant').closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Modifier' }));
    const input = screen.getByLabelText('Montant du budget Restaurant');
    await user.clear(input);
    await user.type(input, '220000');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() =>
      expect(apiUpdateBudget).toHaveBeenCalledWith(
        'budget-restaurant',
        '220000',
      ),
    );
  });

  it('suppression : confirmation demandée, « Annuler » ne supprime rien', async () => {
    const user = userEvent.setup();
    const month = '2026-09';
    currentOverview = () => ({
      ...emptyOverview(month),
      spent: '150000',
      spendingForecast: '450000',
      categoryBudgets: [categoryLine({ month })],
    });
    renderPage();
    await waitForData();
    const row = screen.getByText('Restaurant').closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Supprimer' }));
    expect(
      screen.getByText('Supprimer le budget Restaurant ?'),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(() =>
      expect(screen.queryByText('Supprimer le budget Restaurant ?')).toBeNull(),
    );
    expect(apiDeleteBudget).not.toHaveBeenCalled();
  });

  it('suppression : « Oui, supprimer » appelle bien le DELETE', async () => {
    const user = userEvent.setup();
    const month = '2026-09';
    currentOverview = () => ({
      ...emptyOverview(month),
      spent: '0',
      spendingForecast: '0',
      globalBudget: globalLine({ month, remaining: '1000000' }),
    });
    renderPage();
    await waitForData();
    await user.click(screen.getByRole('button', { name: 'Supprimer' }));
    expect(screen.getByText('Supprimer le budget global ?')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Oui, supprimer' }));
    await waitFor(() =>
      expect(apiDeleteBudget).toHaveBeenCalledWith('budget-global'),
    );
  });

  it('affiche le message d’erreur renvoyé par l’API (ex. doublon)', async () => {
    const user = userEvent.setup();
    vi.mocked(apiCreateBudget).mockRejectedValue(
      new Error('A global budget already exists for this month.'),
    );
    renderPage();
    await waitForData();
    await user.click(
      screen.getByRole('button', { name: 'Définir un budget global' }),
    );
    await user.type(
      screen.getByLabelText('Montant du budget global'),
      '1000000',
    );
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(
      await screen.findByText('A global budget already exists for this month.'),
    ).toBeTruthy();
  });

  it('budget global DÉPASSÉ : badge « Dépassé » et restant négatif', async () => {
    const month = '2026-09';
    currentOverview = () => ({
      ...emptyOverview(month),
      spent: '1200000',
      spendingForecast: '1500000',
      globalBudget: globalLine({
        month,
        remaining: '-200000',
        status: 'DEPASSE',
        spendingForecast: '1500000',
      }),
    });
    renderPage();
    await waitForData();
    const heading = screen.getByRole('heading', { name: 'Budget global' });
    const block = heading.closest('section') as HTMLElement;
    expect(within(block).getByText('Dépassé')).toBeTruthy();
    expect(within(block).getByText('-200 000 Ar')).toBeTruthy();
    expect(within(block).getByText('1 500 000 Ar')).toBeTruthy();
  });
});

describe('BudgetsPage — prévision financière de fin de mois (mois courant)', () => {
  const month = '2026-09';

  it('mois courant : disponible aujourd’hui, dépenses prévues, revenus confirmés, prévision, incertains séparés', async () => {
    currentOverview = () => emptyOverview(month);
    currentForecast = () =>
      forecastLine({
        month,
        availableToday: '500000',
        pendingPlannedExpensesTotal: '200000',
        confirmedExpectedIncomeTotal: '300000',
        uncertainIncomePotential: '1000000',
        monthEndAvailableForecast: '600000',
      });
    renderPage();
    await waitForData();
    await waitForForecast();

    expect(screen.getByText('Disponible aujourd’hui')).toBeTruthy();
    expect(screen.getByText('500 000 Ar')).toBeTruthy();
    expect(screen.getByText('Dépenses prévues restantes')).toBeTruthy();
    expect(screen.getByText('-200 000 Ar')).toBeTruthy();
    expect(screen.getByText('Revenus confirmés attendus')).toBeTruthy();
    expect(screen.getByText('+300 000 Ar')).toBeTruthy();
    expect(screen.getByText('Prévision fin de mois')).toBeTruthy();
    // La prévision reste 600 000 Ar : les revenus incertains (1 M) ne sont
    // JAMAIS inclus dans le résultat principal.
    expect(screen.getByText('600 000 Ar')).toBeTruthy();
    expect(
      screen.getByText(
        /Revenus incertains : \+1 000 000 Ar — Non inclus dans la prévision/,
      ),
    ).toBeTruthy();
  });

  it('prévision NÉGATIVE affichée proprement (jamais clampée à zéro)', async () => {
    currentOverview = () => emptyOverview(month);
    currentForecast = () =>
      forecastLine({
        month,
        availableToday: '100000',
        pendingPlannedExpensesTotal: '300000',
        confirmedExpectedIncomeTotal: '0',
        uncertainIncomePotential: '0',
        monthEndAvailableForecast: '-200000',
      });
    renderPage();
    await waitForData();
    await waitForForecast();
    expect(screen.getByText('Prévision fin de mois')).toBeTruthy();
    expect(screen.getByText('-200 000 Ar')).toBeTruthy();
  });

  it('libellé « Prévision de dépenses » distinct de « Prévision fin de mois »', async () => {
    currentOverview = () => ({
      ...emptyOverview(month),
      spent: '150000',
      spendingForecast: '450000',
      globalBudget: globalLine({
        month,
        remaining: '850000',
        spendingForecast: '450000',
      }),
    });
    currentForecast = () =>
      forecastLine({
        month,
        availableToday: '500000',
        pendingPlannedExpensesTotal: '0',
        confirmedExpectedIncomeTotal: '0',
        monthEndAvailableForecast: '500000',
      });
    renderPage();
    await waitForData();
    await waitForForecast();
    expect(
      screen.getAllByText('Prévision de dépenses').length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Prévision fin de mois')).toHaveLength(1);
  });

  it('navigation vers un AUTRE mois : la prévision financière disparaît (mois courant uniquement)', async () => {
    const user = userEvent.setup();
    currentOverview = () => emptyOverview(month);
    currentForecast = () => forecastLine({ month });
    renderPage();
    await waitForData();
    await waitForForecast();
    expect(
      screen.getByRole('heading', { name: 'Prévision financière de fin de mois' }),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Mois suivant' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', {
          name: 'Prévision financière de fin de mois',
        }),
      ).toBeNull(),
    );
  });
});

