import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { ApiError, getAccessToken } from '../auth/api';
import { loadSnapshot, saveSnapshot, snapshotIdentity, type SnapshotKind } from './offlineSnapshotStore';
import { setUnavailable, OFFLINE_EMPTY_MESSAGE } from './connectivity';

export function useSnapshotQuery<T>(kind: SnapshotKind, key: unknown[], fetchData: () => Promise<T>) {
  const { user, status } = useAuth();
  const query = useQuery({
    queryKey: [...key, user?.id], enabled: status === 'authenticated',
    networkMode: 'always', retry: false, staleTime: 60_000,
    refetchInterval: 30_000, refetchOnReconnect: 'always',
    queryFn: async () => {
      try {
        if (!getAccessToken() && sessionStorage.getItem('finance.offline-user')) throw new ApiError(0, 'Session hors connexion.');
        const data = await fetchData();
        // Storage quotas/private mode must not turn a successful API response into an error.
        await saveSnapshot(kind, data, user?.id ?? null).catch(() => undefined);
        return { data, offline: false, syncedAt: new Date().toISOString() };
      } catch (error) {
        if (!(error instanceof ApiError) || ![0, 502, 503, 504].includes(error.status)) throw error;
        setUnavailable(true);
        if (snapshotIdentity() !== user?.id) throw new Error('La session a changé.');
        const snapshot = await loadSnapshot<T>(kind).catch(() => null);
        if (snapshot) return { data: snapshot.data, offline: true, syncedAt: snapshot.syncedAt };
        throw new Error(OFFLINE_EMPTY_MESSAGE);
      }
    },
  });
  return { ...query, data: query.data?.data, offline: query.data?.offline ?? false, syncedAt: query.data?.syncedAt };
}
