import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ApiError } from '../auth/api';
import { useAuth } from '../auth/AuthContext';
import { ThemeToggle } from '../components/ThemeToggle';

/**
 * Écran minimal de connexion (aucun design financier).
 */
export default function LoginPage() {
  const { status, signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'authenticated') {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Connexion impossible.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-neutral-100 p-6 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto flex max-w-md flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Finance — connexion</h1>
          <ThemeToggle />
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
        >
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            Mot de passe
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {submitting ? 'Connexion…' : 'Se connecter'}
          </button>

          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            Pas de compte ? <Link to="/register" className="text-indigo-600 dark:text-indigo-400">S'inscrire</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
