import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiConfirmSavingsSuggestion,
  apiDismissSavingsSuggestion,
  apiGetAccounts,
  apiGetNextSavingsSuggestion,
  INCOME_RECORDED_EVENT,
} from '../auth/api';
import type { SavingsSuggestionPublic } from '@finance/shared-types';
import { ACCOUNT_TYPE_LABELS, formatMoney } from '../lib/format';
import { useAuth } from '../auth/AuthContext';

/**
 * Proposition d'épargne post-revenu RÉEL (étape 10) — modale globale.
 * « Ignorer » PERSISTE (reload/re-login/retry ne réaffichent pas). « Fermer »
 * (✕/Échap) = AUCUNE mutation. Confirmer crée UN AccountTransfer. Hors-ligne
 * → message clair, aucune écriture.
 */

const btnP =
  'rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50';
const btnS =
  'rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800 disabled:opacity-50';
const input =
  'mt-1 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

function pctAmount(amount: string, pct: string): string {
  if (pct.trim() === '') return '';
  const value = Math.floor((Number(amount) * Number(pct)) / 100);
  return value > 0 ? String(value) : '';
}

/** Libellé robuste (la source vient d'un enum DB mais le contrat API la type string). */
function accountTypeLabel(type: string): string {
  return (ACCOUNT_TYPE_LABELS as Record<string, string>)[type] ?? 'Compte';
}

export default function SavingsPrompt() {
  const { status } = useAuth();
  const queryClient = useQueryClient();
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const suggestionQuery = useQuery({
    queryKey: ['savings-suggestion', 'next'],
    queryFn: apiGetNextSavingsSuggestion,
    enabled: status === 'authenticated',
  });
  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: apiGetAccounts,
    enabled: status === 'authenticated',
  });

  const suggestion: SavingsSuggestionPublic | null =
    suggestionQuery.data?.suggestion ?? null;

  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<'simple' | 'custom'>('simple');
  const [kind, setKind] = useState<'amount' | 'percentage'>('amount');
  const [percentage, setPercentage] = useState('');
  const [sourceId, setSourceId] = useState('');

  useEffect(() => {
    setAmount(suggestion?.suggestedAmount ?? '');
    setMode(suggestion?.suggestedAmount !== null ? 'simple' : 'custom');
    setKind('amount');
    setPercentage('');
    setSourceId(suggestion?.sourceAccount?.id ?? '');
    setError('');
  }, [suggestion?.id]);

  const visible =
    status === 'authenticated' &&
    suggestion !== null &&
    !hidden.has(suggestion.id);

  const currency = accountsQuery.data?.currency ?? 'MGA';
  const source = suggestion?.sourceAccount ?? null;
  const incomeAmount = suggestion?.income?.amount ?? '0';
  const available = source ? Number(source.balance) : Number.POSITIVE_INFINITY;
  const accounts =
    accountsQuery.data?.accounts.filter((account) => account.type !== 'SAVINGS') ?? [];

  useEffect(() => {
    const handler = () =>
      void queryClient.invalidateQueries({ queryKey: ['savings-suggestion', 'next'] });
    window.addEventListener(INCOME_RECORDED_EVENT, handler);
    return () => window.removeEventListener(INCOME_RECORDED_EVENT, handler);
  }, [queryClient]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, suggestion?.id]);

  const computedPct =
    mode === 'custom' && kind === 'percentage'
      ? pctAmount(incomeAmount, percentage)
      : '';
  const finalAmount =
    mode === 'custom' && kind === 'percentage' ? computedPct : amount;
  const overBudget = source !== null && Number(finalAmount) > available;
  const valid =
    /^[1-9]\d*(\.\d{1,2})?$/.test(finalAmount) &&
    !overBudget &&
    (source !== null || sourceId !== '');

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['savings-suggestion', 'next'] });
    void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    void queryClient.invalidateQueries({ queryKey: ['savings'] });
  }

  function close() {
    if (suggestion) {
      setHidden((previous) => {
        const next = new Set(previous);
        next.add(suggestion.id);
        return next;
      });
    }
    setError('');
  }

  function ignore() {
    if (!suggestion || busy) return;
    setBusy(true);
    setError('');
    apiDismissSavingsSuggestion(suggestion.id)
      .then(close)
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  }

  function confirm() {
    if (!suggestion || !valid || busy) return;
    setBusy(true);
    setError('');
    apiConfirmSavingsSuggestion(suggestion.id, {
      amount: finalAmount,
      ...(source === null ? { sourceAccountId: sourceId } : {}),
    })
      .then(() => {
        close();
        refresh();
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  }

  if (!visible || !suggestion) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Proposition d'épargne"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={close}
    >
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-300">
            Épargne suggérée
          </p>
          <button
            type="button"
            aria-label="Fermer"
            onClick={close}
            className="rounded-lg border border-neutral-300 px-2 py-0.5 text-sm leading-6 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            ✕
          </button>
        </div>
        {error && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {error === 'Failed to fetch'
              ? 'Cette action nécessite une connexion à Finance.'
              : error}
          </p>
        )}

        <div className="mt-3">
          <h2 className="text-base font-semibold">
            Veux-tu mettre une partie de ce revenu en épargne ?
          </h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Revenu enregistré : {formatMoney(incomeAmount, currency)}
            {source
              ? ` · reçu sur ${accountTypeLabel(source.type)}`
              : incomeAmount !== '0'
                ? ' · compte inconnu'
                : ''}
            {suggestion.income?.description
              ? ` · ${suggestion.income.description}`
              : ''}
          </p>

          {suggestion.rule && (
            <p className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-200">
              {suggestion.rule.mode === 'FIXED'
                ? `Objectif du mois : ${formatMoney(suggestion.rule.fixedAmount, currency)}`
                : `Objectif du mois : ${suggestion.rule.percentage} % des revenus reçus`}
            </p>
          )}

          <label className="mt-4 block">
            <span className="text-sm font-medium">
              {mode === 'simple'
                ? 'Montant à épargner'
                : 'Montant de ce revenu à épargner'}
            </span>
            <input
              type="text"
              inputMode="decimal"
              aria-label="Montant à épargner"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
              className={input}
            />
          </label>

          {mode === 'custom' && (
            <div className="mt-3 space-y-3">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={kind === 'amount' ? btnP : btnS}
                  onClick={() => setKind('amount')}
                >
                  Montant
                </button>
                <button
                  type="button"
                  className={kind === 'percentage' ? btnP : btnS}
                  onClick={() => setKind('percentage')}
                >
                  Pourcentage de ce revenu
                </button>
              </div>
              {kind === 'percentage' && (
                <label className="block">
                  <span className="text-sm font-medium">
                    Pourcentage de ce revenu ({formatMoney(incomeAmount, currency)})
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label="Pourcentage de ce revenu"
                    value={percentage}
                    onChange={(e) =>
                      setPercentage(e.target.value.replace(/[^\d.]/g, ''))
                    }
                    className={input}
                  />
                  {computedPct !== '' && (
                    <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                      Soit {formatMoney(computedPct, currency)}
                    </p>
                  )}
                </label>
              )}
            </div>
          )}

          {source === null && (
            <label className="mt-3 block">
              <span className="text-sm font-medium">Compte d’origine</span>
              <select
                aria-label="Compte d'origine de l'épargne"
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
                className={input}
              >
                <option value="">— Choisir —</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {ACCOUNT_TYPE_LABELS[account.type]} ·{' '}
                    {formatMoney(account.balance, currency)}
                  </option>
                ))}
              </select>
            </label>
          )}

          {overBudget && source && (
            <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              Ce montant dépasse l’argent réellement disponible sur{' '}
              {accountTypeLabel(source.type)} ({formatMoney(source.balance, currency)}).
              Réduis-le pour ne jamais créer un solde négatif.
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" disabled={!valid || busy} onClick={confirm} className={btnP}>
              {busy ? 'Confirmation…' : 'Confirmer'}
            </button>
            <button type="button" disabled={busy} onClick={ignore} className={btnS}>
              Ignorer
            </button>
            <button type="button" disabled={busy} onClick={close} className={btnS}>
              Plus tard
            </button>
          </div>

          {suggestion.suggestedAmount === null && mode === 'simple' && (
            <button
              type="button"
              onClick={() => setMode('custom')}
              className="mt-2 text-xs text-indigo-600 underline dark:text-indigo-300"
            >
              Je préfère choisir moi-même
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
