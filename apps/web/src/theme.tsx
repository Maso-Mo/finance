import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Système de thème minimal (design system).
 *
 * Trois préférences utilisateur : 'light', 'dark', 'system'.
 * La classe CSS `.dark` est posée sur <html> quand le thème résolu est sombre
 * (Tailwind v4 pilote le dark mode via cette classe — voir src/index.css).
 *
 * Le choix est mémorisé dans localStorage. Il s'agit d'une préférence UI
 * (pas un secret d'authentification : aucun token n'est stocké ici).
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'finance.theme-preference';
const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

function getStoredPreference(): ThemePreference {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system'
    ? stored
    : 'system';
}

function getSystemDark(): boolean {
  return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedTheme {
  if (preference === 'system') {
    return systemDark ? 'dark' : 'light';
  }
  return preference;
}

function applyThemeClass(theme: ResolvedTheme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] =
    useState<ThemePreference>(getStoredPreference);
  const [systemDark, setSystemDark] = useState<boolean>(getSystemDark);

  // Suit les changements du thème du système d'exploitation.
  useEffect(() => {
    const mediaQuery = window.matchMedia(DARK_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) =>
      setSystemDark(event.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const resolved = resolveTheme(preference, systemDark);

  // Applique la classe `.dark` chaque fois que le thème résolu change.
  useEffect(() => {
    applyThemeClass(resolved);
  }, [resolved]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolved,
      setPreference: (next) => {
        window.localStorage.setItem(STORAGE_KEY, next);
        setPreferenceState(next);
      },
    }),
    [preference, resolved],
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
