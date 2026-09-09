import { useQueryClient } from '@tanstack/react-query';
import { clearSnapshots, setSnapshotIdentity } from '../lib/offlineSnapshotStore';
import { setUnavailable, useUnavailable, OFFLINE_EMPTY_MESSAGE } from '../lib/connectivity';
import { ApiError } from './api';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { PublicUser } from '@finance/shared-types';
import {
  apiLogin,
  apiLogout,
  apiRefresh,
  apiRegister,
  setAccessToken,
} from './api';

type AuthStatus = 'loading' | 'authenticated' | 'guest';

interface AuthContextValue {
  status: AuthStatus;
  user: PublicUser | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Gère l'état d'authentification (UI) + la restauration de session.
 *
 * Au chargement, il n'existe aucun access token en mémoire (persistant) :
 * on tente un /auth/refresh silencieux (cookie HttpOnly). Si le refresh
 * réussit, on a un utilisateur authentifié ; sinon on passe en "guest".
 * Cette tentative n'a lieu qu'une fois au montage (pas de boucle infinie).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const unavailable = useUnavailable();
  const [offlineCandidate, setOfflineCandidate] = useState<string | null>(null);
  const [readOnlySession, setReadOnlySession] = useState(false);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<PublicUser | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (localStorage.getItem('finance.signed-out')) { setStatus('guest'); return; }
    (async () => {
      try {
        const restored = await apiRefresh();
        if (!cancelled) {
          setSnapshotIdentity(restored.id);
          sessionStorage.setItem('finance.offline-user', restored.id);
          setUser(restored);
          setStatus('authenticated');
        }
      } catch (error) {
        if (!cancelled && error instanceof ApiError && [0, 502, 503, 504].includes(error.status)) setOfflineCandidate(sessionStorage.getItem('finance.offline-user'));
        if (!cancelled) {
          setAccessToken(null);
          setStatus('guest');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const logoutOtherTab = (event: StorageEvent) => {
      if (event.key !== 'finance.logout' || !event.newValue) return;
      try {
        const { id } = JSON.parse(event.newValue);
        if (id !== user?.id && id !== sessionStorage.getItem('finance.offline-user')) return;
        setSnapshotIdentity(null); sessionStorage.removeItem('finance.offline-user');
        setAccessToken(null); client.clear(); setUser(null); setStatus('guest'); setOfflineCandidate(null); setReadOnlySession(false);
      } catch { /* Invalid storage messages contain no actionable identity. */ }
    };
    window.addEventListener('storage', logoutOtherTab);
    return () => window.removeEventListener('storage', logoutOtherTab);
  }, [client, user?.id]);

  useEffect(() => {
    if (!readOnlySession) return;
    const restore = async () => {
      try {
        const restored = await apiRefresh();
        setSnapshotIdentity(restored.id); client.clear(); setUser(restored);
        sessionStorage.setItem('finance.offline-user', restored.id);
        setReadOnlySession(false); setUnavailable(false);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          setSnapshotIdentity(null); client.clear(); setUser(null); setStatus('guest'); setReadOnlySession(false);
        }
      }
    };
    const timer = window.setInterval(() => void restore(), 15000);
    window.addEventListener('online', restore);
    return () => { clearInterval(timer); window.removeEventListener('online', restore); };
  }, [readOnlySession, client]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      signIn: async (email, password) => {
        const authenticated = await apiLogin(email, password);
        localStorage.removeItem('finance.signed-out');
        client.clear();
        setSnapshotIdentity(authenticated.id);
        sessionStorage.setItem('finance.offline-user', authenticated.id);
        setReadOnlySession(false);
        setUser(authenticated);
        setStatus('authenticated');
      },
      signUp: async (email, password) => {
        const authenticated = await apiRegister(email, password);
        localStorage.removeItem('finance.signed-out');
        client.clear();
        setSnapshotIdentity(authenticated.id);
        sessionStorage.setItem('finance.offline-user', authenticated.id);
        setReadOnlySession(false);
        setUser(authenticated);
        setStatus('authenticated');
      },
      signOut: async () => {
        const userId = user?.id;
        setSnapshotIdentity(null);
        sessionStorage.removeItem('finance.offline-user');
        localStorage.setItem('finance.signed-out', 'true');
        localStorage.setItem('finance.logout', JSON.stringify({ id: userId, at: Date.now() }));
        client.clear();
        setReadOnlySession(false);
        if (userId) await clearSnapshots(userId);
        try {
          await apiLogout();
        } catch {
          // Explicit local logout stays effective even if the cookie cannot be revoked online.
          // The signed-out marker prevents a later automatic refresh.
        } finally {
          setAccessToken(null);
          setUser(null);
          setStatus('guest');
        }
      },
    }),
    [status, user, client],
  );

  if (offlineCandidate) return <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-4 p-6">
    <h1 className="text-xl font-bold">Finance est hors connexion</h1>
    <p>La session ne peut pas être vérifiée. Tu peux consulter les dernières données du compte utilisé dans cet onglet, en lecture seule.</p>
    <button className="btn btn-primary" onClick={() => {
      setSnapshotIdentity(offlineCandidate); setUser({ id: offlineCandidate, email: 'Session locale' });
      setReadOnlySession(true); setStatus('authenticated'); setOfflineCandidate(null);
      window.history.replaceState(null, '', '/');
    }}>Consulter mes données hors connexion</button>
    <button className="btn btn-secondary" onClick={() => { setOfflineCandidate(null); setSnapshotIdentity(null); }}>Revenir à la connexion</button>
  </main>;
  return <AuthContext.Provider value={value}>{status === 'guest' && unavailable && <p role="status" className="bg-raise p-4 text-sm text-ink2">{OFFLINE_EMPTY_MESSAGE}</p>}{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an <AuthProvider>.');
  }
  return context;
}
