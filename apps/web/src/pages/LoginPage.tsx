import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ApiError } from '../auth/api';
import { useAuth } from '../auth/AuthContext';
import { ThemeToggle } from '../components/ThemeToggle';

/**
 * Connexion — design produit (fond sombre premium, accent lime), sans aucune
 * promesse bancaire : Finance enregistre des opérations, elle n’envoie rien.
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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-5 py-10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full opacity-60"
        style={{ background: 'radial-gradient(circle, var(--brand-soft) 0%, transparent 65%)' }}
      />
      <div className="relative w-full max-w-[420px]">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span
              className="flex h-10 w-10 items-center justify-center rounded-2xl text-lg font-black text-brand-ink"
              style={{ background: 'var(--brand)' }}
            >
              F
            </span>
            <span className="text-xl font-bold tracking-tight text-ink">Finance</span>
          </div>
          <ThemeToggle />
        </div>

        <form
          onSubmit={handleSubmit}
          className="card flex flex-col gap-4 p-6 sm:p-8"
        >
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink">
              Bon retour
            </h1>
            <p className="mt-1 text-sm text-ink2">
              Retrouvez votre situation en quelques secondes.
            </p>
          </div>

          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            Email
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="field"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            Mot de passe
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="field"
            />
          </label>

          {error && (
            <p className="rounded-xl px-3 py-2 text-sm font-medium text-[var(--danger)]" role="alert"
              style={{ background: 'color-mix(in srgb, var(--danger) 10%, transparent)' }}
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="btn btn-primary w-full"
          >
            {submitting ? 'Connexion…' : 'Se connecter'}
          </button>

          <p className="mt-1 text-center text-sm text-ink2">
            Pas de compte ?{' '}
            <Link to="/register" className="font-semibold text-brand-strong">
              S’inscrire
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
