import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AccountPublic,
  Currency,
  TransactionPublic,
  TransactionType,
  TransactionUpsert,
} from '@finance/shared-types';
import { useAuth } from '../auth/AuthContext';
import {
  apiCreateTransaction,
  apiDeleteTransaction,
  apiGetAccounts,
  apiGetCategories,
  apiGetTransactions,
  apiUpdateTransaction,
} from '../auth/api';
import { ThemeToggle } from '../components/ThemeToggle';
import TransactionForm from '../components/TransactionForm';
import {
  ACCOUNT_TYPE_LABELS,
  formatMoney,
  formatSignedMoney,
} from '../lib/format';

const PAGE_SIZE = 20;

function dateHuman(value: string | null): string {
  if (!value) {
    return 'Date ?';
  }
  return new Date(`${value}T00:00:00`).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** « MVola 400 000 Ar + Cash 200 000 Ar » ou « Compte ? ». */
function describeAccounts(tx: TransactionPublic, currency: Currency): string {
  if (tx.accountUnknown || tx.allocations.length === 0) {
    return 'Compte ?';
  }
  return tx.allocations
    .map((allocation) => {
      const label = ACCOUNT_TYPE_LABELS[allocation.accountType];
      return `${label} ${formatMoney(allocation.amount, currency)}`;
    })
    .join(' + ');
}

function typeLabel(type: TransactionType): string {
  return type === 'EXPENSE' ? 'Dépense' : 'Revenu';
}

function describeMeta(tx: TransactionPublic, currency: Currency): string {
  const parts = [dateHuman(tx.occurredAt), typeLabel(tx.type)];
  if (tx.type === 'EXPENSE') {
    parts.push(
      tx.category ? tx.category.name : tx.categoryUnknown ? 'Catégorie ?' : '—',
    );
  }
  parts.push(describeAccounts(tx, currency));
  return parts.join(' · ');
}

export default function TransactionsPage() {
  const { status, user, signOut } = useAuth();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TransactionPublic | null>(null);
  const [deletePending, setDeletePending] = useState<TransactionPublic | null>(null);
  const [formKey, setFormKey] = useState(0);

  const accountsQuery = useQuery({
    queryKey: ['dashboard'],
    queryFn: apiGetAccounts,
    enabled: status === 'authenticated',
  });
  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: apiGetCategories,
    enabled: status === 'authenticated',
  });
  const ledgerQuery = useQuery({
    queryKey: ['transactions', page],
    queryFn: () => apiGetTransactions(page, PAGE_SIZE),
    enabled: status === 'authenticated',
  });

  function refreshAfterMutation() {
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    void queryClient.invalidateQueries({ queryKey: ['transactions'] });
  }

  const saveMutation = useMutation({
    mutationFn: ({
      transactionId,
      input,
    }: {
      transactionId: string | null;
      input: TransactionUpsert;
    }) =>
      transactionId
        ? apiUpdateTransaction(transactionId, input)
        : apiCreateTransaction(input),
    onSuccess: () => {
      setFormOpen(false);
      setEditing(null);
      setFormKey((k) => k + 1);
      setPage(1);
      refreshAfterMutation();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (transactionId: string) => apiDeleteTransaction(transactionId),
    onSuccess: () => {
      setDeletePending(null);
      setPage(1);
      refreshAfterMutation();
    },
  });

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

  const accounts: AccountPublic[] = accountsQuery.data?.accounts ?? [];
  const currency: Currency = accountsQuery.data?.currency ?? 'MGA';
  const categories = categoriesQuery.data?.categories ?? [];
  const ledger = ledgerQuery.data;

  function openCreate() {
    setEditing(null);
    setFormKey((k) => k + 1);
    setFormOpen(true);
  }

  function openEdit(transaction: TransactionPublic) {
    setEditing(transaction);
    setFormOpen(true);
  }

  const loadingLedger = ledgerQuery.isLoading || !ledger;

  return (
    <main className="min-h-screen bg-neutral-100 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/"
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            Accueil
          </Link>
          <h1 className="text-lg font-semibold">Transactions</h1>
          <span className="hidden text-xs text-neutral-500 sm:inline dark:text-neutral-400">
            {user?.email}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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

      <div className="mx-auto max-w-3xl px-4 py-8">
        {!formOpen && !editing && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={openCreate}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Nouvelle opération
            </button>
          </div>
        )}

        {formOpen && accounts.length > 0 && categories.length > 0 && (
          <div className="mb-6">
            <TransactionForm
              key={editing?.id ?? `new-${formKey}`}
              accounts={accounts}
              categories={categories}
              currency={currency}
              editing={editing}
              isSubmitting={saveMutation.isPending}
              submitError={
                saveMutation.isError
                  ? saveMutation.error instanceof Error
                    ? saveMutation.error.message
                    : 'Échec de l’enregistrement.'
                  : null
              }
              onCancel={() => {
                setFormOpen(false);
                setEditing(null);
              }}
              onSubmit={(input) =>
                saveMutation.mutate({
                  transactionId: editing?.id ?? null,
                  input,
                })
              }
            />
          </div>
        )}

        {deletePending && (
          <section
            role="dialog"
            aria-modal="true"
            className="mb-6 rounded-2xl border border-red-200 bg-white p-5 shadow-sm dark:border-red-900 dark:bg-neutral-900"
          >
            <h2 className="text-base font-semibold text-red-700 dark:text-red-300">
              Supprimer cette opération ?
            </h2>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
              {deletePending.description ?? 'Sans libellé'} ·{' '}
              {formatSignedMoney(deletePending.amount, deletePending.type, currency)} ·{' '}
              {describeAccounts(deletePending, currency)}
            </p>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              La transaction est supprimée logiquement : elle disparaît de
              l’historique et les soldes sont recalculés.
            </p>
            {deleteMutation.isError && (
              <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                {deleteMutation.error instanceof Error
                  ? deleteMutation.error.message
                  : 'Échec de la suppression.'}
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate(deletePending.id)}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                {deleteMutation.isPending ? 'Suppression…' : 'Confirmer la suppression'}
              </button>
              <button
                type="button"
                disabled={deleteMutation.isPending}
                onClick={() => setDeletePending(null)}
                className="rounded-lg border border-neutral-300 px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                Annuler
              </button>
            </div>
          </section>
        )}

        <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Historique</h2>
            {ledger && (
              <div className="flex flex-wrap gap-3 text-sm">
                <span className="text-emerald-600 dark:text-emerald-400">
                  Revenus : {formatMoney(ledger.totals.incomes, currency)}
                </span>
                <span className="text-red-600 dark:text-red-400">
                  Dépenses : {formatMoney(ledger.totals.expenses, currency)}
                </span>
              </div>
            )}
          </div>

          {loadingLedger && (
            <p className="mt-4 text-sm text-neutral-400">Chargement…</p>
          )}
          {ledger && ledger.transactions.length === 0 && (
            <p className="mt-4 text-sm text-neutral-500 dark:text-neutral-400">
              Aucune opération enregistrée. Ajoutez votre première dépense ou
              votre premier revenu.
            </p>
          )}
          {ledger && ledger.transactions.length > 0 && (
            <ul className="mt-3">
              {ledger.transactions.map((tx) => (
                <li
                  key={tx.id}
                  className="flex items-start justify-between gap-3 border-t border-neutral-200 py-3 first:border-t-0 dark:border-neutral-800"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate text-sm text-neutral-800 dark:text-neutral-100">
                      {tx.description ?? 'Sans libellé'}
                    </span>
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">
                      {describeMeta(tx, currency)}
                    </span>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span
                      className={`text-sm font-semibold tabular-nums ${
                        tx.type === 'EXPENSE'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-emerald-600 dark:text-emerald-400'
                      }`}
                    >
                      {formatSignedMoney(tx.amount, tx.type, currency)}
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={deleteMutation.isPending}
                        onClick={() => openEdit(tx)}
                        className="rounded-lg border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                      >
                        Modifier
                      </button>
                      <button
                        type="button"
                        disabled={deleteMutation.isPending}
                        onClick={() => setDeletePending(tx)}
                        className="rounded-lg border border-neutral-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-neutral-700 dark:text-red-400 dark:hover:bg-red-950/40"
                      >
                        Supprimer
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {ledger && ledger.transactions.length > 0 && (
            <div className="mt-4 flex items-center justify-between border-t border-neutral-200 pt-3 dark:border-neutral-800">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="rounded-lg border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                Précédent
              </button>
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                Page {page}
              </span>
              <button
                type="button"
                disabled={!ledger.hasMore}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-lg border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                Suivant
              </button>
            </div>
          )}
        </section>

        <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-500">
          Une opération peut être ventilée sur plusieurs comptes (la somme des
          parts doit couvrir exactement le montant). Toute écriture est
          confirmée avant enregistrement, et la suppression est logique.
        </p>
      </div>
    </main>
  );
}
