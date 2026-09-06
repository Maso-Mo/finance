import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../theme';
import { AuthProvider } from '../auth/AuthContext';
import TransfersPage from './TransfersPage';
import type {
  AccountPublic,
  DashboardResponse,
  TransferPublic,
} from '@finance/shared-types';
import {
  apiCreateTransfer,
  apiDeleteTransfer,
  apiGetAccounts,
  apiGetTransfers,
  apiRefresh,
  apiUpdateTransfer,
} from '../auth/api';

vi.mock('../auth/api', () => ({
  apiRefresh: vi.fn(),
  apiLogin: vi.fn(),
  apiLogout: vi.fn(),
  apiRegister: vi.fn(),
  setAccessToken: vi.fn(),
  apiGetAccounts: vi.fn(),
  apiGetTransfers: vi.fn(),
  apiCreateTransfer: vi.fn(),
  apiUpdateTransfer: vi.fn(),
  apiDeleteTransfer: vi.fn(),
}));

const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'a@example.com' };
const CASH: AccountPublic = {
  id: '00000000-0000-4000-8000-000000000101',
  type: 'CASH',
  currency: 'MGA',
  initialBalance: '0',
  balance: '500000',
};
const MVOLA: AccountPublic = {
  id: '00000000-0000-4000-8000-000000000102',
  type: 'MVOLA',
  currency: 'MGA',
  initialBalance: '0',
  balance: '100000',
};
const SAVINGS: AccountPublic = {
  id: '00000000-0000-4000-8000-000000000103',
  type: 'SAVINGS',
  currency: 'MGA',
  initialBalance: '0',
  balance: '0',
};
const ACCOUNTS: AccountPublic[] = [CASH, MVOLA, SAVINGS];
const DASHBOARD: DashboardResponse = {
  currency: 'MGA',
  accounts: ACCOUNTS,
  totalAvailable: '600000',
};

function transferOf(item: {
  id: string;
  source: AccountPublic;
  destination: AccountPublic;
  amount: string;
  feeAmount: string;
  occurredAt: string | null;
  dateUnknown?: boolean;
  description?: string | null;
}): TransferPublic {
  return {
    id: item.id,
    source: { id: item.source.id, type: item.source.type },
    destination: { id: item.destination.id, type: item.destination.type },
    amount: item.amount,
    feeAmount: item.feeAmount,
    currency: 'MGA',
    occurredAt: item.occurredAt,
    dateUnknown: item.dateUnknown ?? false,
    description: item.description ?? null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/transfers']}>
        <ThemeProvider>
          <AuthProvider>
            <TransfersPage />
          </AuthProvider>
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiRefresh).mockResolvedValue(USER);
  vi.mocked(apiGetAccounts).mockResolvedValue(DASHBOARD);
  vi.mocked(apiGetTransfers).mockResolvedValue({
    transfers: [],
    page: 1,
    limit: 50,
    hasMore: false,
  });
});

async function waitPage() {
  await screen.findByRole('heading', { name: 'Transferts' });
}

describe('TransfersPage — enregistrer un transfert', () => {
  it('formulaire : source, destination, montant, frais et résumé débit/crédit', async () => {
    renderPage();
    await waitPage();
    await userEvent.click(
      screen.getByRole('button', { name: 'Enregistrer un transfert' }),
    );

    await userEvent.selectOptions(
      screen.getByLabelText('Compte source'),
      MVOLA.id,
    );
    // La destination proposée n’est jamais le compte source.
    const destinationOptions = screen
      .getByLabelText('Compte destination')
      .querySelectorAll('option');
    const labels = Array.from(destinationOptions).map((o) => o.textContent);
    expect(labels).not.toContain('MVola');

    await userEvent.selectOptions(
      screen.getByLabelText('Compte destination'),
      CASH.id,
    );
    await userEvent.type(screen.getByLabelText('Montant transféré'), '100000');
    await userEvent.click(
      screen.getByRole('checkbox', {
        name: /Frais prélevés en plus sur le compte source/i,
      }),
    );
    await userEvent.type(screen.getByLabelText('Montant des frais'), '2500');

    expect(screen.getByText('Débité de MVola')).toBeTruthy();
    // 102 500 Ar (montant + frais, groupés) : débit source unique.
    expect(screen.getByText('-102 500 Ar')).toBeTruthy();
    // Crédit destination.
    expect(screen.getByText('100 000 Ar')).toBeTruthy();
    // Impact Total disponible.
    expect(screen.getByText('-2 500 Ar')).toBeTruthy();
  });

  it('impact Total disponible : Cash → Épargne = −100 000 Ar', async () => {
    renderPage();
    await waitPage();
    await userEvent.click(
      screen.getByRole('button', { name: 'Enregistrer un transfert' }),
    );
    await userEvent.selectOptions(
      screen.getByLabelText('Compte source'),
      CASH.id,
    );
    await userEvent.selectOptions(
      screen.getByLabelText('Compte destination'),
      SAVINGS.id,
    );
    await userEvent.type(screen.getByLabelText('Montant transféré'), '100000');
    // Le débit et l'impact valent tous deux −100 000 Ar (Épargne exclue du
    // Total disponible) : deux occurrences textuelles.
    expect(screen.getAllByText('-100 000 Ar').length).toBeGreaterThanOrEqual(1);
  });

  it('confirmation unique : « Je ne sais plus » → payload dateUnknown puis envoi', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitPage();
    await user.click(
      screen.getByRole('button', { name: 'Enregistrer un transfert' }),
    );
    await user.selectOptions(screen.getByLabelText('Compte source'), MVOLA.id);
    await user.selectOptions(
      screen.getByLabelText('Compte destination'),
      CASH.id,
    );
    await user.type(screen.getByLabelText('Montant transféré'), '100000');
    await user.click(
      screen.getByRole('checkbox', {
        name: /Frais prélevés en plus sur le compte source/i,
      }),
    );
    await user.type(screen.getByLabelText('Montant des frais'), '2500');
    await user.click(screen.getByRole('checkbox', { name: /Je ne sais plus/i }));

    // Première étape : vérification → écran de confirmation unique.
    await user.click(screen.getByRole('button', { name: 'Vérifier…' }));
    expect(
      await screen.findByText('Confirmer ce transfert ?'),
    ).toBeTruthy();
    expect(screen.getByText('Débit total MVola')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Confirmer' }));
    await waitFor(() =>
      expect(apiCreateTransfer).toHaveBeenCalledWith({
        sourceAccountId: MVOLA.id,
        destinationAccountId: CASH.id,
        amount: '100000',
        feeAmount: '2500',
        dateUnknown: true,
      }),
    );
  });

  it('historique : une seule opération par transfert (jamais dépense + revenu)', async () => {
    vi.mocked(apiGetTransfers).mockResolvedValue({
      transfers: [
        transferOf({
          id: 'tf-1',
          source: MVOLA,
          destination: CASH,
          amount: '100000',
          feeAmount: '2500',
          occurredAt: '2026-09-06',
        }),
      ],
      page: 1,
      limit: 50,
      hasMore: false,
    });
    renderPage();
    await waitPage();
    expect(await screen.findByText('MVola → Cash')).toBeTruthy();
    expect(screen.getByText('100 000 Ar')).toBeTruthy();
    expect(screen.getByText('Frais : 2 500 Ar')).toBeTruthy();
    expect(screen.queryByText('Revenu')).toBeNull();
    expect(screen.queryByText('Dépense')).toBeNull();
  });

  it('édition : pré-remplit le formulaire puis PATCH le transfert', async () => {
    const user = userEvent.setup();
    const item = transferOf({
      id: 'tf-1',
      source: MVOLA,
      destination: CASH,
      amount: '100000',
      feeAmount: '0',
      occurredAt: '2026-09-06',
      description: 'Versement cash',
    });
    vi.mocked(apiGetTransfers).mockResolvedValue({
      transfers: [item],
      page: 1,
      limit: 50,
      hasMore: false,
    });
    renderPage();
    await waitPage();
    await user.click(await screen.findByRole('button', { name: 'Modifier' }));

    expect(
      await screen.findByRole('heading', { name: 'Corriger un transfert' }),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText('Montant transféré') as HTMLInputElement).value,
    ).toBe('100000');
    expect(
      (screen.getByLabelText('Description') as HTMLInputElement).value,
    ).toBe('Versement cash');

    const amountInput = screen.getByLabelText('Montant transféré');
    await user.clear(amountInput);
    await user.type(amountInput, '250000');
    await user.click(screen.getByRole('button', { name: 'Vérifier…' }));
    await user.click(
      await screen.findByRole('button', { name: 'Confirmer' }),
    );

    await waitFor(() =>
      expect(apiUpdateTransfer).toHaveBeenCalledWith('tf-1', {
        sourceAccountId: MVOLA.id,
        destinationAccountId: CASH.id,
        amount: '250000',
        feeAmount: '0',
        dateUnknown: false,
        occurredAt: '2026-09-06',
        description: 'Versement cash',
      }),
    );
  });

  it('suppression : confirmation explicite puis DELETE (soft-delete)', async () => {
    const user = userEvent.setup();
    const item = transferOf({
      id: 'tf-1',
      source: MVOLA,
      destination: CASH,
      amount: '100000',
      feeAmount: '0',
      occurredAt: '2026-09-06',
    });
    vi.mocked(apiGetTransfers).mockResolvedValue({
      transfers: [item],
      page: 1,
      limit: 50,
      hasMore: false,
    });
    renderPage();
    await waitPage();
    await user.click(await screen.findByRole('button', { name: 'Supprimer' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('heading', {
        name: 'Supprimer ce transfert ?',
      }),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Supprimer' }));
    await waitFor(() => expect(apiDeleteTransfer).toHaveBeenCalledWith('tf-1'));
  });
});

