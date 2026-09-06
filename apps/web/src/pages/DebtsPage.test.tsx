import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../theme';
import { AuthProvider } from '../auth/AuthContext';
import DebtsPage from './DebtsPage';
import type {
  AccountPublic,
  DashboardResponse,
  DebtPublic,
  DebtSettlementPublic,
} from '@finance/shared-types';
import {
  apiAddDebtSettlement,
  apiCreateDebt,
  apiDeleteDebt,
  apiDeleteDebtSettlement,
  apiGetAccounts,
  apiGetDebts,
  apiRefresh,
} from '../auth/api';

vi.mock('../auth/api', () => ({
  apiRefresh: vi.fn(),
  apiLogin: vi.fn(),
  apiLogout: vi.fn(),
  apiRegister: vi.fn(),
  setAccessToken: vi.fn(),
  apiGetAccounts: vi.fn(),
  apiGetDebts: vi.fn(),
  apiCreateDebt: vi.fn(),
  apiDeleteDebt: vi.fn(),
  apiAddDebtSettlement: vi.fn(),
  apiUpdateDebtSettlement: vi.fn(),
  apiDeleteDebtSettlement: vi.fn(),
  apiUpdateDebt: vi.fn(),
}));

const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'a@example.com' };
const CASH: AccountPublic = {
  id: '00000000-0000-4000-8000-000000000101',
  type: 'CASH',
  currency: 'MGA',
  initialBalance: '0',
  balance: '200000',
};
const MVOLA: AccountPublic = {
  id: '00000000-0000-4000-8000-000000000102',
  type: 'MVOLA',
  currency: 'MGA',
  initialBalance: '0',
  balance: '100000',
};
const DASHBOARD: DashboardResponse = {
  currency: 'MGA',
  accounts: [CASH, MVOLA],
  totalAvailable: '300000',
};

const TS = '2026-09-05T10:00:00.000Z';

function settlementOf(item: {
  id: string;
  amount: string;
  account: { id: string; type: AccountPublic['type'] };
  occurredAt: string | null;
  dateUnknown?: boolean;
  description?: string | null;
}): DebtSettlementPublic {
  return {
    id: item.id,
    amount: item.amount,
    currency: 'MGA',
    account: item.account,
    accountUnknown: false,
    occurredAt: item.occurredAt,
    dateUnknown: item.dateUnknown ?? false,
    description: item.description ?? null,
    createdAt: TS,
    updatedAt: TS,
  };
}

function debtOf(item: {
  id: string;
  direction: DebtPublic['direction'];
  kind?: DebtPublic['kind'];
  originalAmount: string;
  settledAmount: string;
  remaining: string;
  counterpartyName: string | null;
  temporalStatus: DebtPublic['temporalStatus'];
  dueDate?: string | null;
  dueDateUnknown?: boolean;
  settlements?: DebtSettlementPublic[];
}): DebtPublic {
  return {
    id: item.id,
    direction: item.direction,
    kind: item.kind ?? 'STANDARD',
    currency: 'MGA',
    originalAmount: item.originalAmount,
    settledAmount: item.settledAmount,
    remaining: item.remaining,
    counterpartyName: item.counterpartyName,
    description: null,
    dueDate: item.dueDate ?? null,
    dueDateUnknown: item.dueDateUnknown ?? false,
    temporalStatus: item.temporalStatus,
    createdAt: TS,
    updatedAt: TS,
    settlements: item.settlements ?? [],
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/debts']}>
        <ThemeProvider>
          <AuthProvider>
            <DebtsPage />
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
  vi.mocked(apiGetDebts).mockResolvedValue({ debts: [] });
  vi.mocked(apiCreateDebt).mockResolvedValue({} as never);
  vi.mocked(apiAddDebtSettlement).mockResolvedValue({} as never);
  vi.mocked(apiDeleteDebtSettlement).mockResolvedValue(undefined);
  vi.mocked(apiDeleteDebt).mockResolvedValue(undefined);
});

async function waitPage() {
  await screen.findByRole('heading', { name: 'Dettes et créances' });
}


describe('DebtsPage — sections « Je dois » / « On me doit »', () => {
  it('affiche les dettes des deux sens avec le restant dérivé', async () => {
    vi.mocked(apiGetDebts).mockResolvedValue({
      debts: [
        debtOf({
          id: 'debt-iowe',
          direction: 'I_OWE',
          originalAmount: '100000',
          settledAmount: '40000',
          remaining: '60000',
          counterpartyName: 'Jean',
          temporalStatus: 'OPEN',
          dueDate: '2026-09-20',
          settlements: [
            settlementOf({
              id: 'settlement-1',
              amount: '40000',
              account: { id: CASH.id, type: 'CASH' },
              occurredAt: '2026-09-05',
            }),
          ],
        }),
        debtOf({
          id: 'debt-owed',
          direction: 'OWED_TO_ME',
          kind: 'INCOME_ADVANCE_RECEIVABLE',
          originalAmount: '300000',
          settledAmount: '0',
          remaining: '300000',
          counterpartyName: 'Patron',
          temporalStatus: 'OPEN',
          dueDateUnknown: true,
        }),
      ],
    });

    renderPage();
    await waitPage();

    await screen.findByRole('heading', { name: 'Je dois' });
    expect(screen.getByRole('heading', { name: 'Je dois' })).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'On me doit' }),
    ).toBeTruthy();

    // « Je dois » : contrepartie, restant dérivé et historique de règlement.
    expect(screen.getByText('Jean')).toBeTruthy();
    expect(screen.getByText('60 000 Ar')).toBeTruthy();
    expect(screen.getByText('40 000 Ar')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Je rembourse' }),
    ).toBeTruthy();

    // « On me doit » : badge « Avance » et libellé spécifique.
    expect(screen.getByText('Patron')).toBeTruthy();
    expect(screen.getByText('Avance')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'J’ai reçu (avance)' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Supprimer le règlement/ }),
    ).toBeTruthy();
  });

  it('permet d’annuler un règlement depuis l’historique', async () => {
    vi.mocked(apiGetDebts).mockResolvedValue({
      debts: [
        debtOf({
          id: 'debt-iowe',
          direction: 'I_OWE',
          originalAmount: '100000',
          settledAmount: '40000',
          remaining: '60000',
          counterpartyName: 'Jean',
          temporalStatus: 'OPEN',
          settlements: [
            settlementOf({
              id: 'settlement-1',
              amount: '40000',
              account: { id: CASH.id, type: 'CASH' },
              occurredAt: '2026-09-05',
            }),
          ],
        }),
      ],
    });

    renderPage();
    await waitPage();
    const cancelButton = await screen.findByRole('button', {
      name: /Supprimer le règlement/,
    });
    await userEvent.click(cancelButton);
    await waitFor(() =>
      expect(apiDeleteDebtSettlement).toHaveBeenCalledWith(
        'debt-iowe',
        'settlement-1',
      ),
    );
  });
});
describe('DebtsPage — créer une dette / une créance', () => {
  it('la case « avance » n’apparaît pas pour « Je dois »', async () => {
    renderPage();
    await waitPage();
    await userEvent.click(
      screen.getByRole('button', { name: 'Nouvelle dette ou créance' }),
    );
    expect(
      screen.queryByText(/C’est une avance sur revenu/),
    ).toBeNull();
  });

  it('crée une avance explicite sur « On me doit »', async () => {
    renderPage();
    await waitPage();
    await userEvent.click(
      screen.getByRole('button', { name: 'Nouvelle dette ou créance' }),
    );
    await userEvent.click(screen.getByLabelText('On me doit'));
    await userEvent.type(screen.getByLabelText('Montant initial'), '150000');
    await userEvent.type(screen.getByLabelText('Contrepartie'), 'Patron');
    await userEvent.click(
      screen.getByText(/C’est une avance sur revenu/),
    );
    await userEvent.click(screen.getByLabelText('Je ne sais plus'));
    await userEvent.click(screen.getByRole('button', { name: 'Créer' }));

    await waitFor(() => expect(apiCreateDebt).toHaveBeenCalled());
    expect(vi.mocked(apiCreateDebt).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        direction: 'OWED_TO_ME',
        kind: 'INCOME_ADVANCE_RECEIVABLE',
        originalAmount: '150000',
        counterpartyName: 'Patron',
        dueDateUnknown: true,
      }),
    );
  });
});

describe('DebtsPage — enregistrer un règlement', () => {
  it('soumet un remboursement partiel avec le compte choisi', async () => {
    vi.mocked(apiGetDebts).mockResolvedValue({
      debts: [
        debtOf({
          id: 'debt-iowe',
          direction: 'I_OWE',
          originalAmount: '100000',
          settledAmount: '0',
          remaining: '100000',
          counterpartyName: 'Jean',
          temporalStatus: 'OPEN',
          dueDateUnknown: true,
        }),
      ],
    });
    renderPage();
    await waitPage();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Je rembourse' }),
    );
    await userEvent.clear(screen.getByLabelText('Montant du règlement'));
    await userEvent.type(screen.getByLabelText('Montant du règlement'), '40000');
    await userEvent.selectOptions(
      screen.getByLabelText('Compte utilisé'),
      CASH.id,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() =>
      expect(apiAddDebtSettlement).toHaveBeenCalledWith(
        'debt-iowe',
        expect.objectContaining({
          amount: '40000',
          accountId: CASH.id,
          occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
      ),
    );
  });
});

