import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import {
  apiCompleteOnboarding,
  apiGetOnboarding,
} from '../auth/api';

/**
 * Prise en main guidée — état d'interface, ZÉRO écriture tant que
 * l'utilisateur n'a pas cliqué « Terminer » (POST idempotent).
 *
 * - GET /me/onboarding est appelé une seule fois par session, après la
 *   restauration de session (état authentifié). Si le backend est
 *   indisponible, on ne force jamais le guide.
 * - Le guide démarre automatiquement à l'accueil pour une première
 *   utilisation (completed = false). Fermer le guide ne persiste rien.
 * - `start()` (relance manuelle depuis « Plus ») fonctionne même après
 *   complétion et ne réinitialise aucun état.
 */

interface OnboardingContextValue {
  open: boolean;
  completed: boolean;
  /** Relance manuelle (depuis n'importe quelle page) : retour à l'accueil. */
  start: () => void;
  /** Ferme le guide sans rien persister. */
  close: () => void;
  /** Termine : POST idempotent, mémorise la date, ferme le guide. */
  complete: () => Promise<void>;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { status: authStatus, user } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [wantsAutoStart, setWantsAutoStart] = useState(false);

  const checkedUserRef = useRef<string | null>(null);
  const autoShownRef = useRef(false);
  const openTimerRef = useRef<number | null>(null);

  // 1) Statut serveur (une fois par utilisateur et par session).
  useEffect(() => {
    if (authStatus !== 'authenticated' || !user) {
      checkedUserRef.current = null; autoShownRef.current = false;
      setOpen(false); setWantsAutoStart(false);
      return;
    }
    if (checkedUserRef.current === user.id) return;
    checkedUserRef.current = user.id;

    let active = true;
    apiGetOnboarding()
      .then((status) => {
        if (!active) return;
        setCompleted(status.completed);
        // Première utilisation : on prépare le démarrage automatique.
        if (!status.completed) setWantsAutoStart(true);
      })
      .catch(() => {
        // Backend injoignable : le guide n'est pas imposé.
      });
    return () => {
      active = false;
      checkedUserRef.current = null;
    };
  }, [authStatus, user?.id, user]);

  // 2) Démarrage automatique, uniquement à l'accueil, une seule fois.
  // NB : on ne repasse pas `wantsAutoStart` à false ici — le ref
  // `autoShownRef` suffit à empêcher tout second déclenchement, et le
  // timer ne serait sinon pas nettoyé immédiatement (l'effet se relancerait
  // et annulerait le démarrage automatique avant son déclenchement).
  useEffect(() => {
    if (!wantsAutoStart || autoShownRef.current) return;
    if (pathname !== '/') return;

    openTimerRef.current = window.setTimeout(() => {
      // Laisse le temps au contenu de l'accueil de se monter.
      autoShownRef.current = true;
      setOpen(true);
    }, 450);
    return () => {
      if (openTimerRef.current !== null) {
        window.clearTimeout(openTimerRef.current);
        openTimerRef.current = null;
      }
    };
  }, [wantsAutoStart, pathname]);

  // Nettoyage final.
  useEffect(() => {
    return () => {
      if (openTimerRef.current !== null) {
        window.clearTimeout(openTimerRef.current);
      }
    };
  }, []);

  const start = useCallback(() => {
    if (pathname !== '/') {
      navigate('/');
    }
    // Si l'accueil vient d'être demandé, ses ancres n'existent pas encore.
    const delay = pathname === '/' ? 0 : 400;
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
    }
    openTimerRef.current = window.setTimeout(() => setOpen(true), delay);
  }, [pathname, navigate]);

  const close = useCallback(() => setOpen(false), []);

  const complete = useCallback(async () => {
    await apiCompleteOnboarding();
    setCompleted(true);
    setOpen(false);
  }, []);

  const value = useMemo<OnboardingContextValue>(
    () => ({ open, completed, start, close, complete }),
    [open, completed, start, close, complete],
  );

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding(): OnboardingContextValue {
  const context = useContext(OnboardingContext);
  if (!context) {
    throw new Error('useOnboarding must be used within an <OnboardingProvider>.');
  }
  return context;
}
