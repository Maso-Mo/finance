import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnalyticsSection } from '../components/analytics';
import { apiGetAnalyticsOverview, apiSetTargetBalance, ApiError } from '../auth/api';
import { clearSnapshots, loadSnapshot, saveSnapshot, setSnapshotIdentity } from './offlineSnapshotStore';
import { setUnavailable } from './connectivity';
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ status: 'authenticated', user: { id: 'offline-test' } }) }));
vi.mock('../auth/api', async original => ({ ...await original<typeof import('../auth/api')>(), apiGetAnalyticsOverview: vi.fn() }));
const data = { currency: 'MGA' as const, currentMonth: '2026-09', monthlyCashflow: [{ month: '2026-09', income: '1000', expense: '250' }], currentMonthExpenseCategories: [{ categoryId: null, label: 'Transport', amount: '250', share: 1 }] };
function mount() { const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); return render(<QueryClientProvider client={client}><AnalyticsSection currency="MGA" today="2026-09-08" /></QueryClientProvider>); }
beforeEach(async () => { await clearSnapshots('offline-test'); setSnapshotIdentity('offline-test'); setUnavailable(false); vi.mocked(apiGetAnalyticsOverview).mockReset(); });
describe('offline analytics', () => {
  it('saves a successful online response', async () => {
    vi.mocked(apiGetAnalyticsOverview).mockResolvedValue(data); mount();
    await screen.findByText('Transport'); await waitFor(async () => expect((await loadSnapshot('analytics'))?.data).toEqual(data));
  });
  it('restores cashflow/categories with badge, period and timestamp on API failure', async () => {
    await saveSnapshot('analytics', data); vi.mocked(apiGetAnalyticsOverview).mockRejectedValue(new ApiError(0, 'Connexion impossible.')); mount();
    expect(await screen.findByText('Transport')).toBeInTheDocument();
    expect(screen.getByText('Hors connexion')).toHaveTextContent('Hors connexion');
    expect(screen.getByText(/Dernière mise à jour/)).toHaveTextContent('2026-09');
    expect(screen.getByText('1 000 Ar')).toBeInTheDocument();
  });
  it('shows an explicit first-sync empty state without snapshot', async () => {
    vi.mocked(apiGetAnalyticsOverview).mockRejectedValue(new ApiError(503, 'Connexion impossible.')); mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Aucune donnée hors connexion disponible');
  });
  it('does not fall back on authentication errors', async () => {
    await saveSnapshot('analytics', data); vi.mocked(apiGetAnalyticsOverview).mockRejectedValue(new ApiError(401, 'Session expirée')); mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Session expirée'); expect(screen.queryByText('Transport')).toBeNull();
  });
  it('blocks financial writes before fetch while offline', async () => {
    setUnavailable(true); const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(apiSetTargetBalance('account-id', '100')).rejects.toThrow('Cette action nécessite une connexion à Finance.');
    expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore();
  });
});
