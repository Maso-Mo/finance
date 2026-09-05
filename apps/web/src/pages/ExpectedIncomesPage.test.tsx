import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../theme';
import { AuthProvider } from '../auth/AuthContext';
import ExpectedIncomesPage from './ExpectedIncomesPage';
import type {
  AccountPublic,
  DashboardResponse,
  ExpectedIncomePublic,
  ExpectedIncomeStatus,
  ExpectedIncomeCertainty,
  TransactionPublic,
} from '@finance/shared-types';
import {
  apiCancelExpectedIncome,
  apiConfirmExpectedIncomeReceived,
  apiCreateExpectedIncome,
  apiGetAccounts,
  apiGetExpectedIncomes,
  apiRefresh,
} from '../auth/api';

vi.mock('../auth/api', () => ({
  apiRefresh: vi.fn(),
  apiLogin: vi.fn(),
  apiLogout: vi.fn(),
  apiRegister: vi.fn(),
  setAccessToken: vi.fn(),
  apiGetAccounts: vi.fn(),
  apiGetExpectedIncomes: vi.fn(),
  apiCreateExpectedIncome: vi.fn(),
  apiUpdateExpectedIncome: vi.fn(),
  apiCancelExpectedIncome: vi.fn(),
  apiConfirmExpectedIncomeReceived: vi.fn(),
}));

const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'a@example.com' };
const CASH: AccountPublic = { id: '00000000-0000-4000-8000-000000000101', type: 'CASH', currency: 'MGA', initialBalance: '0', balance: '0' };
const MVOLA: AccountPublic = { id: '00000000-0000-4000-8000-000000000102', type: 'MVOLA', currency: 'MGA', initialBalance: '0', balance: '0' };
const BASE_ACCOUNTS: AccountPublic[] = [CASH, MVOLA];
const ACCOUNTS_RESPONSE: DashboardResponse = { currency: 'MGA', accounts: BASE_ACCOUNTS, totalAvailable: '0' };

type IncomeSeed = {
  id: string; amount: string;
  certainty: ExpectedIncomeCertainty;
  status: ExpectedIncomeStatus;
  description: string | null;
  expectedDate: string | null; windowStart: string | null; windowEnd: string | null;
  reminderBucket?: ExpectedIncomePublic['reminderBucket'];
};

function income(item: IncomeSeed): ExpectedIncomePublic {
  return {
    id: item.id,
    amount: item.amount,
    currency: 'MGA',
    certainty: item.certainty,
    status: item.status,
    description: item.description,
    expectedDate: item.expectedDate,
    windowStart: item.windowStart,
    windowEnd: item.windowEnd,
    receivedTransactionId: null,
    reminderBucket: item.reminderBucket ?? null,
    receivedTransaction: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function transactionOf(): TransactionPublic {
  return {
    id: 'tx1',
    type: 'INCOME',
    amount: '490000',
    description: null,
    occurredAt: '2026-10-07',
    accountUnknown: false,
    categoryUnknown: false,
    category: null,
    allocations: [],
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
      <MemoryRouter initialEntries={['/expected']}>
        <ThemeProvider>
          <AuthProvider>
            <ExpectedIncomesPage />
          </AuthProvider>
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiRefresh).mockResolvedValue(USER);
  vi.mocked(apiGetAccounts).mockResolvedValue(ACCOUNTS_RESPONSE);
  vi.mocked(apiGetExpectedIncomes).mockResolvedValue({ today: '2026-10-05', expectedIncomes: [] });
});

async function waitPage() {
  await screen.findByRole('heading', { name: 'Revenus à venir' });
}

describe('ExpectedIncomesPage — revenus à venir', () => {
  it('badges de certitude distincts : Confirmé et Incertain', async () => {
    vi.mocked(apiGetExpectedIncomes).mockResolvedValue({
      today: '2026-10-05',
      expectedIncomes: [
        income({ id: 'i1', amount: '500000', certainty: 'CONFIRMED', description: 'Salaire', status: 'PENDING', expectedDate: '2026-10-05', windowStart: null, windowEnd: null, reminderBucket: 'dueToday' }),
        income({ id: 'i2', amount: '300000', certainty: 'UNCERTAIN', description: 'Freelance', status: 'PENDING', expectedDate: null, windowStart: '2026-10-20', windowEnd: '2026-10-27', reminderBucket: 'inWindow' }),
      ],
    });
    renderPage();
    await waitPage();
    expect(await screen.findByText('Salaire')).toBeTruthy();
    expect(screen.getByText('Freelance')).toBeTruthy();
    expect(screen.getAllByText('Confirmé')).toHaveLength(1);
    expect(screen.getAllByText('Incertain')).toHaveLength(1);
    expect(screen.getByText(/500 000 Ar/)).toBeTruthy();
    expect(screen.getByText(/entre le 2026-10-20 et le 2026-10-27/)).toBeTruthy();
  });

  it('saisie d’un revenu INCERTAIN en période → création du payload en plage', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitPage();
    await user.click(screen.getByRole('button', { name: 'Ajouter un revenu attendu' }));

    await user.type(screen.getByLabelText('Montant attendu'), '300000');
    await user.type(screen.getByLabelText('Description'), 'Freelance');
    await user.click(screen.getByLabelText(/Incertain/));
    await user.click(screen.getByLabelText(/Période/));
    fireEvent.change(screen.getByLabelText('Début de période'), { target: { value: '2026-10-20' } });
    fireEvent.change(screen.getByLabelText('Fin de période'), { target: { value: '2026-10-27' } });
    await user.click(screen.getByRole('button', { name: /Vérifier et confirmer/ }));

    expect(await screen.findByRole('heading', { name: 'Confirmer le revenu attendu' })).toBeTruthy();
    expect(screen.getAllByText(/Incertain/).length).toBeGreaterThan(0);
    expect(screen.getByText(/entre le 2026-10-20 et le 2026-10-27/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Confirmer la planification' }));
    await waitFor(() => expect(apiCreateExpectedIncome).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiCreateExpectedIncome).mock.calls[0]![0]).toEqual({
      amount: '300000',
      certainty: 'UNCERTAIN',
      description: 'Freelance',
      windowStart: '2026-10-20',
      windowEnd: '2026-10-27',
    });
  });

  it('« Reçu ? » → montant réel modifiable + multi-comptes + confirmation', async () => {
    const user = userEvent.setup();
    vi.mocked(apiGetExpectedIncomes).mockResolvedValue({
      today: '2026-10-05',
      expectedIncomes: [
        income({ id: 'i1', amount: '500000', certainty: 'CONFIRMED', description: 'Salaire', status: 'PENDING', expectedDate: '2026-10-05', windowStart: null, windowEnd: null, reminderBucket: 'dueToday' }),
      ],
    });
    vi.mocked(apiConfirmExpectedIncomeReceived).mockResolvedValue({
      expectedIncome: income({ id: 'i1', amount: '500000', certainty: 'CONFIRMED', description: 'Salaire', status: 'RECEIVED', expectedDate: '2026-10-05', windowStart: null, windowEnd: null }),
      transaction: transactionOf(),
    });

    renderPage();
    await waitPage();
    await user.click(await screen.findByRole('button', { name: 'Reçu ?' }));

    const panel = (await screen.findByText(/Attendu 500 000 Ar/)).closest('section')!;
    const amountInput = within(panel).getByLabelText('Montant réel');
    expect((amountInput as HTMLInputElement).value).toBe('500000');

    await user.clear(amountInput);
    await user.type(amountInput, '490000');
    fireEvent.change(within(panel).getByLabelText('Date réelle'), { target: { value: '2026-10-07' } });
    await user.type(within(panel).getByLabelText('Part CASH'), '300000');
    await user.type(within(panel).getByLabelText('Part MVOLA'), '190000');
    await user.click(within(panel).getByRole('button', { name: 'Vérifier…' }));

    expect(await screen.findByRole('heading', { name: 'Confirmer la réception réelle' })).toBeTruthy();
    expect(screen.getByText(/490 000 Ar réellement reçu le 2026-10-07/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Oui, je l’ai reçu' }));

    await waitFor(() => expect(apiConfirmExpectedIncomeReceived).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiConfirmExpectedIncomeReceived).mock.calls[0]![0]).toBe('i1');
    expect(vi.mocked(apiConfirmExpectedIncomeReceived).mock.calls[0]![1]).toEqual({
      amount: '490000',
      occurredAt: '2026-10-07',
      allocations: [
        { accountId: CASH.id, amount: '300000' },
        { accountId: MVOLA.id, amount: '190000' },
      ],
      description: 'Salaire',
    });
  });

  it('« Pas encore » ferme le panneau Reçu ? sans aucune écriture', async () => {
    const user = userEvent.setup();
    vi.mocked(apiGetExpectedIncomes).mockResolvedValue({
      today: '2026-10-05',
      expectedIncomes: [
        income({ id: 'i1', amount: '500000', certainty: 'CONFIRMED', description: 'Salaire', status: 'PENDING', expectedDate: '2026-10-05', windowStart: null, windowEnd: null, reminderBucket: 'dueToday' }),
      ],
    });
    renderPage();
    await waitPage();
    await user.click(await screen.findByRole('button', { name: 'Reçu ?' }));
    await screen.findByText(/Attendu 500 000 Ar le 2026-10-05/);
    await user.click(screen.getByRole('button', { name: 'Pas encore' }));
    expect(screen.queryByText(/Attendu 500 000 Ar le 2026-10-05/)).toBeNull();
    expect(apiConfirmExpectedIncomeReceived).not.toHaveBeenCalled();
  });

  it('annulation d’un PENDING via le modal (Oui, annuler)', async () => {
    const user = userEvent.setup();
    vi.mocked(apiGetExpectedIncomes).mockResolvedValue({
      today: '2026-10-05',
      expectedIncomes: [
        income({ id: 'i1', amount: '80000', certainty: 'CONFIRMED', description: 'Petit bonus', status: 'PENDING', expectedDate: '2026-10-08', windowStart: null, windowEnd: null, reminderBucket: 'upcoming' }),
      ],
    });
    vi.mocked(apiCancelExpectedIncome).mockResolvedValue({
      expectedIncome: income({ id: 'i1', amount: '80000', certainty: 'CONFIRMED', description: 'Petit bonus', status: 'CANCELED', expectedDate: '2026-10-08', windowStart: null, windowEnd: null }),
    });
    renderPage();
    await waitPage();
    await user.click(await screen.findByRole('button', { name: 'Annuler' }));
    expect(await screen.findByText('Annuler ce revenu attendu ?')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Oui, annuler' }));
    await waitFor(() => expect(apiCancelExpectedIncome).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiCancelExpectedIncome).mock.calls[0]![0]).toBe('i1');
  });
});
