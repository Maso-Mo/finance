import { useMemo, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AccountPublic,
  Currency,
  DebtCreate,
  DebtDirection,
  DebtPublic,
  DebtSettlementCreate,
  DebtSettlementPublic,
} from '@finance/shared-types';
import { useAuth } from '../auth/AuthContext';
import {
  apiAddDebtSettlement,
  apiCreateDebt,
  apiDeleteDebt,
  apiDeleteDebtSettlement,
  apiGetAccounts,
  apiGetDebts,
} from '../auth/api';
import { ThemeToggle } from '../components/ThemeToggle';
import { NotificationsBell } from '../components/NotificationsBell';
import { ACCOUNT_TYPE_LABELS, formatMoney, toISODate } from '../lib/format';

/**
 * DETTES ET CRÉANCES (étape 11) — page web.
 *
 * Rappels du modèle :
 *  - le RESTANT est TOUJOURS dérivé (jamais stocké) ;
 *  - un règlement STANDARD n'impacte QUE le solde du compte (aucune
 *    Transaction EXPENSE/INCOME créée — pas de pollution du journal/budgets) ;
 *  - une « avance » sur revenu (UNIQUEMENT « on me doit », qualifiée
 *    explicitement) crée côté backend une vraie Transaction INCOME liée.
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
const badge = (tone: string) =>
  `rounded-full px-2 py-0.5 text-xs font-medium ${tone}`;

const STATUS_BADGE: Record<string, string> = {
  OPEN: badge('bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'),
  OVERDUE: badge('bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'),
  SETTLED: badge('bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'),
};

function dateHuman(value: string | null): string {
  return value
    ? new Date(`${value}T00:00:00`).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : 'Date inconnue';
}

function accountName(settlement: DebtSettlementPublic): string {
  if (settlement.account) {
    return ACCOUNT_TYPE_LABELS[settlement.account.type];
  }
  return 'Compte inconnu';
}

function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="text-sm text-red-600 dark:text-red-400" role="alert">
      {message}
    </p>
  );
}

function NewDebtDialog({
  onCreate,
  onClose,
}: {
  onCreate: (input: DebtCreate) => void;
  onClose: () => void;
}) {
  const [direction, setDirection] = useState<DebtDirection>('I_OWE');
  const [advance, setAdvance] = useState(false);
  const [amount, setAmount] = useState('');
  const [counterpartyName, setCounterpartyName] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueDateUnknown, setDueDateUnknown] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const cleaned = amount.replace(/[^\d.]/g, '');
    if (!/^[1-9]\d*(\.\d{1,2})?$/.test(cleaned)) {
      setLocalError('Saisissez un montant strictement positif.');
      return;
    }
    if (!dueDate && !dueDateUnknown) {
      setLocalError('Choisissez une échéance ou cochez « je ne sais plus ».');
      return;
    }
    setLocalError(null);
    onCreate({
      direction,
      originalAmount: cleaned,
      ...(advance && direction === 'OWED_TO_ME'
        ? { kind: 'INCOME_ADVANCE_RECEIVABLE' as const }
        : {}),
      ...(counterpartyName.trim()
        ? { counterpartyName: counterpartyName.trim() }
        : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(dueDateUnknown ? { dueDateUnknown: true } : { dueDate }),
    });
  }

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Nouvelle dette ou créance"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <h2 className="text-base font-semibold">Nouvelle dette ou créance</h2>
        <form onSubmit={submit} className="mt-4 space-y-4">
          <fieldset>
            <legend className="text-sm font-medium">Qui doit à qui ?</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              <label className="flex items-center gap-2 rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700">
                <input
                  type="radio"
                  name="direction"
                  checked={direction === 'I_OWE'}
                  onChange={() => setDirection('I_OWE')}
                />
                Je dois
              </label>
              <label className="flex items-center gap-2 rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700">
                <input
                  type="radio"
                  name="direction"
                  checked={direction === 'OWED_TO_ME'}
                  onChange={() => {
                    setDirection('OWED_TO_ME');
                    setAdvance(false);
                  }}
                />
                On me doit
              </label>
            </div>
          </fieldset>

          {direction === 'OWED_TO_ME' && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={advance}
                onChange={(e) => setAdvance(e.target.checked)}
              />
              C’est une avance sur revenu / salaire
            </label>
          )}
          <label className="block">
            <span className="text-sm font-medium">Montant initial</span>
            <input
              type="text"
              inputMode="decimal"
              aria-label="Montant initial"
              value={amount}
              placeholder="Ex. 50000"
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
              className={inputCls}
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm font-medium">
                {direction === 'I_OWE' ? 'À qui je dois' : 'Qui me doit'}
              </span>
              <input
                type="text"
                maxLength={120}
                aria-label="Contrepartie"
                value={counterpartyName}
                onChange={(e) => setCounterpartyName(e.target.value)}
                className={inputCls}
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium">Description</span>
              <input
                type="text"
                maxLength={240}
                aria-label="Description de la dette"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className={inputCls}
              />
            </label>
          </div>
          <fieldset>
            <legend className="text-sm font-medium">Échéance</legend>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <input
                type="date"
                aria-label="Échéance"
                disabled={dueDateUnknown}
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
              />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={dueDateUnknown}
                  onChange={(e) => setDueDateUnknown(e.target.checked)}
                />
                Je ne sais plus
              </label>
            </div>
          </fieldset>

          <ErrorText message={localError} />
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={btn}>
              Créer
            </button>
            <button type="button" onClick={onClose} className={btnOut}>
              Annuler
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}


function SettlementDialog({
  debt,
  accounts,
  currency,
  onSubmit,
  onClose,
}: {
  debt: DebtPublic;
  accounts: AccountPublic[];
  currency: Currency;
  onSubmit: (debtId: string, input: DebtSettlementCreate) => void;
  onClose: () => void;
}) {
  const isAdvance = debt.kind === 'INCOME_ADVANCE_RECEIVABLE';
  const [amount, setAmount] = useState(debt.remaining);
  const [accountId, setAccountId] = useState('');
  const [accountUnknown, setAccountUnknown] = useState(false);
  const [occurredAt, setOccurredAt] = useState(() => toISODate(new Date()));
  const [dateUnknown, setDateUnknown] = useState(false);
  const [description, setDescription] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const cleaned = amount.replace(/[^\d.]/g, '');
    if (!/^[1-9]\d*(\.\d{1,2})?$/.test(cleaned)) {
      setLocalError('Saisissez un montant strictement positif.');
      return;
    }
    if (!accountId && !accountUnknown) {
      setLocalError('Choisissez un compte ou cochez « je ne sais plus ».');
      return;
    }
    if (!occurredAt && !dateUnknown) {
      setLocalError('Choisissez une date ou cochez « je ne sais plus ».');
      return;
    }
    setLocalError(null);
    onSubmit(debt.id, {
      amount: cleaned,
      ...(accountUnknown
        ? { accountUnknown: true }
        : { accountId }),
      ...(dateUnknown ? { dateUnknown: true } : { occurredAt }),
      ...(description.trim() ? { description: description.trim() } : {}),
    });
  }

  const actionLabel = debt.direction === 'I_OWE'
    ? 'Enregistrer le remboursement'
    : isAdvance
      ? 'Enregistrer l’avance reçue'
      : 'Enregistrer la réception';

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Règlement — ${debt.counterpartyName ?? 'dette'}`}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <h2 className="text-base font-semibold">{actionLabel}</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
          {debt.counterpartyName ?? 'Sans nom'} · restant{' '}
          <span className="tabular-nums">
            {formatMoney(debt.remaining, currency)}
          </span>
          {isAdvance && (
            <span className="ml-2 rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-700 dark:bg-purple-950 dark:text-purple-300">
              Avance : le revenu réel sera enregistré
            </span>
          )}
        </p>
        <form onSubmit={submit} className="mt-4 space-y-4">
          <label className="block">
            <span className="text-sm font-medium">Montant</span>
            <input
              type="text"
              inputMode="decimal"
              aria-label="Montant du règlement"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
              className={inputCls}
            />
          </label>
          <fieldset>
            <legend className="text-sm font-medium">Compte</legend>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <select
                aria-label="Compte utilisé"
                disabled={accountUnknown}
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
              >
                <option value="">Choisir…</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {ACCOUNT_TYPE_LABELS[account.type]}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={accountUnknown}
                  onChange={(e) => setAccountUnknown(e.target.checked)}
                />
                Je ne sais plus
              </label>
            </div>
          </fieldset>
          <fieldset>
            <legend className="text-sm font-medium">Date réelle</legend>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <input
                type="date"
                aria-label="Date du règlement"
                disabled={dateUnknown}
                value={occurredAt}
                onChange={(e) => setOccurredAt(e.target.value)}
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
          <label className="block">
            <span className="text-sm font-medium">Description</span>
            <input
              type="text"
              maxLength={240}
              aria-label="Description du règlement"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={inputCls}
            />
          </label>
          <ErrorText message={localError} />
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={btn}>
              Enregistrer
            </button>
            <button type="button" onClick={onClose} className={btnOut}>
              Annuler
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}



function DebtCard({
  debt,
  accounts,
  currency,
  onAddSettlement,
  onDeleteSettlement,
  onDeleteDebt,
}: {
  debt: DebtPublic;
  accounts: AccountPublic[];
  currency: Currency;
  onAddSettlement: (debt: DebtPublic) => void;
  onDeleteSettlement: (debtId: string, settlementId: string) => void;
  onDeleteDebt: (debt: DebtPublic) => void;
}) {
  const isAdvance = debt.kind === 'INCOME_ADVANCE_RECEIVABLE';
  const isSettled = debt.temporalStatus === 'SETTLED';

  return (
    <li
      className={`rounded-2xl border p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900 ${
        isSettled
          ? 'border-neutral-200 bg-neutral-50 dark:bg-neutral-950/40'
          : 'border-neutral-200 bg-white'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">
              {debt.counterpartyName ?? (isAdvance ? 'Avance' : 'Sans nom')}
            </h3>
            {isAdvance && (
              <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-700 dark:bg-purple-950 dark:text-purple-300">
                Avance
              </span>
            )}
            <span className={STATUS_BADGE[debt.temporalStatus] ?? ''}>
              {debt.temporalStatus === 'SETTLED'
                ? 'Réglée'
                : debt.temporalStatus === 'OVERDUE'
                  ? 'En retard'
                  : 'En cours'}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
            {debt.description ?? '—'}
          </p>
          <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
            {debt.dueDateUnknown
              ? 'Échéance inconnue'
              : `Échéance : ${dateHuman(debt.dueDate)}`}
          </p>
        </div>
        <div className="text-right">
          <p
            className={`text-lg font-semibold tabular-nums ${
              debt.remaining === '0'
                ? 'text-neutral-400 dark:text-neutral-500'
                : ''
            }`}
          >
            {formatMoney(debt.remaining, debt.currency as Currency)}
          </p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            sur {formatMoney(debt.originalAmount, debt.currency as Currency)}
          </p>
        </div>
      </div>

      {debt.settlements.length > 0 && (
        <ul className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
          {debt.settlements.map((settlement) => (
            <li
              key={settlement.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <div className="text-sm">
                <span className="tabular-nums font-medium">
                  {formatMoney(settlement.amount, debt.currency as Currency)}
                </span>
                <span className="text-neutral-500 dark:text-neutral-400">
                  {' '}
                  · {accountName(settlement)} ·{' '}
                  {dateHuman(settlement.occurredAt)}
                </span>
                {settlement.description ? ` · ${settlement.description}` : ''}
              </div>
              <button
                type="button"
                aria-label={`Supprimer le règlement du ${dateHuman(settlement.occurredAt)}`}
                onClick={() => onDeleteSettlement(debt.id, settlement.id)}
                className="rounded-lg border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                Annuler
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onAddSettlement(debt)}
          className={btn}
        >
          {debt.direction === 'I_OWE'
            ? 'Je rembourse'
            : isAdvance
              ? 'J’ai reçu (avance)'
              : 'J’ai reçu'}
        </button>
        <button
          type="button"
          onClick={() => onDeleteDebt(debt)}
          className={btnDanger}
        >
          Supprimer la dette
        </button>
      </div>
    </li>
  );
}

function DebtsView({
  user,
  email,
  debts,
  accounts,
  currency,
  isLoading,
  errorMessage,
  showNew,
  paying,
  deletingDebt,
  actionError,
  totalIOwe,
  totalOwed,
  onOpenNew,
  onCloseNew,
  onCreate,
  onPay,
  onPaySubmit,
  onPayClose,
  onDeleteSettlement,
  onAskDeleteDebt,
  onCloseDeleteDebt,
  onDeleteDebt,
  onSignOut,
}: {
  user: { email?: string } | null;
  email?: string;
  debts: DebtPublic[];
  accounts: AccountPublic[];
  currency: Currency;
  isLoading: boolean;
  errorMessage: string;
  showNew: boolean;
  paying: DebtPublic | null;
  deletingDebt: DebtPublic | null;
  actionError: string | null;
  totalIOwe: string;
  totalOwed: string;
  onOpenNew: () => void;
  onCloseNew: () => void;
  onCreate: (input: DebtCreate) => void;
  onPay: (debt: DebtPublic) => void;
  onPaySubmit: (debtId: string, input: DebtSettlementCreate) => void;
  onPayClose: () => void;
  onDeleteSettlement: (debtId: string, settlementId: string) => void;
  onAskDeleteDebt: (debt: DebtPublic) => void;
  onCloseDeleteDebt: () => void;
  onDeleteDebt: (debtId: string) => void;
  onSignOut: () => void;
}) {
  const iOwe = debts.filter((d) => d.direction === 'I_OWE');
  const owedToMe = debts.filter((d) => d.direction === 'OWED_TO_ME');

  const renderSection = (title: string, items: DebtPublic[], total: string) => (
    <section className={card}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          Restant total : {total}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
          Rien à afficher.
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {items.map((debt) => (
            <DebtCard
              key={debt.id}
              debt={debt}
              accounts={accounts}
              currency={currency}
              onAddSettlement={onPay}
              onDeleteSettlement={onDeleteSettlement}
              onDeleteDebt={onAskDeleteDebt}
            />
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-[28px]">Dettes et créances</h1>
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-6">
        <ErrorText message={actionError} />
        <div className="flex justify-end">
          <button type="button" onClick={onOpenNew} className={btn}>
            Nouvelle dette ou créance
          </button>
        </div>

        {isLoading ? (
          <p className="text-sm text-neutral-500">Chargement…</p>
        ) : errorMessage ? (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {errorMessage}
          </p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {renderSection('Je dois', iOwe, totalIOwe)}
            {renderSection('On me doit', owedToMe, totalOwed)}
          </div>
        )}
      </div>

      {showNew && (
        <NewDebtDialog onCreate={onCreate} onClose={onCloseNew} />
      )}
      {paying && (
        <SettlementDialog
          debt={paying}
          accounts={accounts}
          currency={currency}
          onSubmit={onPaySubmit}
          onClose={onPayClose}
        />
      )}
      {deletingDebt && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Supprimer la dette"
            className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
          >
            <h2 className="text-base font-semibold">Supprimer cette dette ?</h2>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
              {deletingDebt.counterpartyName ?? 'La dette'} disparaît de vos
              vues : les règlements déjà enregistrés cessent d’être pris en
              compte.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onDeleteDebt(deletingDebt.id)}
                className={btnDanger}
              >
                Supprimer
              </button>
              <button type="button" onClick={onCloseDeleteDebt} className={btnOut}>
                Annuler
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}



export default function DebtsPage() {
  const { status, user, signOut } = useAuth();
  const queryClient = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [paying, setPaying] = useState<DebtPublic | null>(null);
  const [deletingDebt, setDeletingDebt] = useState<DebtPublic | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const debtsQuery = useQuery({
    queryKey: ['debts'],
    queryFn: apiGetDebts,
    enabled: status === 'authenticated',
  });
  const accountsQuery = useQuery({
    queryKey: ['dashboard'],
    queryFn: apiGetAccounts,
    enabled: status === 'authenticated',
  });

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['debts'] });
    // Les règlements changent les SOLDES des comptes : rafraîchir le dashboard.
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const createMutation = useMutation({
    mutationFn: apiCreateDebt,
    onSuccess: () => {
      setShowNew(false);
      setActionError(null);
      invalidateAll();
    },
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : 'Erreur.'),
  });
  const settleMutation = useMutation({
    mutationFn: ({
      debtId,
      input,
    }: {
      debtId: string;
      input: DebtSettlementCreate;
    }) => apiAddDebtSettlement(debtId, input),
    onSuccess: () => {
      setPaying(null);
      setActionError(null);
      invalidateAll();
    },
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : 'Erreur.'),
  });
  const deleteSettlementMutation = useMutation({
    mutationFn: ({
      debtId,
      settlementId,
    }: {
      debtId: string;
      settlementId: string;
    }) => apiDeleteDebtSettlement(debtId, settlementId),
    onSuccess: () => {
      setActionError(null);
      invalidateAll();
    },
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : 'Erreur.'),
  });
  const deleteDebtMutation = useMutation({
    mutationFn: apiDeleteDebt,
    onSuccess: () => {
      setDeletingDebt(null);
      setActionError(null);
      invalidateAll();
    },
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : 'Erreur.'),
  });

  const debts = useMemo(() => debtsQuery.data?.debts ?? [], [debtsQuery.data]);
  const currency = accountsQuery.data?.currency ?? 'MGA';
  const accounts = accountsQuery.data?.accounts ?? [];

  const totalRemaining = (items: DebtPublic[]) =>
    formatMoney(
      items
        .reduce((sum, item) => sum + Number(item.remaining), 0)
        .toString(),
      currency,
    );

  if (status === 'loading') {
    return <p className="p-8">Chargement…</p>;
  }
  if (status === 'guest') {
    return <Navigate to="/login" replace />;
  }

  return (
    <DebtsView
      user={user}
      debts={debts}
      accounts={accounts}
      currency={currency}
      isLoading={debtsQuery.isLoading}
      errorMessage={
        debtsQuery.isError
          ? debtsQuery.error instanceof Error
            ? debtsQuery.error.message
            : 'Erreur de chargement des dettes.'
          : ''
      }
      showNew={showNew}
      paying={paying}
      deletingDebt={deletingDebt}
      actionError={actionError}
      totalIOwe={totalRemaining(debts.filter((d) => d.direction === 'I_OWE'))}
      totalOwed={totalRemaining(
        debts.filter((d) => d.direction === 'OWED_TO_ME'),
      )}
      onOpenNew={() => setShowNew(true)}
      onCloseNew={() => setShowNew(false)}
      onCreate={(input) => createMutation.mutate(input)}
      onPay={setPaying}
      onPaySubmit={(debtId, input) => settleMutation.mutate({ debtId, input })}
      onPayClose={() => setPaying(null)}
      onDeleteSettlement={(debtId, settlementId) =>
        deleteSettlementMutation.mutate({ debtId, settlementId })
      }
      onAskDeleteDebt={setDeletingDebt}
      onCloseDeleteDebt={() => setDeletingDebt(null)}
      onDeleteDebt={(debtId) => deleteDebtMutation.mutate(debtId)}
      onSignOut={() => void signOut()}
    />
  );
}

