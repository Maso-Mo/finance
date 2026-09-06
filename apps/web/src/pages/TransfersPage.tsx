import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  availableBalanceImpactOfTransfer,
  transferDestinationDelta,
  transferSourceDelta,
} from '@finance/finance-core';
import type {
  AccountPublic,
  Currency,
  TransferCreate,
  TransferPublic,
  TransferUpdate,
} from '@finance/shared-types';
import { useAuth } from '../auth/AuthContext';
import {
  apiCreateTransfer,
  apiDeleteTransfer,
  apiGetAccounts,
  apiGetTransfers,
  apiUpdateTransfer,
} from '../auth/api';
import { ThemeToggle } from '../components/ThemeToggle';
import { NotificationsBell } from '../components/NotificationsBell';
import { ACCOUNT_TYPE_LABELS, formatMoney, toISODate } from '../lib/format';
import { buildTransferPayload } from '../lib/transfer';

/**
 * TRANSFERTS INTERNES RÉELS (étape 9) — page web.
 *
 * L'application est un journal de suivi, pas une banque : elle ENREGISTRE un
 * transfert que l'utilisateur a réellement effectué. Le bouton s'appelle donc
 * « Enregistrer un transfert », jamais « Envoyer ».
 *
 * Un transfert n'est NI une dépense NI un revenu : il n'apparaît jamais dans
 * les budgets ni les transactions. Seuls les soldes courants dérivés des
 * comptes (et donc le Total disponible + le forecast) en tiennent compte.
 *
 * Règle V1 : `amount` = somme créditée sur la destination ; `feeAmount` est
 * toujours prélevé EN PLUS sur la source (source −(amount + fee)).
 */

const inputCls =
  'mt-1 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const btn =
  'rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50';
const btnOut =
  'rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800';
const btnDanger =
  'rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50';
const card =
  'rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900';

function CField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

/** Compte débité (−(amount + fee)) puis crédité (+amount) + impact total. */
function ImpactPreview({
  amount,
  feeAmount,
  source,
  destination,
  currency,
}: {
  amount: string;
  feeAmount: string;
  source: AccountPublic | null;
  destination: AccountPublic | null;
  currency: Currency;
}) {
  if (!source || !destination || !amount) {
    return <p className="text-sm text-neutral-500 dark:text-neutral-400">…</p>;
  }
  const debit = transferSourceDelta(amount, feeAmount || '0').toString();
  const credit = transferDestinationDelta(amount).toString();
  const impact = availableBalanceImpactOfTransfer(
    amount,
    feeAmount || '0',
    source.type,
    destination.type,
  ).toString();
  return (
    <ul className="mt-3 space-y-1 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-950/40">
      <li className="flex justify-between gap-3">
        <span className="text-neutral-500 dark:text-neutral-400">
          Débité de {ACCOUNT_TYPE_LABELS[source.type]}
        </span>
        <span className="tabular-nums font-medium">
          {formatMoney(debit, currency)}
        </span>
      </li>
      <li className="flex justify-between gap-3">
        <span className="text-neutral-500 dark:text-neutral-400">
          Crédité sur {ACCOUNT_TYPE_LABELS[destination.type]}
        </span>
        <span className="tabular-nums font-medium">
          {formatMoney(credit, currency)}
        </span>
      </li>
      <li className="flex justify-between gap-3 border-t border-neutral-200 pt-1 dark:border-neutral-800">
        <span className="text-neutral-500 dark:text-neutral-400">
          Impact sur le Total disponible
        </span>
        <span className="tabular-nums font-semibold">
          {formatMoney(impact, currency)}
        </span>
      </li>
    </ul>
  );
}
function TransferEditor({
  accounts,
  currency,
  initial,
  busy,
  err,
  onSubmit,
  onCancel,
}: {
  accounts: AccountPublic[];
  currency: Currency;
  initial?: TransferPublic;
  busy: boolean;
  err: string | null;
  onSubmit: (input: TransferCreate | TransferUpdate) => void;
  onCancel: () => void;
}) {
  const [sourceId, setSourceId] = useState(initial?.source.id ?? '');
  const [destinationId, setDestinationId] = useState(
    initial?.destination.id ?? '',
  );
  const [amount, setAmount] = useState(initial?.amount ?? '');
  const [feeEnabled, setFeeEnabled] = useState(
    initial ? initial.feeAmount !== '0' : false,
  );
  const [feeAmount, setFeeAmount] = useState(
    initial && initial.feeAmount !== '0' ? initial.feeAmount : '',
  );
  const [date, setDate] = useState(initial?.occurredAt ?? '');
  const [dateUnknown, setDateUnknown] = useState(initial?.dateUnknown ?? false);
  const [description, setDescription] = useState(initial?.description ?? '');
  const [draft, setDraft] = useState<
    TransferCreate | TransferUpdate | null
  >(null);
  const [errors, setErrors] = useState<string[]>([]);

  const source = accounts.find((a) => a.id === sourceId) ?? null;
  const destination = accounts.find((a) => a.id === destinationId) ?? null;

  function verify(event: FormEvent) {
    event.preventDefault();
    const built = buildTransferPayload({
      sourceAccountId: sourceId,
      destinationAccountId: destinationId,
      amount,
      feeEnabled,
      feeAmount,
      date,
      dateUnknown,
      description,
    });
    if (!built.payload) {
      setErrors(built.errors);
      setDraft(null);
      return;
    }
    setErrors([]);
    setDraft(built.payload);
  }

  return (
    <section className={card}>
      <h2 className="text-base font-semibold">
        {initial ? 'Corriger un transfert' : 'Enregistrer un transfert'}
      </h2>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        Saisissez un transfert que vous avez RÉELLEMENT effectué (MVola, banque,
        cash…). L’application ne déplace jamais l’argent : elle tient le
        journal de vos comptes. Montant = somme créditée sur la destination ;
        les frais éventuels sont toujours prélevés en plus sur le compte source.
      </p>

      {!draft ? (
        <form onSubmit={verify} className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <CField label="De (compte source)">
              <select
                aria-label="Compte source"
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
                className={inputCls}
              >
                <option value="">— Choisir —</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {ACCOUNT_TYPE_LABELS[account.type]}
                  </option>
                ))}
              </select>
            </CField>
            <CField label="Vers (compte destination)">
              <select
                aria-label="Compte destination"
                value={destinationId}
                onChange={(e) => setDestinationId(e.target.value)}
                className={inputCls}
              >
                <option value="">— Choisir —</option>
                {accounts
                  .filter((account) => account.id !== sourceId)
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {ACCOUNT_TYPE_LABELS[account.type]}
                    </option>
                  ))}
              </select>
            </CField>
          </div>


          <CField label="Montant (crédité sur la destination)">
            <input
              type="text"
              inputMode="decimal"
              aria-label="Montant transféré"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder="100000"
              className={inputCls}
            />
          </CField>

          <div className="rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={feeEnabled}
                onChange={(e) => setFeeEnabled(e.target.checked)}
              />
              Frais prélevés en plus sur le compte source ?
            </label>
            {feeEnabled && (
              <div className="mt-2">
                <CField label="Montant des frais">
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label="Montant des frais"
                    value={feeAmount}
                    onChange={(e) =>
                      setFeeAmount(e.target.value.replace(/[^\d.]/g, ''))
                    }
                    placeholder="2500"
                    className={inputCls}
                  />
                </CField>
              </div>
            )}
          </div>

          <fieldset>
            <legend className="text-sm font-medium">Date réelle</legend>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <input
                type="date"
                aria-label="Date réelle"
                disabled={dateUnknown}
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
              />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={dateUnknown}
                  onChange={(e) => setDateUnknown(e.target.checked)}
                />
                Je ne sais plus
              </label>
            </div>
          </fieldset>

          <CField label="Description (facultative)">
            <input
              type="text"
              maxLength={120}
              aria-label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={inputCls}
            />
          </CField>

          <ImpactPreview
            amount={amount}
            feeAmount={feeEnabled ? feeAmount : '0'}
            source={source}
            destination={destination}
            currency={currency}
          />

          {errors.length > 0 && (
            <ul className="space-y-1 text-sm text-red-600 dark:text-red-400">
              {errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap gap-2">
            <button type="submit" className={btn}>
              Vérifier…
            </button>
            <button type="button" onClick={onCancel} className={btnOut}>
              Annuler
            </button>
          </div>
        </form>
      ) : (
        <ConfirmTransfer
          draft={draft}
          accounts={accounts}
          currency={currency}
          busy={busy}
          err={err}
          onBack={() => setDraft(null)}
          onSubmit={() => onSubmit(draft)}
        />
      )}
    </section>
  );
}

function ConfirmTransfer({
  draft,
  accounts,
  currency,
  busy,
  err,
  onBack,
  onSubmit,
}: {
  draft: TransferCreate | TransferUpdate;
  accounts: AccountPublic[];
  currency: Currency;
  busy: boolean;
  err: string | null;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const source =
    accounts.find((a) => a.id === draft.sourceAccountId) ?? null;
  const destination =
    accounts.find((a) => a.id === draft.destinationAccountId) ?? null;
  const debit = transferSourceDelta(
    draft.amount,
    draft.feeAmount ?? '0',
  ).toString();
  const credit = transferDestinationDelta(draft.amount).toString();
  const impact = availableBalanceImpactOfTransfer(
    draft.amount,
    draft.feeAmount ?? '0',
    source?.type ?? '',
    destination?.type ?? '',
  ).toString();
  return (
    <div className="mt-4">
      <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-900 dark:bg-indigo-950/30">
        <h3 className="text-sm font-semibold text-indigo-800 dark:text-indigo-200">
          Confirmer ce transfert ?
        </h3>
        <dl className="mt-3 space-y-1 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-neutral-500 dark:text-neutral-400">De</dt>
            <dd className="font-medium">
              {source ? ACCOUNT_TYPE_LABELS[source.type] : draft.sourceAccountId}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-neutral-500 dark:text-neutral-400">Vers</dt>
            <dd className="font-medium">
              {destination
                ? ACCOUNT_TYPE_LABELS[destination.type]
                : draft.destinationAccountId}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-neutral-500 dark:text-neutral-400">
              Montant reçu
            </dt>
            <dd className="tabular-nums font-semibold">
              {formatMoney(draft.amount, currency)}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-neutral-500 dark:text-neutral-400">Frais</dt>
            <dd className="tabular-nums">
              {formatMoney(draft.feeAmount ?? '0', currency)}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-neutral-500 dark:text-neutral-400">
              Débit total {source ? ACCOUNT_TYPE_LABELS[source.type] : ''}
            </dt>
            <dd className="tabular-nums font-medium">
              {formatMoney(debit, currency)}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-neutral-500 dark:text-neutral-400">
              Crédit {destination ? ACCOUNT_TYPE_LABELS[destination.type] : ''}
            </dt>
            <dd className="tabular-nums font-medium">
              {formatMoney(credit, currency)}
            </dd>
          </div>
          <div className="flex justify-between gap-3 border-t border-indigo-200 pt-1 dark:border-indigo-900">
            <dt className="text-neutral-500 dark:text-neutral-400">
              Impact Total disponible
            </dt>
            <dd className="tabular-nums font-semibold">
              {formatMoney(impact, currency)}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-neutral-500 dark:text-neutral-400">Date</dt>
            <dd>
              {draft.dateUnknown ? 'Je ne sais plus' : draft.occurredAt ?? '—'}
            </dd>
          </div>
        </dl>
      </div>

      {err && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">{err}</p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={onSubmit} className={btn}>
          {busy ? 'Enregistrement…' : 'Confirmer'}
        </button>
        <button type="button" onClick={onBack} disabled={busy} className={btnOut}>
          Modifier
        </button>
      </div>
    </div>
  );
}

export default function TransfersPage() {
  const { status, user, signOut } = useAuth();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(false);
  const [editing, setEditing] = useState<TransferPublic | null>(null);
  const [deleting, setDeleting] = useState<TransferPublic | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accountsQuery = useQuery({
    queryKey: ['dashboard'],
    queryFn: apiGetAccounts,
    enabled: status === 'authenticated',
  });
  const transfersQuery = useQuery({
    queryKey: ['transfers'],
    queryFn: () => apiGetTransfers(1, 50),
    enabled: status === 'authenticated',
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['transfers'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const create = useMutation({
    mutationFn: (v: TransferCreate) => apiCreateTransfer(v),
    onSuccess: () => {
      setForm(false);
      setEditing(null);
      setError(null);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const update = useMutation({
    mutationFn: (v: { id: string; input: TransferUpdate }) =>
      apiUpdateTransfer(v.id, v.input),
    onSuccess: () => {
      setForm(false);
      setEditing(null);
      setError(null);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiDeleteTransfer(id),
    onSuccess: () => {
      setDeleting(null);
      setError(null);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });

  const accounts: AccountPublic[] = accountsQuery.data?.accounts ?? [];
  const currency: Currency = accountsQuery.data?.currency ?? 'MGA';
  const transfers = transfersQuery.data?.transfers ?? [];

  function startCreate() {
    setEditing(null);
    setError(null);
    setForm(true);
  }
  function startEdit(item: TransferPublic) {
    setEditing(item);
    setError(null);
    setForm(true);
  }
  function closeForm() {
    setForm(false);
    setEditing(null);
    setError(null);
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
          <h1 className="text-lg font-semibold">Transferts</h1>
          <span className="hidden text-xs text-neutral-500 sm:inline dark:text-neutral-400">
            {user?.email}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <NotificationsBell />
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
        {error && (
          <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}

        {!form && (
          <div className="mb-4">
            <button type="button" onClick={startCreate} className={btn}>
              Enregistrer un transfert
            </button>
          </div>
        )}

        {form && (
          <div className="mb-6">
            <TransferEditor
              accounts={accounts}
              currency={currency}
              initial={editing ?? undefined}
              busy={create.isPending || update.isPending}
              err={error}
              onSubmit={(input) =>
                editing
                  ? update.mutate({ id: editing.id, input })
                  : create.mutate(input)
              }
              onCancel={closeForm}
            />
          </div>
        )}

        <section className={card}>
          <h2 className="text-base font-semibold">Historique</h2>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            Un transfert est UNE opération — jamais une dépense suivie d’un
            revenu. Il n’entre dans aucun budget ni aucune transaction.
          </p>
          {transfers.length === 0 && (
            <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
              Aucun transfert enregistré.
            </p>
          )}
          <ul className="mt-3 space-y-2">
            {transfers.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {ACCOUNT_TYPE_LABELS[item.source.type]} →{' '}
                    {ACCOUNT_TYPE_LABELS[item.destination.type]}
                  </div>
                  <div className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                    {item.occurredAt ?? 'Date inconnue'}
                    {item.description ? ` · ${item.description}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-right text-sm">
                    <div className="tabular-nums font-semibold">
                      {formatMoney(item.amount, currency)}
                    </div>
                    {item.feeAmount !== '0' && (
                      <div className="text-xs text-neutral-500 dark:text-neutral-400">
                        Frais : {formatMoney(item.feeAmount, currency)}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => startEdit(item)}
                    className="rounded-lg border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    Modifier
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleting(item)}
                    className="rounded-lg border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                  >
                    Supprimer
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>



        {deleting && (
          <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
          >
              <h2 className="text-base font-semibold">
                Supprimer ce transfert ?
              </h2>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
                {ACCOUNT_TYPE_LABELS[deleting.source.type]} →{' '}
                {ACCOUNT_TYPE_LABELS[deleting.destination.type]} ·{' '}
                {formatMoney(deleting.amount, currency)}. Les soldes des comptes
                reviendront automatiquement à leur état sans ce transfert.
                Aucune transaction ne sera touchée.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(deleting.id)}
                  className={btnDanger}
                >
                  {remove.isPending ? 'Suppression…' : 'Supprimer'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDeleting(null);
                    setError(null);
                  }}
                  className={btnOut}
                >
                  Annuler
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
