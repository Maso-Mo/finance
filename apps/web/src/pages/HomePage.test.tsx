import { describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import HomePage from './HomePage';
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ status: 'authenticated', user: { id: 'home-test' } }) }));
vi.mock('../auth/api', async original => ({ ...await original<typeof import('../auth/api')>(),
  apiGetAccounts: vi.fn().mockResolvedValue({ currency: 'MGA', totalAvailable: '100', accounts: ['BANK', 'MVOLA', 'ORANGE_MONEY', 'AIRTEL_MONEY', 'CASH', 'SAVINGS'].map((type, i) => ({ id: String(i), type, balance: '100', initialBalance: '100', currency: 'MGA' })) }),
  apiGetReminders: vi.fn().mockResolvedValue({ overdue: [], dueToday: [], upcoming: [] }), apiGetForecast: vi.fn().mockResolvedValue(null), apiGetBudgets: vi.fn().mockResolvedValue({}), apiGetTransactions: vi.fn().mockResolvedValue({ transactions: [] }), apiGetAnalyticsOverview: vi.fn().mockResolvedValue({ monthlyCashflow: [], currentMonthExpenseCategories: [] }),
}));
describe('Home details list', () => {
  it('renders AccountRow directly under ul without nested li or React warnings', async () => {
    const errors = vi.spyOn(console, 'error');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={client}><MemoryRouter><HomePage /></MemoryRouter></QueryClientProvider>);
    await userEvent.click(await screen.findByRole('button', { name: 'Détails' }));
    await screen.findByText('MVola', { selector: 'p' });
    const list = container.querySelector('#guide-total ul')!;
    expect(list.children).toHaveLength(5);
    expect(Array.from(list.children).every(child => child.tagName === 'LI')).toBe(true);
    expect(container.querySelector('li li')).toBeNull();
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/validateDOMNesting|cannot be a descendant/);
    errors.mockRestore(); client.clear();
  });
});
