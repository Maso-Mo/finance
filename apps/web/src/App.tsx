import { useTheme, type ThemePreference } from './theme';

const OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'light', label: 'Clair' },
  { value: 'dark', label: 'Sombre' },
  { value: 'system', label: 'Système' },
];

/**
 * Écran minimal de vérification du socle technique.
 *
 * Aucune fonctionnalité métier Finance : on vérifie seulement que React,
 * Tailwind (clair/sombre) et le système de thème démarrent correctement.
 * Le design du dashboard arrive à une étape ultérieure.
 */
export default function App() {
  const { preference, resolved, setPreference } = useTheme();

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <section className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-50">
          Finance — socle technique
        </h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
          Étape 1 : React + Vite + Tailwind + TanStack Query opérationnels.
          Les deux thèmes (clair / sombre) sont fonctionnels dès maintenant.
        </p>

        <div className="mt-6">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Thème appliqué : {resolved === 'dark' ? 'sombre' : 'clair'}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setPreference(option.value)}
                aria-pressed={preference === option.value}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                  preference === option.value
                    ? 'border-indigo-500 bg-indigo-500 text-white'
                    : 'border-neutral-300 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
