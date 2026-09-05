import { useMemo, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ACCOUNT_TYPES, CURRENCIES } from '@finance/shared-types';
import type { AccountPublic, Currency } from '@finance/shared-types';
import { useAuth } from '../auth/AuthContext';
import {
  apiGetAccounts,
  apiSetCurrency,
  apiUpdateInitialBalance,
} from '../auth/api';
import { ThemeToggle } from '../components/ThemeToggle';
import { ACCOUNT_TYPE_LABELS, currencyName, formatMoney } from '../lib/format';

function AccountRow({
  account,
  currency,
  onUpdate,
}: {
  account: AccountPublic;
  currency: Currency;
  onUpdate: (accountId: string, value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(account.initialBalance);

  function startEditing() {
    setValue(account.initialBalance);
    setEditing(true);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    onUpdate(account.id, trimmed);
    setEditing(false);
  }

  return (
    <li className="flex flex-col gap-2 border-t border-neutral-200 py-3 first:border-t-0 dark:border-neutral-800">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
          {ACCOUNT_TYPE_LABELS[account.type]}
        </span>
        {!editing ? (
          <div className="flex items-center gap-3">
            <span className="text-sm tabular-nums text-neutral-700 dark:text-neutral-200">
              {formatMoney(account.initialBalance, currency)}
            </span>
            <button
              type="button"
              onClick={startEditing}
              className="rounded-lg border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Modifier
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex items-center gap-2">
            <input
              type="text"
              inputMode="decimal"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ''))}
              className="w-36 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-right text-sm tabular-nums dark:border-neutral-700 dark:bg-neutral-950"
            />
            <button
              type="submit"
              className="rounded-lg bg-indigo-600 px-2 py-1 text-xs font-medium text-white"
            >
              OK
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-lg border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Annuler
            </button>
          </form>
        )}
      </div>
    </li>
  );
}

export default function HomePage() {
  const { status, user, signOut } = useAuth();
  const queryClient = useQueryClient();
  const [showDetails, setShowDetails] = useState(false);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: apiGetAccounts,
    enabled: status === 'authenticated',
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, balance }: { id: string; balance: string }) =>
      apiUpdateInitialBalance(id, balance),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const currencyMutation = useMutation({
    mutationFn: apiSetCurrency,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const accounts = useMemo(() => {
    if (!data) {
      return [];
    }
    return ACCOUNT_TYPES.map((type) =>
      data.accounts.find((a) => a.type === type),
    ).filter((a): a is AccountPublic => Boolean(a));
  }, [data]);

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

  const currency = data?.currency ?? 'MGA';
  const totalAvailable = data?.totalAvailable ?? '0';

  return (
    <main className="min-h-screen bg-neutral-100 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Finance</h1>
          <span className="hidden text-xs text-neutral-500 sm:inline dark:text-neutral-400">
            {user?.email}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="currency-select">
            Devise principale
          </label>
          <select
            id="currency-select"
            value={currency}
            disabled={currencyMutation.isPending}
            onChange={(e) => currencyMutation.mutate(e.target.value as Currency)}
            className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-900"
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {currencyName(c)}
              </option>
            ))}
          </select>
          <ThemeToggle />
          <button
            type="button"
            onClick={() => void signOut()}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            Déconnexion
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-2xl px-4 py-8">
        <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Total disponible
          </p>
          <p className="mt-1 text-3xl font-semibold tabular-nums sm:text-4xl">
            {isLoading ? '…' : formatMoney(totalAvailable, currency)}
          </p>

          {isError && (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">
              {error instanceof Error ? error.message : 'Erreur de chargement.'}
            </p>
          )}

          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails}
            className="mt-6 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white"
          >
            {showDetails ? 'Masquer les détails' : 'Détails'}
          </button>

          {showDetails && (
            <ul className="mt-4">
              {accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  currency={currency}
                  onUpdate={(id, balance) => updateMutation.mutate({ id, balance })}
                />
              ))}
            </ul>
          )}
        </section>

        <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-500">
          L’épargne apparaît dans Détails mais n’est pas incluse dans le Total
          disponible. Soldes saisis manuellement (solde initial).
        </p>
      </div>
    </main>
  );
}
