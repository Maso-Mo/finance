import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * Système de thème (design system).
 *
 * Deux notions distinctes :
 *  - `choice` : choix EXPLICITE mémorisé par l'utilisateur ('light' | 'dark').
 *    Une absence de choix (null) signifie « suivre le thème du système ».
 *  - `resolved` : thème réellement appliqué, toujours 'light' ou 'dark'.
 *
 * Règles :
 *  - aucun choix mémorisé → on suit `prefers-color-scheme` ;
 *  - choix mémorisé = light → toujours clair (indépendant du système) ;
 *  - choix mémorisé = dark → toujours sombre (indépendant du système).
 *
 * Il n'existe AUCUN état utilisateur « system » : l'absence de valeur stockée
 * EST le mode système. Une ancienne valeur legacy 'system' est donc lue comme
 * « aucun choix explicite ».
 *
 * La classe CSS `.dark` est posée sur <html> quand le thème résolu est sombre
 * (Tailwind v4 pilote le dark mode via cette classe — voir src/index.css).
 * Le choix est mémorisé dans localStorage : simple préférence UI, non sensible
 * (aucun token d'authentification n'est stocké ici).
 */

export type ThemeChoice = 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'finance.theme-preference';
export const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

/** Seule 'light' / 'dark' est une préférence explicite valide. */
export function parseStoredChoice(raw: string | null): ThemeChoice | null {
  return raw === 'light' || raw === 'dark' ? raw : null;
}

/** Choix explicite absent → suivre le système. */
export function resolveTheme(
  choice: ThemeChoice | null,
  systemDark: boolean,
): ResolvedTheme {
  return choice ?? (systemDark ? 'dark' : 'light');
}

function readStoredChoice(): ThemeChoice | null {
  try {
    return parseStoredChoice(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

function getSystemDark(): boolean {
  try {
    return window.matchMedia(DARK_MEDIA_QUERY).matches;
  } catch {
    return false;
  }
}

function applyThemeClass(theme: ResolvedTheme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

interface ThemeContextValue {
  /** null = aucun choix explicite mémorisé → suivre le système. */
  choice: ThemeChoice | null;
  resolved: ResolvedTheme;
  setChoice: (next: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice | null>(readStoredChoice);
  const [systemDark, setSystemDark] = useState<boolean>(getSystemDark);
  const transitionTimer = useRef<number | null>(null);

  // Suit le thème du système. Cela n'a d'effet que tant qu'aucun choix
  // explicite n'est mémorisé : resolveTheme ignore systemDark dès qu'un choix
  // existe.
  useEffect(() => {
    const mediaQuery = window.matchMedia(DARK_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) =>
      setSystemDark(event.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const resolved = resolveTheme(choice, systemDark);

  // Applique `.dark`, avec une transition de couleurs douce lorsque le thème
  // change réellement. Au premier rendu la classe est déjà correcte (script
  // inline de index.html) : on évite donc une transition parasite au démarrage.
  useEffect(() => {
    const root = document.documentElement;
    const alreadyApplied = root.classList.contains('dark') === (resolved === 'dark');

    if (alreadyApplied) {
      return;
    }

    if (transitionTimer.current !== null) {
      window.clearTimeout(transitionTimer.current);
      transitionTimer.current = null;
    }

    root.classList.add('theme-transition');
    applyThemeClass(resolved);
    transitionTimer.current = window.setTimeout(() => {
      root.classList.remove('theme-transition');
      transitionTimer.current = null;
    }, 300);
  }, [resolved]);

  // Nettoyage du minuteur si le provider est démonté.
  useEffect(() => {
    return () => {
      if (transitionTimer.current !== null) {
        window.clearTimeout(transitionTimer.current);
        transitionTimer.current = null;
      }
    };
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      choice,
      resolved,
      setChoice: (next) => {
        try {
          window.localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch {
          // Stockage indisponible (ex. navigation privée) : l'app continue.
        }
        setChoiceState(next);
      },
    }),
    [choice, resolved],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a <ThemeProvider>.');
  }
  return context;
}
