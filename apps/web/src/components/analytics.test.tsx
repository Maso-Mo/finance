import { describe, expect, it, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AnalyticsOverviewResponse } from '@finance/shared-types';
import { AnalyticsSection } from './analytics';
import { apiGetAnalyticsOverview } from '../auth/api';

vi.mock('../auth/api', () => ({
  apiGetAnalyticsOverview: vi.fn(),
}));

const mockedGet = vi.mocked(apiGetAnalyticsOverview);

function makeOverview(): AnalyticsOverviewResponse {
  return {
    currency: 'MGA',
    currentMonth: '2026-06',
    monthlyCashflow: [
      { month: '2026-01', income: '100000', expense: '45000' },
      { month: '2026-02', income: '120000', expense: '30000' },
      { month: '2026-03', income: '90000', expense: '70000' },
      { month: '2026-04', income: '140000', expense: '50000' },
      { month: '2026-05', income: '110000', expense: '60000' },
      { month: '2026-06', income: '130000', expense: '24000' },
    ],
    currentMonthExpenseCategories: [
      { categoryId: 'c-food', label: 'Alimentation', amount: '14400', share: 0.6 },
      { categoryId: 'c-transport', label: 'Transport', amount: '9600', share: 0.4 },
    ],
  };
}

function renderSection(today = '2026-06-15') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AnalyticsSection currency="MGA" today={today} />
    </QueryClientProvider>,
  );
}

describe('AnalyticsSection — lecture seule du tableau de bord', () => {
  beforeEach(() => {
    mockedGet.mockReset();
  });

  it('affiche le graphique mensuel et la ventilation par catégorie', async () => {
    mockedGet.mockResolvedValue(makeOverview());
    renderSection();

    // Titres + pastille « Lecture seule ».
    expect(screen.getByText('Analyser mes finances')).toBeInTheDocument();
    expect(screen.getByText('Lecture seule')).toBeInTheDocument();

    // Barres cliquables : une par mois, avec étiquette accessible complète.
    const user = userEvent.setup();
    expect(await screen.findByRole('button', { name: /janv\. 2026/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /juin 2026/ })).toBeInTheDocument();

    // Ligne de statut sélectionnée : le dernier mois par défaut.
    expect(screen.getByText('juin 2026')).toBeInTheDocument();
    expect(screen.getByText('130 000 Ar')).toBeInTheDocument();
    expect(screen.getByText('24 000 Ar')).toBeInTheDocument();

    // Ventilation du mois courant.
    expect(screen.getByText('Alimentation')).toBeInTheDocument();
    expect(screen.getByText('60 %')).toBeInTheDocument();
    expect(screen.getByText('Transport')).toBeInTheDocument();
    expect(screen.getByText('40 %')).toBeInTheDocument();

    // L'anneau a une alternative textuelle qui liste les parts.
    expect(
      screen.getByRole('img', { name: /Alimentation 60 %.*Transport 40 %/ }),
    ).toBeInTheDocument();

    // Un clic sur une barre plus ancienne met à jour le détail.
    await user.click(screen.getByRole('button', { name: /févr\. 2026/ }));
    expect(screen.getByText('févr. 2026')).toBeInTheDocument();
    expect(screen.getByText('120 000 Ar')).toBeInTheDocument();
  });

  it('affiche un état vide quand aucun flux sur la fenêtre', async () => {
    mockedGet.mockResolvedValue({
      ...makeOverview(),
      monthlyCashflow: [
        { month: '2026-01', income: '0', expense: '0' },
        { month: '2026-02', income: '0', expense: '0' },
        { month: '2026-03', income: '0', expense: '0' },
        { month: '2026-04', income: '0', expense: '0' },
        { month: '2026-05', income: '0', expense: '0' },
        { month: '2026-06', income: '0', expense: '0' },
      ],
      currentMonthExpenseCategories: [],
    });
    renderSection();

    expect(await screen.findByText(/Aucune activité sur les 6 derniers mois/)).toBeInTheDocument();
    expect(screen.getByText(/Rien à répartir ce mois-ci/)).toBeInTheDocument();
  });

  it('affiche une erreur avec un bouton Réessayer', async () => {
    mockedGet.mockRejectedValueOnce(new Error('offline'));
    renderSection();

    expect(await screen.findByRole('alert')).toHaveTextContent('momentanément indisponible');
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument();
  });
});
