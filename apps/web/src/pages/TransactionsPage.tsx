import { useState } from 'react';
import { Navigate } from 'react-router-dom';
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
import TransactionForm from '../components/TransactionForm';
import { Dialog } from '../components/overlay';
import { Button, cx, IconBadge, PageHeader, Panel } from '../components/ui';
import { IconArrowDown, IconArrowUp, IconPlus } from '../components/icons';
import { ACCOUNT_TYPE_LABELS, formatMoney, formatSignedMoney } from '../lib/format';

const PAGE_SIZE = 20;

function dateHuman(value: string | null): string {
  if (!value) return 'Date ?';
  return new Date(`${value}T00:00:00`).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** « MVola 400 000 Ar + Cash 200 000 Ar » ou « Compte ? ». */
function describeAccounts(tx: TransactionPublic, currency: Currency): string {
  if (tx.accountUnknown || tx.allocations.length === 0) return 'Compte ?';
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
  const { status } = useAuth();
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
      <div className="flex min-h-[50vh] items-center justify-center text-ink2">
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
  const loadingLedger = ledgerQuery.isLoading || !ledger;
  const formReady = formOpen && accounts.length > 0 && categories.length > 0;

  function openCreate() {
    setEditing(null);
    setFormKey((k) => k + 1);
    setFormOpen(true);
  }

  function openEdit(transaction: TransactionPublic) {
    setEditing(transaction);
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditing(null);
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Transactions"
        subtitle="Vos revenus et dépenses réels — l’argent qui bouge."
        actions={
          <Button
            variant="primary"
            onClick={openCreate}
            disabled={accounts.length === 0}
          >
            <IconPlus size={17} /> Nouvelle opération
          </Button>
        }
      />

      {ledger && ledger.transactions.length > 0 ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3 text-sm"
          style={{ background: 'var(--surface-2)' }}
        >
          <span className="text-xs font-semibold uppercase tracking-wide text-ink2">
            Page {page}
          </span>
          <span className="num text-sm font-bold text-[var(--positive)]">
            +{formatMoney(ledger.totals.incomes, currency)}
          </span>
          <span className="text-xs text-ink3">entrées</span>
          <span className="num text-sm font-bold text-[var(--danger)]">
            −{formatMoney(ledger.totals.expenses, currency)}
          </span>
          <span className="text-xs text-ink3">sorties</span>
        </div>
      ) : null}

      <Panel className="p-2 sm:p-3">
        {loadingLedger && (
          <p className="px-4 py-6 text-center text-sm text-ink3">Chargement…</p>
        )}
        {ledger && ledger.transactions.length === 0 && (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-semibold text-ink">
              Aucune opération enregistrée.
            </p>
            <p className="mt-1 text-xs text-ink2">
              Ajoutez votre première dépense ou votre premier revenu avec
              « Nouvelle opération ».
            </p>
          </div>
        )}

        {ledger && ledger.transactions.length > 0 && (
          <ul className="divide-y" style={{ borderColor: 'var(--edge)' }}>
            {ledger.transactions.map((tx) => {
              const isExpense = tx.type === 'EXPENSE';
              const Icon = isExpense ? IconArrowDown : IconArrowUp;
              return (
                <li
                  key={tx.id}
                  className="flex items-center gap-3 px-3 py-3 sm:px-4"
                >
                  <IconBadge
                    className={
                      isExpense
                        ? 'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-[var(--danger)]'
                        : 'bg-[color-mix(in_srgb,var(--positive)_12%,transparent)] text-[var(--positive)]'
                    }
                  >
                    <Icon size={18} />
                  </IconBadge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold text-ink">
                      {tx.description ??
                        (tx.type === 'EXPENSE' ? 'Dépense' : 'Revenu')}
                    </p>
                    <p className="truncate text-xs text-ink2">
                      {describeMeta(tx, currency)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2.5 sm:gap-3">
                    <span
                      className={cx(
                        'num text-sm font-bold sm:text-[15px]',
                        isExpense
                          ? 'text-[var(--danger)]'
                          : 'text-[var(--positive)]',
                      )}
                    >
                      {formatSignedMoney(tx.amount, tx.type, currency)}
                    </span>
                    <div className="flex flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={deleteMutation.isPending}
                        onClick={() => openEdit(tx)}
                        className="!px-2 !text-xs"
                      >
                        Modifier
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={deleteMutation.isPending}
                        onClick={() => setDeletePending(tx)}
                        className="!px-2 !text-xs text-[var(--danger)]"
                      >
                        Supprimer
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {ledger && ledger.transactions.length > 0 && (
          <div
            className="mt-1 flex items-center justify-between gap-3 border-t px-3 py-3 sm:px-4"
            style={{ borderColor: 'var(--edge)' }}
          >
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Précédent
            </Button>
            <span className="text-xs text-ink2">Page {page}</span>
            <Button
              variant="secondary"
              size="sm"
              disabled={!ledger.hasMore}
              onClick={() => setPage((p) => p + 1)}
            >
              Suivant
            </Button>
          </div>
        )}
      </Panel>


      <p className="text-xs leading-relaxed text-ink3">
        Une opération peut être ventilée sur plusieurs comptes (la somme des
        parts doit couvrir exactement le montant). Toute écriture est confirmée
        avant enregistrement, et la suppression est logique.
      </p>

      {/* Formulaire création / édition dans une boîte modale */}
      <Dialog
        open={formReady}
        onClose={closeForm}
        title={editing ? 'Modifier la transaction' : 'Nouvelle opération'}
      >
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
          onCancel={closeForm}
          onSubmit={(input) =>
            saveMutation.mutate({
              transactionId: editing?.id ?? null,
              input,
            })
          }
        />
      </Dialog>

      {/* Confirmation de suppression */}
      <Dialog
        open={Boolean(deletePending)}
        onClose={() => setDeletePending(null)}
        title="Supprimer cette opération ?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeletePending(null)}>
              Annuler
            </Button>
            <Button
              variant="danger"
              disabled={deleteMutation.isPending}
              onClick={() =>
                deletePending && deleteMutation.mutate(deletePending.id)
              }
            >
              {deleteMutation.isPending
                ? 'Suppression…'
                : 'Confirmer la suppression'}
            </Button>
          </>
        }
      >
        {deletePending && (
          <div className="text-sm leading-relaxed text-ink2">
            <p className="font-semibold text-ink">
              {deletePending.description ?? 'Sans libellé'}
            </p>
            <p className="mt-2">
              {formatSignedMoney(
                deletePending.amount,
                deletePending.type,
                currency,
              )}{' '}
              · {describeAccounts(deletePending, currency)}
            </p>
            <p className="mt-3 text-xs text-ink3">
              La transaction est supprimée logiquement : elle disparaît de
              l’historique et les soldes sont recalculés.
            </p>
            {deleteMutation.isError && (
              <p className="mt-2 text-sm font-medium text-[var(--danger)]">
                {deleteMutation.error instanceof Error
                  ? deleteMutation.error.message
                  : 'Échec de la suppression.'}
              </p>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}

