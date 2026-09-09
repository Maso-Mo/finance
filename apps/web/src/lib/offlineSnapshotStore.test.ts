import 'fake-indexeddb/auto';
import { beforeEach, describe, it, expect } from 'vitest';
import { clearSnapshots, loadSnapshot, saveSnapshot, setSnapshotIdentity } from './offlineSnapshotStore';
const data = { currency: 'MGA', currentMonth: '2026-09', monthlyCashflow: [{ month: '2026-09', income: '1000', expense: '250' }], currentMonthExpenseCategories: [{ categoryId: null, label: 'Transport', amount: '250', share: 1 }] };
beforeEach(async () => { await clearSnapshots('A'); await clearSnapshots('B'); setSnapshotIdentity('A'); });
describe('offline snapshots', () => {
  it('saves aggregates and replaces them after a new response', async () => {
    await saveSnapshot('analytics', data);
    expect((await loadSnapshot('analytics'))?.data).toEqual(data);
    await saveSnapshot('analytics', { ...data, currentMonthExpenseCategories: [] });
    const row = await loadSnapshot<typeof data>('analytics');
    expect(row?.data.currentMonthExpenseCategories).toEqual([]); expect(Date.parse(row!.syncedAt)).toBeGreaterThan(0);
  });
  it('isolates users and never restores without an identity', async () => {
    await saveSnapshot('analytics', data); setSnapshotIdentity('B'); expect(await loadSnapshot('analytics')).toBeNull();
    setSnapshotIdentity(null); expect(await loadSnapshot('analytics')).toBeNull();
  });
  it('clears only the explicit logout user', async () => {
    await saveSnapshot('analytics', data); setSnapshotIdentity('B'); await saveSnapshot('analytics', data);
    await clearSnapshots('A'); expect(await loadSnapshot('analytics')).not.toBeNull();
    setSnapshotIdentity('A'); expect(await loadSnapshot('analytics')).toBeNull();
  });
  it('strips auth and nested secrets and keeps snapshots small', async () => {
    await saveSnapshot('analytics', { ...data, accessToken: 'SECRET', refreshToken: 'SECRET', password: 'SECRET', AI_API_KEY: 'SECRET', monthlyCashflow: [{ ...data.monthlyCashflow[0], secret: 'SECRET' }] });
    const snapshot = JSON.stringify(await loadSnapshot('analytics'));
    expect(snapshot).not.toContain('SECRET'); expect(snapshot.length).toBeLessThan(2000);
  });
  it('rejects malformed data without replacing the valid snapshot', async () => {
    await saveSnapshot('analytics', data); await expect(saveSnapshot('analytics', { currency: 'bad' })).rejects.toThrow();
    expect((await loadSnapshot('analytics'))?.data).toEqual(data);
  });
  it('does not save a response belonging to A into the newly selected B account', async () => {
    setSnapshotIdentity('B'); await saveSnapshot('analytics', data, 'A');
    expect(await loadSnapshot('analytics')).toBeNull();
  });
  it('does not resurrect snapshots from an in-flight write after logout', async () => {
    const pending = saveSnapshot('analytics', data); await clearSnapshots('A'); await pending;
    setSnapshotIdentity('A'); expect(await loadSnapshot('analytics')).toBeNull();
  });
});
