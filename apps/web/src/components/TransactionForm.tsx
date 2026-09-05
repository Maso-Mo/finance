import { useState, type FormEvent } from 'react';
import type {
  AccountPublic,
  CategoryPublic,
  Currency,
  TransactionPublic,
  TransactionType,
  TransactionUpsert,
} from '@finance/shared-types';
import {
  ACCOUNT_TYPE_LABELS,
  formatMoney,
  formatSignedMoney,
} from '../lib/format';

const MONEY_RE = /^\d+(\.\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Convertit un montant en centièmes EXACTS (BigInt, jamais de flottant). */
function toCents(value: string): bigint | null {
  if (!MONEY_RE.test(value)) {
    return null;
  }
  const [int = '0', frac = ''] = value.split('.');
  return BigInt(int) * 100n + BigInt(frac.padEnd(2, '0'));
}

/** Centièmes → chaîne monétaire exacte pour l'affichage (via formatMoney). */
function centsToString(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const int = (absolute / 100n).toString();
  const frac = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${int}.${frac}`;
}

function dateHuman(value: string): string {
  return new Date(`${value}T00:00:00`).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function typeLabel(type: TransactionType): string {
  return type === 'EXPENSE' ? 'dépense' : 'revenu';
}

function emptyAllocations(accounts: AccountPublic[]): Record<string, string> {
  return Object.fromEntries(accounts.map((a) => [a.id, '']));
}

function initialAllocations(
  accounts: AccountPublic[],
  editing: TransactionPublic | null,
): Record<string, string> {
  const record = emptyAllocations(accounts);
  if (editing && !editing.accountUnknown) {
    for (const allocation of editing.allocations) {
      record[allocation.accountId] = allocation.amount;
    }
  }
  return record;
}

function initialDraft(
  accounts: AccountPublic[],
  editing: TransactionPublic | null,
) {
  if (!editing) {
    return {
      type: 'EXPENSE' as TransactionType,
      amount: '',
      description: '',
      dateKnown: true,
      date: '',
      dateUnknown: false,
      accountKnown: true,
      accountUnknown: false,
      allocations: emptyAllocations(accounts),
      categoryId: '',
      categoryUnknown: false,
    };
  }
  return {
    type: editing.type,
    amount: editing.amount,
    description: editing.description ?? '',
    dateKnown: editing.occurredAt !== null,
    date: editing.occurredAt ?? '',
    dateUnknown: editing.occurredAt === null,
    accountKnown: !editing.accountUnknown,
    accountUnknown: editing.accountUnknown,
    allocations: initialAllocations(accounts, editing),
    categoryId: editing.category?.id ?? '',
    categoryUnknown: editing.categoryUnknown,
  };
}

function describeAllocationsText(
  payload: TransactionUpsert,
  accounts: AccountPublic[],
  currency: Currency,
): string {
  const allocations = payload.allocations ?? [];
  if (payload.accountUnknown || allocations.length === 0) {
    return 'Compte ? (non renseigné)';
  }
  const parts = allocations.map((allocation) => {
    const account = accounts.find((a) => a.id === allocation.accountId);
    const label = account ? ACCOUNT_TYPE_LABELS[account.type] : 'Compte';
    return `${label} ${formatMoney(allocation.amount, currency)}`;
  });
  return parts.join(' + ');
}

function buildPayload(
  draft: ReturnType<typeof initialDraft>,
  accounts: AccountPublic[],
): { payload: TransactionUpsert | null; errors: string[] } {
  const errors: string[] = [];
  const trimmed = draft.amount.trim();
  const amountCents = toCents(trimmed);
  if (!amountCents || amountCents <= 0n) {
    errors.push('Montant invalide (nombre positif à 2 décimales maximum).');
  }

  // --- Date connue OU explicitement inconnue ---
  const dateValue = draft.dateKnown ? draft.date.trim() : '';
  if (!draft.dateUnknown && (!dateValue || !DATE_RE.test(dateValue))) {
    errors.push('Indiquez la date ou cochez « Je ne sais plus ».');
  }
  if (draft.dateKnown && draft.dateUnknown) {
    errors.push('La date ne peut pas être à la fois connue et inconnue.');
  }

  // --- Comptes connus OU explicitement inconnus ---
  const allocationRows: { accountId: string; amount: string }[] = [];
  let allocatedCents = 0n;
  if (!draft.accountUnknown) {
    for (const account of accounts) {
      const raw = draft.allocations[account.id] ?? '';
      const value = raw.trim();
      if (value === '') {
        continue;
      }
      const cents = toCents(value);
      if (cents === null || cents <= 0n) {
        errors.push(`Montant invalide pour ${ACCOUNT_TYPE_LABELS[account.type]}.`);
        continue;
      }
      allocationRows.push({ accountId: account.id, amount: value });
      allocatedCents += cents;
    }
    if (allocationRows.length === 0) {
      errors.push('Choisissez au moins un compte (ou cochez « Compte ? »).');
    } else if (amountCents !== null && allocatedCents !== amountCents) {
      errors.push(
        `La répartition ne couvre pas le montant (${centsToString(allocatedCents)} / ${centsToString(amountCents)}).`,
      );
    }
  }

  // --- Catégorie (dépense uniquement) ---
  const isExpense = draft.type === 'EXPENSE';
  let categoryId: string | undefined;
  if (isExpense) {
    if (!draft.categoryUnknown && !draft.categoryId) {
      errors.push('Choisissez une catégorie ou cochez « Je ne sais plus ».');
    } else if (!draft.categoryUnknown && draft.categoryId) {
      categoryId = draft.categoryId;
    }
  }

  if (errors.length > 0) {
    return { payload: null, errors };
  }

  const description = draft.description.trim();
  const payload: TransactionUpsert = {
    type: draft.type,
    amount: trimmed,
    ...(draft.dateUnknown
      ? { dateUnknown: true }
      : { occurredAt: dateValue }),
    ...(draft.accountUnknown
      ? { accountUnknown: true }
      : { allocations: allocationRows }),
  };
  if (description) {
    payload.description = description;
  }
  if (isExpense) {
    if (draft.categoryUnknown) {
      payload.categoryUnknown = true;
    } else if (categoryId) {
      payload.categoryId = categoryId;
    }
  }
  return { payload, errors };
}

type Draft = ReturnType<typeof initialDraft>;

type TransactionFormProps = {
  accounts: AccountPublic[];
  categories: CategoryPublic[];
  currency: Currency;
  /** Transaction en cours d’édition (null = nouvelle opération). */
  editing: TransactionPublic | null;
  isSubmitting: boolean;
  submitError: string | null;
  onCancel: () => void;
  onSubmit: (payload: TransactionUpsert) => void;
};

export default function TransactionForm({
  accounts,
  categories,
  currency,
  editing,
  isSubmitting,
  submitError,
  onCancel,
  onSubmit,
}: TransactionFormProps) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(accounts, editing));
  const [errors, setErrors] = useState<string[]>([]);
  const [review, setReview] = useState<TransactionUpsert | null>(null);

  const isExpense = draft.type === 'EXPENSE';

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setErrors([]);
  }

  function handleToggleDateUnknown() {
    setDraft((previous) => ({
      ...previous,
      dateUnknown: !previous.dateUnknown,
      dateKnown: previous.dateUnknown,
    }));
    setErrors([]);
  }

  function handleToggleAccountUnknown() {
    setDraft((previous) => ({
      ...previous,
      accountUnknown: !previous.accountUnknown,
      accountKnown: previous.accountUnknown,
    }));
    setErrors([]);
  }

  function handleCategoryUnknown() {
    setDraft((previous) => ({
      ...previous,
      categoryUnknown: !previous.categoryUnknown,
    }));
    setErrors([]);
  }

  function handleIncludeAccount(accountId: string, included: boolean) {
    setDraft((previous) => ({
      ...previous,
      allocations: included
        ? previous.allocations
        : { ...previous.allocations, [accountId]: '' },
    }));
    setErrors([]);
  }

  function handleAmountChange(accountId: string, value: string) {
    setDraft((previous) => ({
      ...previous,
      allocations: { ...previous.allocations, [accountId]: value },
    }));
    setErrors([]);
  }

  function handleReviewSubmit(event: FormEvent) {
    event.preventDefault();
    const { payload, errors: nextErrors } = buildPayload(draft, accounts);
    if (payload) {
      setErrors([]);
      setReview(payload);
    } else {
      setErrors(nextErrors);
    }
  }

  if (review) {
    const categoryName = categories.find((c) => c.id === review.categoryId)?.name;
    return (
      <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="text-base font-semibold">
          {editing ? 'Modifier' : 'Confirmer'} la {typeLabel(review.type)}
        </h2>
        <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-300">
          Vérifiez avant enregistrement :
        </p>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-neutral-500 dark:text-neutral-400">Montant</dt>
            <dd
              className={`font-semibold tabular-nums ${
                review.type === 'EXPENSE'
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-emerald-600 dark:text-emerald-400'
              }`}
            >
              {formatSignedMoney(review.amount, review.type, currency)}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-neutral-500 dark:text-neutral-400">Date</dt>
            <dd>
              {review.occurredAt
                ? dateHuman(review.occurredAt)
                : 'Je ne sais plus'}
            </dd>
          </div>
          {isExpense && (
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-500 dark:text-neutral-400">Catégorie</dt>
              <dd>{review.categoryUnknown ? 'Je ne sais plus' : (categoryName ?? '—')}</dd>
            </div>
          )}
          <div className="flex justify-between gap-3">
            <dt className="text-neutral-500 dark:text-neutral-400">Compte(s)</dt>
            <dd className="text-right">{describeAllocationsText(review, accounts, currency)}</dd>
          </div>
          {review.description && (
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-500 dark:text-neutral-400">Description</dt>
              <dd className="text-right">{review.description}</dd>
            </div>
          )}
        </dl>
        {submitError && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">{submitError}</p>
        )}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => onSubmit(review)}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white ${
              review.type === 'EXPENSE'
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-emerald-600 hover:bg-emerald-700'
            }`}
          >
            {isSubmitting ? 'Enregistrement…' : 'Confirmer et enregistrer'}
          </button>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => setReview(null)}
            className="rounded-lg border border-neutral-300 px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            Modifier
          </button>
        </div>
      </section>
    );
  }

  const amountCents = toCents(draft.amount.trim());
  let allocatedCents = 0n;
  if (!draft.accountUnknown) {
    for (const account of accounts) {
      const cents = toCents((draft.allocations[account.id] ?? '').trim());
      if (cents !== null && cents > 0n) {
        allocatedCents += cents;
      }
    }
  }
  const progress =
    amountCents !== null
      ? `${formatMoney(centsToString(allocatedCents), currency)} sur ${formatMoney(centsToString(amountCents), currency)} alloué`
      : null;
  const allocationComplete =
    amountCents !== null && allocatedCents === amountCents;

  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">
          {editing ? 'Modifier la transaction' : 'Nouvelle opération'}
        </h2>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          Annuler
        </button>
      </div>

      <form onSubmit={handleReviewSubmit} className="mt-4 space-y-4">
        {/* Sens de l’opération */}
        <div role="radiogroup" aria-label="Type d’opération" className="flex gap-2">
          <button
            type="button"
            aria-pressed={draft.type === 'EXPENSE'}
            onClick={() => update('type', 'EXPENSE')}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
              draft.type === 'EXPENSE'
                ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300'
                : 'border-neutral-300 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800'
            }`}
          >
            Dépense
          </button>
          <button
            type="button"
            aria-pressed={draft.type === 'INCOME'}
            onClick={() => update('type', 'INCOME')}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
              draft.type === 'INCOME'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'border-neutral-300 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800'
            }`}
          >
            Revenu
          </button>
        </div>

        {/* Montant */}
        <label className="block">
          <span className="text-sm font-medium">Montant</span>
          <input
            type="text"
            inputMode="decimal"
            autoFocus={!editing}
            value={draft.amount}
            onChange={(e) =>
              update('amount', e.target.value.replace(/[^\d.]/g, ''))
            }
            placeholder="0"
            className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>

        {/* Date connue / inconnue */}
        <fieldset>
          <legend className="text-sm font-medium">Date</legend>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <input
              type="date"
              disabled={draft.dateUnknown}
              value={draft.date}
              onChange={(e) => update('date', e.target.value)}
              className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.dateUnknown}
                onChange={handleToggleDateUnknown}
              />
              Je ne sais plus
            </label>
          </div>
        </fieldset>

        {/* Comptes connus / inconnus */}
        <fieldset>
          <legend className="text-sm font-medium">Compte(s)</legend>
          <div className="mt-1">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.accountUnknown}
                onChange={handleToggleAccountUnknown}
              />
              Compte ? (je ne sais plus)
            </label>
          </div>
          {!draft.accountUnknown && (
            <div className="mt-2 space-y-2">
              {accounts.map((account) => {
                const value = draft.allocations[account.id] ?? '';
                const included = value.trim() !== '';
                return (
                  <div
                    key={account.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800"
                  >
                    <input
                      type="checkbox"
                      checked={included}
                      aria-label={`Ajouter ${ACCOUNT_TYPE_LABELS[account.type]}`}
                      onChange={(e) => handleIncludeAccount(account.id, e.target.checked)}
                    />
                    <span className="min-w-24 flex-1 text-sm">
                      {ACCOUNT_TYPE_LABELS[account.type]}
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={value}
                      disabled={!included}
                      onChange={(e) =>
                        handleAmountChange(
                          account.id,
                          e.target.value.replace(/[^\d.]/g, ''),
                        )
                      }
                      placeholder={included ? 'Montant…' : ''}
                      className="w-32 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-right text-sm tabular-nums disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950"
                    />
                  </div>
                );
              })}
              {progress && (
                <p
                  className={`text-sm ${
                    allocationComplete
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-red-600 dark:text-red-400'
                  }`}
                >
                  {progress}
                </p>
              )}
            </div>
          )}
        </fieldset>

        {/* Catégorie (dépense) */}
        {isExpense && (
          <fieldset>
            <legend className="text-sm font-medium">Catégorie</legend>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <select
                disabled={draft.categoryUnknown}
                value={draft.categoryId}
                onChange={(e) => update('categoryId', e.target.value)}
                className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
              >
                <option value="">Choisir…</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.categoryUnknown}
                  onChange={handleCategoryUnknown}
                />
                Je ne sais plus
              </label>
            </div>
          </fieldset>
        )}

        {/* Description (facultative) */}
        <label className="block">
          <span className="text-sm font-medium">Description (facultative)</span>
          <input
            type="text"
            maxLength={120}
            value={draft.description}
            onChange={(e) => update('description', e.target.value)}
            className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>

        {errors.length > 0 && (
          <ul className="space-y-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white ${
              draft.type === 'EXPENSE'
                ? 'bg-indigo-600 hover:bg-indigo-700'
                : 'bg-emerald-600 hover:bg-emerald-700'
            }`}
          >
            Vérifier et confirmer…
          </button>
        </div>
      </form>
    </section>
  );
}
