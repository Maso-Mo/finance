import { useMemo, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ACCOUNT_TYPES, CURRENCIES } from '@finance/shared-types';
import type { AccountPublic, Currency } from '@finance/shared-types';
import { useAuth } from '../auth/AuthContext';
import {
  apiGetAccounts,
  apiGetReminders,
  apiSetCurrency,
  apiSetTargetBalance,
} from '../auth/api';
import { ThemeToggle } from '../components/ThemeToggle';
import { ACCOUNT_TYPE_LABELS, currencyName, formatMoney, toISODate } from '../lib/format';

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
  // Valeur initiale du champ = solde COURANT connu (le backend décidera s'il
  // faut corriger le solde de départ ou créer un ajustement).
  const [value, setValue] = useState(account.balance);

  function startEditing() {
    setValue(account.balance);
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
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
            {ACCOUNT_TYPE_LABELS[account.type]}
          </span>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            Solde de départ : {formatMoney(account.initialBalance, currency)}
          </span>
        </div>
        {!editing ? (
          <div className="flex items-center gap-3">
            <span
              className={`text-sm font-semibold tabular-nums ${
                account.balance.startsWith('-')
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-neutral-700 dark:text-neutral-200'
              }`}
            >
              {formatMoney(account.balance, currency)}
            </span>
            <button
              type="button"
              onClick={startEditing}
              title="Déclarer le solde réel : corrige le solde de départ (si aucun mouvement) ou crée un ajustement"
              className="rounded-lg border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Corriger le solde
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
      apiSetTargetBalance(id, balance),
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

  // Rappels « Payé ? » (étape 6) : comptés sur le jour LOCAL du navigateur.
  const remindersQuery = useQuery({
    queryKey: ['reminders'],
    queryFn: () => apiGetReminders(toISODate(new Date())),
    enabled: status === 'authenticated',
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

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              aria-expanded={showDetails}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white"
            >
              {showDetails ? 'Masquer les détails' : 'Détails'}
            </button>
            <Link
              to="/transactions"
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              Transactions
            </Link>
            <Link
              to="/budgets"
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              Budgets
            </Link>
            <Link
              to="/transfers"
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              Transferts
            </Link>
            <Link
              to="/savings"
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              Épargne
            </Link>
          </div>

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

        <section className="mt-4 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                Paiements à confirmer
              </p>
              {remindersQuery.data ? (
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {remindersQuery.data.overdue.length +
                    remindersQuery.data.dueToday.length +
                    remindersQuery.data.upcoming.length}
                </p>
              ) : (
                <p className="mt-1 text-2xl font-semibold">…</p>
              )}
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                {remindersQuery.data ? (
                  <>
                    {remindersQuery.data.overdue.length > 0 &&
                      `${remindersQuery.data.overdue.length} en retard · `}
                    {remindersQuery.data.dueToday.length > 0 &&
                      `${remindersQuery.data.dueToday.length} aujourd'hui · `}
                    {remindersQuery.data.upcoming.length > 0 &&
                      `${remindersQuery.data.upcoming.length} bientôt`}
                  </>
                ) : null}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Link
                to="/expected"
                className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                Revenus à venir
              </Link>
              <Link
                to="/planned"
                className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                Dépenses à venir
              </Link>
            </div>
          </div>
        </section>

        <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-500">
          Chaque solde affiché est dérivé : solde de départ + revenus − dépenses
          (journal) + ajustements. L’épargne apparaît dans Détails mais n’est
          pas incluse dans le Total disponible. « Corriger le solde » ajuste le
          solde de départ tant qu’aucun mouvement n’existe ; ensuite il crée un
          ajustement (jamais une fausse dépense/revenu). Enregistrez vos
          opérations dans la page Transactions.
        </p>
      </div>
    </main>
  );
}
