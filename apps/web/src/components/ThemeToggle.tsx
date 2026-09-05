import { useTheme, type ThemePreference } from '../theme';

const OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'light', label: 'Clair' },
  { value: 'dark', label: 'Sombre' },
  { value: 'system', label: 'Système' },
];

/** Sélecteur de thème (clair / sombre / système), mémorisé localement. */
export default function ThemeToggle() {
  const { preference, setPreference } = useTheme();

  return (
    <div className="flex items-center gap-1">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => setPreference(option.value)}
          aria-pressed={preference === option.value}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            preference === option.value
              ? 'border-indigo-500 bg-indigo-500 text-white'
              : 'border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
