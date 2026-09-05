import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import ThemeToggle from '../components/ThemeToggle';

/**
 * Page protégée minimale (placeholder) : vérifie que l'utilisateur est bien
 * authentifié. Pas de dashboard financier pour l'instant.
 */
export default function HomePage() {
  const { status, user, signOut } = useAuth();

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-100 text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        Restauration de session…
      </div>
    );
  }

  if (status === 'guest') {
    return <Navigate to="/login" replace />;
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-100 p-6 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <section className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Finance</h1>
          <ThemeToggle />
        </div>
        <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-300">
          Connecté en tant que <span className="font-medium text-neutral-900 dark:text-neutral-100">{user?.email}</span>
        </p>

        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-6 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
        >
          Se déconnecter
        </button>
      </section>
    </main>
  );
}
