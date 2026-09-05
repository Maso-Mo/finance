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
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<PublicUser | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const restored = await apiRefresh();
        if (!cancelled) {
          setUser(restored);
          setStatus('authenticated');
        }
      } catch {
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

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      signIn: async (email, password) => {
        const authenticated = await apiLogin(email, password);
        setUser(authenticated);
        setStatus('authenticated');
      },
      signUp: async (email, password) => {
        const authenticated = await apiRegister(email, password);
        setUser(authenticated);
        setStatus('authenticated');
      },
      signOut: async () => {
        try {
          await apiLogout();
        } finally {
          setAccessToken(null);
          setUser(null);
          setStatus('guest');
        }
      },
    }),
    [status, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an <AuthProvider>.');
  }
  return context;
}
