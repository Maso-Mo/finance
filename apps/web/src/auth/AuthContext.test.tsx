import 'fake-indexeddb/auto';
import { vi, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './AuthContext';
import { apiRefresh, apiLogout } from './api';
import { clearSnapshots, loadSnapshot, saveSnapshot, setSnapshotIdentity } from '../lib/offlineSnapshotStore';
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), apiRefresh: vi.fn(), apiLogout: vi.fn() }));
const user = { id: 'logout-user', email: 'logout@example.com' };
function Consumer() { const auth = useAuth(); return <><p>{auth.status}</p><button onClick={() => void auth.signOut()}>Logout</button></>; }
beforeEach(async () => { sessionStorage.clear(); await clearSnapshots(user.id); vi.mocked(apiRefresh).mockResolvedValue(user); vi.mocked(apiLogout).mockResolvedValue(undefined); });
it('explicit logout removes financial snapshots, tab identity and query data', async () => {
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><AuthProvider><Consumer /></AuthProvider></QueryClientProvider>);
  await screen.findByText('authenticated');
  await saveSnapshot('analytics', { currency: 'MGA', currentMonth: '2026-09', monthlyCashflow: [], currentMonthExpenseCategories: [] });
  client.setQueryData(['private'], 'financial data');
  await userEvent.click(screen.getByRole('button', { name: 'Logout' }));
  await screen.findByText('guest');
  expect(apiLogout).toHaveBeenCalled(); expect(sessionStorage.getItem('finance.offline-user')).toBeNull();
  expect(client.getQueryData(['private'])).toBeUndefined();
  setSnapshotIdentity(user.id); await waitFor(async () => expect(await loadSnapshot('analytics')).toBeNull());
});
