import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AccountPublic,
  TransactionCreate,
  TransactionType,
} from '@finance/shared-types';
import { useAuth } from '../auth/AuthContext';
import {
  apiCreateTransaction,
  apiDeleteTransaction,
  apiGetAccountLedger,
  apiGetAccounts,
} from '../auth/api';
import { ThemeToggle } from '../components/ThemeToggle';
import {
  ACCOUNT_TYPE_LABELS,
  formatMoney,
  formatSignedMoney,
  toISODate,
} from '../lib/format';

/** Compte proposé par défaut à l'ouverture de la page (Banque si présente). */
function pickDefaultAccount(
  accounts: AccountPublic[],
): AccountPublic | undefined {
  const priority = [
    'BANK',
    'MVOLA',
    'CASH',
    'ORANGE_MONEY',
    'AIRTEL_MONEY',
    'SAVINGS',
  ];
  for (const type of priority) {
    const match = accounts.find((a) => a.type === type);
    if (match) {
      return match;
    }
  }
  return accounts[0];
}

export default function TransactionsPage() {
  const { status, user, signOut } = useAuth();
  const queryClient = useQueryClient();

  const [accountId, setAccountId] = useState('');
  const [type, setType] = useState<TransactionType>('EXPENSE');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [occurredAt, setOccurredAt] = useState(() => toISODate(new Date()));

  const accountsQuery = useQuery({
    queryKey: ['dashboard'],
    queryFn: apiGetAccounts,
    enabled: status === 'authenticated',
  });
  const accounts = accountsQuery.data?.accounts ?? [];

  // Première ouverture : présélectionne un compte (Banque si disponible).
  useEffect(() => {
    if (!accountId && accounts.length > 0) {
      const preferred = pickDefaultAccount(accounts);
      setAccountId(preferred?.id ?? accounts[0]?.id ?? '');
    }
  }, [accountId, accounts]);

  const ledgerQuery = useQuery({
    queryKey: ['transactions', accountId],
    queryFn: () => apiGetAccountLedger(accountId),
    enabled: status === 'authenticated' && accountId !== '',
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    if (accountId) {
      void queryClient.invalidateQueries({
        queryKey: ['transactions', accountId],
      });
    }
  }

  const createMutation = useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: TransactionCreate;
    }) => apiCreateTransaction(id, input),
    onSuccess: () => {
      // Réinitialise le formulaire pour une saisie rapide de l'opération suivante.
      setAmount('');
      setDescription('');
      setOccurredAt(toISODate(new Date()));
      refresh();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({
      id,
      transactionId,
    }: {
      id: string;
      transactionId: string;
    }) => apiDeleteTransaction(id, transactionId),
    onSuccess: refresh,
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = description.trim();
    createMutation.mutate({
      id: accountId,
      input: {
        type,
        amount: amount.trim(),
        occurredAt,
        ...(trimmed !== '' ? { description: trimmed } : {}),
      },
    });
  }

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

  const currency =
    ledgerQuery.data?.account.currency ??
    accountsQuery.data?.currency ??
    'MGA';
  const ledgerAccount = ledgerQuery.data?.account;

  const requestError =
    createMutation.error ??
    deleteMutation.error ??
    accountsQuery.error ??
    ledgerQuery.error;

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
          <Link
            to="/"
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            Accueil
          </Link>
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

      <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
        <h2 className="text-2xl font-semibold">Transactions</h2>

        {/* Sélecteur de compte + solde courant dérivé */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div className="flex flex-col gap-1">
              <label
                htmlFor="account-select"
                className="text-sm text-neutral-500 dark:text-neutral-400"
              >
                Compte
              </label>
              {accounts.length === 0 && accountsQuery.isLoading ? (
                <span className="text-sm text-neutral-400">
                  Chargement des comptes…
                </span>
              ) : (
                <select
                  id="account-select"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {ACCOUNT_TYPE_LABELS[account.type]}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="text-right">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                Solde actuel du compte
              </p>
              <p
                className={`text-2xl font-semibold tabular-nums ${
                  ledgerAccount && ledgerAccount.balance.startsWith('-')
                    ? 'text-red-600 dark:text-red-400'
                    : ''
                }`}
              >
                {ledgerAccount
                  ? formatMoney(ledgerAccount.balance, currency)
                  : '…'}
              </p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                Solde de départ :{' '}
                {ledgerAccount
                  ? formatMoney(ledgerAccount.initialBalance, currency)
                  : '…'}
              </p>
            </div>
          </div>
        </section>

        {/* Formulaire d'ajout d'une opération */}
        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
        >
          <fieldset>
            <legend className="sr-only">Type d'opération</legend>
            <div className="inline-flex rounded-lg border border-neutral-300 p-1 dark:border-neutral-700">
              {(['EXPENSE', 'INCOME'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  aria-pressed={type === t}
                  className={`rounded-md px-4 py-1.5 text-sm font-medium ${
                    type === t
                      ? t === 'EXPENSE'
                        ? 'bg-red-600 text-white'
                        : 'bg-emerald-600 text-white'
                      : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'
                  }`}
                >
                  {t === 'EXPENSE' ? 'Dépense' : 'Revenu'}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label
                htmlFor="amount"
                className="text-sm text-neutral-500 dark:text-neutral-400"
              >
                Montant
              </label>
              <input
                id="amount"
                type="text"
                inputMode="decimal"
                autoFocus
                required
                value={amount}
                onChange={(e) =>
                  setAmount(e.target.value.replace(/[^\d.]/g, ''))
                }
                placeholder="15000"
                className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-right text-sm tabular-nums dark:border-neutral-700 dark:bg-neutral-950"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label
                htmlFor="date"
                className="text-sm text-neutral-500 dark:text-neutral-400"
              >
                Date
              </label>
              <input
                id="date"
                type="date"
                required
                value={occurredAt}
                onChange={(e) => setOccurredAt(e.target.value)}
                className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
              />
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-1">
            <label
              htmlFor="description"
              className="text-sm text-neutral-500 dark:text-neutral-400"
            >
              Libellé <span className="text-neutral-400">(optionnel)</span>
            </label>
            <input
              id="description"
              type="text"
              maxLength={120}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Ex. Courses, salaire, transport…"
              className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </div>

          {requestError && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">
              {requestError instanceof Error
                ? requestError.message
                : 'Une erreur est survenue.'}
            </p>
          )}

          <button
            type="submit"
            disabled={createMutation.isPending || deleteMutation.isPending}
            className="mt-5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Enregistrer
          </button>
        </form>

        {/* Totaux par sens */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/40">
            <p className="text-xs text-emerald-700 dark:text-emerald-300">
              Total des revenus
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
              {ledgerQuery.data
                ? formatMoney(ledgerQuery.data.totals.incomes, currency)
                : '…'}
            </p>
          </div>
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
            <p className="text-xs text-red-700 dark:text-red-300">
              Total des dépenses
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-red-700 dark:text-red-300">
              {ledgerQuery.data
                ? formatMoney(ledgerQuery.data.totals.expenses, currency)
                : '…'}
            </p>
          </div>
        </div>

        {/* Liste des opérations */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <h3 className="text-sm font-semibold text-neutral-500 dark:text-neutral-400">
            Opérations
          </h3>
          {ledgerQuery.isLoading && (
            <p className="mt-3 text-sm text-neutral-400">Chargement…</p>
          )}
          {ledgerQuery.data &&
            ledgerQuery.data.transactions.length === 0 && (
              <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
                Aucune opération enregistrée sur ce compte.
              </p>
            )}
          {ledgerQuery.data && ledgerQuery.data.transactions.length > 0 && (
            <ul className="mt-2">
              {ledgerQuery.data.transactions.map((tx) => (
                <li
                  key={tx.id}
                  className="flex items-center justify-between gap-3 border-t border-neutral-200 py-3 first:border-t-0 dark:border-neutral-800"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm text-neutral-800 dark:text-neutral-100">
                      {tx.description ?? 'Sans libellé'}
                    </span>
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">
                      {tx.occurredAt}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span
                      className={`text-sm font-semibold tabular-nums ${
                        tx.type === 'EXPENSE'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-emerald-600 dark:text-emerald-400'
                      }`}
                    >
                      {formatSignedMoney(tx.amount, tx.type, currency)}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        deleteMutation.mutate({
                          id: accountId,
                          transactionId: tx.id,
                        })
                      }
                      disabled={deleteMutation.isPending}
                      aria-label={`Supprimer l'opération ${tx.description ?? 'sans libellé'} du ${tx.occurredAt}`}
                      className="rounded-lg border border-neutral-300 px-2 py-1 text-xs text-neutral-500 hover:bg-red-50 hover:text-red-600 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                    >
                      Supprimer
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="text-xs text-neutral-500 dark:text-neutral-500">
          Le solde du compte est recalculé automatiquement : solde de départ +
          revenus − dépenses. Supprimez une opération pour corriger une saisie.
        </p>
      </div>
    </main>
  );
}
