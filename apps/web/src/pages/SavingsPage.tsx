import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { availableBalanceImpactOfTransfer, transferSourceDelta } from '@finance/finance-core';
import type {
  AccountPublic,
  Currency,
  SavingsContributionCreate,
  SavingsPlanCreate,
  SavingsPlanMode,
  SavingsPlanPublic,
  SavingsProgressStatus,
} from '@finance/shared-types';
import { useAuth } from '../auth/AuthContext';
import {
  apiAddSavingsContribution,
  apiCreateSavingsPlan,
  apiDeleteSavingsPlan,
  apiGetAccounts,
  apiGetSavingsMonth,
  apiUpdateSavingsPlan,
} from '../auth/api';
import { ThemeToggle } from '../components/ThemeToggle';
import { NotificationsBell } from '../components/NotificationsBell';
import { ACCOUNT_TYPE_LABELS, formatMoney, toISODate } from '../lib/format';

/**
 * ÉPARGNE MENSUELLE PLANIFIÉE (étape 10) — page web.
 *
 * ⚠ Un plan d'épargne n'est JAMAIS de l'argent :
 *  - créer/modifier/supprimer un plan ne change AUCUN solde ;
 *  - le compte Épargne n'augmente QUE lorsqu'un vrai transfert vers Épargne
 *    est enregistré (« J'ai épargné ») ;
 *  - le SOLDE réel de l'Épargne et la PROGRESSION du plan (contributions)
 *    sont deux concepts distincts, jamais affichés comme une même valeur ;
 *  - en mode « Pourcentage des revenus reçus », la cible évolue selon les
 *    revenus RÉELLEMENT reçus et enregistrés ce mois (jamais les revenus
 *    seulement prévus).
 */

const MONTHS_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

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

function monthKeyOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

function monthLabel(key: string): string {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const name = MONTHS_FR[(month || 1) - 1] ?? key;
  return `${name} ${year}`;
}

function shiftMonth(key: string, offset: number): string {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const total =
    (Number.isFinite(year) ? year : 2000) * 12 +
    (Number.isFinite(month) ? month - 1 : 0) +
    offset;
  const nextYear = Math.floor(total / 12);
  const nextMonth = (total % 12) + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950/40">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{label}</p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">
        {value}
      </p>
    </div>
  );
}

function ProgressBadge({ progress }: { progress: SavingsProgressStatus }) {
  if (progress === 'REACHED') {
    return (
      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
        Objectif atteint
      </span>
    );
  }
  if (progress === 'NO_INCOME_YET') {
    return (
      <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] font-semibold text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200">
        En attente de revenus
      </span>
    );
  }
  return (
    <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
      En cours
    </span>
  );
}

/** Barre de progression simple (le texte reste la référence lisible). */
function ProgressBar({
  target,
  contributed,
}: {
  target: string;
  contributed: string;
}) {
  const ratio =
    Number(target) > 0
      ? Math.min(100, Math.round((Number(contributed) / Number(target)) * 100))
      : 0;
  const over = Number(contributed) > Number(target);
  return (
    <div
      role="img"
      aria-label={`Progression de l'objectif : ${ratio} %`}
      className="h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
    >
      <div
        className={
          over
            ? 'h-full rounded-full bg-indigo-400'
            : 'h-full rounded-full bg-indigo-500'
        }
        style={{ width: `${ratio}%` }}
      />
    </div>
  );
}

/** Éditeur inline d'un plan (création ou modification d'un plan ACTIF). */
function PlanEditor({
  monthKey,
  currency,
  initial,
  busy,
  err,
  onSubmit,
  onCancel,
}: {
  monthKey: string;
  currency: Currency;
  initial: SavingsPlanPublic | null;
  busy: boolean;
  err: string | null;
  onSubmit: (input: SavingsPlanCreate) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<SavingsPlanMode>(
    initial?.mode ?? 'FIXED',
  );
  const [fixedAmount, setFixedAmount] = useState(
    initial?.fixedAmount ?? '',
  );
  const [percentage, setPercentage] = useState(initial?.percentage ?? '');
  const [draft, setDraft] = useState<SavingsPlanCreate | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  function verify(event: FormEvent) {
    event.preventDefault();
    if (mode === 'FIXED' && !/^[1-9]\d*(\.\d{1,2})?$/.test(fixedAmount.trim())) {
      setErrors(['Saisissez un montant fixe strictement positif.']);
      setDraft(null);
      return;
    }
    if (
      mode === 'PERCENTAGE' &&
      !/^([1-9]\d{0,2}|0?\.\d{1,2}|[1-9]\d{0,2}\.\d{1,2})$/.test(
        percentage.trim(),
      )
    ) {
      setErrors(['Saisissez un pourcentage entre 0 et 100.']);
      setDraft(null);
      return;
    }
    if (mode === 'PERCENTAGE' && Number(percentage.trim()) > 100) {
      setErrors(['Le pourcentage ne peut pas dépasser 100.']);
      setDraft(null);
      return;
    }
    setErrors([]);
    setDraft({
      month: monthKey,
      mode,
      ...(mode === 'FIXED'
        ? { fixedAmount: fixedAmount.trim() }
        : { percentage: percentage.trim() }),
    });
  }

  return (
    <section className={card}>
      <h2 className="text-base font-semibold">
        {initial ? 'Modifier l’objectif du mois' : 'Définir un objectif du mois'}
      </h2>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        Un plan d’épargne est un OBJECTIF : il ne retire jamais d’argent d’un
        compte. Vous l’atteindrez en enregistrant plus tard vos vrais
        transferts vers Épargne (« J’ai épargné »).
      </p>

      {!draft ? (
        <form onSubmit={verify} className="mt-4 space-y-4">
          <fieldset className="flex flex-wrap gap-4">
            <legend className="text-sm font-medium">Mode</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="savings-mode"
                checked={mode === 'FIXED'}
                onChange={() => setMode('FIXED')}
              />
              Montant fixe
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="savings-mode"
                checked={mode === 'PERCENTAGE'}
                onChange={() => setMode('PERCENTAGE')}
              />
              Pourcentage des revenus reçus
            </label>
          </fieldset>

          {mode === 'FIXED' ? (
            <label className="block">
              <span className="text-sm font-medium">Objectif du mois</span>
              <input
                type="text"
                inputMode="decimal"
                aria-label="Objectif du mois (montant fixe)"
                value={fixedAmount}
                onChange={(e) =>
                  setFixedAmount(e.target.value.replace(/[^\d.]/g, ''))
                }
                placeholder="100000"
                className={inputCls}
              />
            </label>
          ) : (
            <>
              <label className="block">
                <span className="text-sm font-medium">Pourcentage</span>
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label="Pourcentage à épargner"
                  value={percentage}
                  onChange={(e) =>
                    setPercentage(e.target.value.replace(/[^\d.]/g, ''))
                  }
                  placeholder="20"
                  className={inputCls}
                />
              </label>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                L’objectif évoluera en fonction des revenus réellement reçus et
                enregistrés ce mois-ci. Les revenus seulement prévus ne sont
                pas inclus.
              </p>
            </>
          )}

          {errors.length > 0 && (
            <ul className="text-sm text-red-600 dark:text-red-400">
              {errors.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap gap-2">
            <button type="submit" className={btn}>
              Vérifier
            </button>
            <button type="button" onClick={onCancel} disabled={busy} className={btnOut}>
              Annuler
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-900 dark:bg-indigo-950/30">
          <h3 className="text-sm font-semibold text-indigo-800 dark:text-indigo-200">
            Confirmer cet objectif ?
          </h3>
          <dl className="mt-3 space-y-1 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-500 dark:text-neutral-400">Mois</dt>
              <dd className="font-medium">{monthLabel(monthKey)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-500 dark:text-neutral-400">Mode</dt>
              <dd className="font-medium">
                {draft.mode === 'FIXED'
                  ? 'Montant fixe'
                  : 'Pourcentage des revenus reçus'}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-500 dark:text-neutral-400">
                {draft.mode === 'FIXED' ? 'Objectif' : 'Pourcentage'}
              </dt>
              <dd className="tabular-nums font-semibold">
                {draft.mode === 'FIXED'
                  ? formatMoney(draft.fixedAmount as string, currency)
                  : `${draft.percentage} %`}
              </dd>
            </div>
          </dl>

          {err && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">{err}</p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => onSubmit(draft)}
              className={btn}
            >
              {busy ? 'Enregistrement…' : 'Confirmer'}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setErrors([]);
              }}
              disabled={busy}
              className={btnOut}
            >
              Modifier
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Éditeur « J'ai épargné » : vrai transfert vers Épargne, lié au plan. */
function ContributionEditor({
  accounts,
  currency,
  busy,
  err,
  onSubmit,
  onCancel,
}: {
  accounts: AccountPublic[];
  currency: Currency;
  busy: boolean;
  err: string | null;
  onSubmit: (input: SavingsContributionCreate) => void;
  onCancel: () => void;
}) {
  const [sourceId, setSourceId] = useState('');
  const [amount, setAmount] = useState('');
  const [feeEnabled, setFeeEnabled] = useState(false);
  const [feeAmount, setFeeAmount] = useState('');
  const [date, setDate] = useState('');
  const [dateUnknown, setDateUnknown] = useState(false);
  const [description, setDescription] = useState('');
  const [draft, setDraft] = useState<SavingsContributionCreate | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const source = accounts.find((a) => a.id === sourceId) ?? null;
  // Frais : 0 par défaut (même pendant la saisie, tant que le champ est vide).
  const fee =
    feeEnabled && feeAmount.trim() !== '' ? feeAmount.trim() : '0';
  // Débit réel du compte d'origine = montant + frais (calcul Decimal exact,
  // jamais de flottant pour de l'argent).
  const debit =
    source && amount
      ? transferSourceDelta(amount, fee).abs().toString()
      : '';

  function verify(event: FormEvent) {
    event.preventDefault();
    const list: string[] = [];
    if (!sourceId) list.push('Choisissez le compte d’origine.');
    if (!/^[1-9]\d*(\.\d{1,2})?$/.test(amount.trim())) {
      list.push('Saisissez un montant réellement transféré (strictement positif).');
    }
    if (feeEnabled && !/^\d+(\.\d{1,2})?$/.test(feeAmount.trim())) {
      list.push('Saisissez des frais valides (0 si aucun).');
    }
    if (date && dateUnknown) {
      list.push('Choisissez une date OU « je ne sais plus », pas les deux.');
    }
    if (!date && !dateUnknown) {
      list.push('Renseignez la date réelle ou cochez « je ne sais plus ».');
    }
    if (list.length > 0) {
      setErrors(list);
      setDraft(null);
      return;
    }
    setErrors([]);
    setDraft({
      sourceAccountId: sourceId,
      amount: amount.trim(),
      feeAmount: feeEnabled ? feeAmount.trim() : '0',
      ...(dateUnknown ? { dateUnknown: true } : { occurredAt: date }),
      ...(description.trim() ? { description: description.trim() } : {}),
    });
  }

  return (
    <section className={card}>
      <h2 className="text-base font-semibold">J’ai épargné</h2>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        Enregistrez un transfert RÉEL déjà effectué vers votre Épargne. Le
        montant saisi est crédité sur Épargne ; les frais éventuels sont
        prélevés en plus sur le compte d’origine.
      </p>

      {!draft ? (
        <form onSubmit={verify} className="mt-4 space-y-4">
          <label className="block">
            <span className="text-sm font-medium">Depuis (compte d’origine)</span>
            <select
              aria-label="Compte d'origine"
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
          </label>

          <label className="block">
            <span className="text-sm font-medium">Montant crédité sur Épargne</span>
            <input
              type="text"
              inputMode="decimal"
              aria-label="Montant crédité sur Épargne"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder="40000"
              className={inputCls}
            />
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="Frais prélevés en plus sur le compte d'origine"
              checked={feeEnabled}
              onChange={(e) => setFeeEnabled(e.target.checked)}
            />
            Frais prélevés en plus sur le compte d’origine
          </label>
          {feeEnabled && (
            <label className="block">
              <span className="text-sm font-medium">Montant des frais</span>
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
            </label>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm font-medium">Date réelle</span>
              <input
                type="date"
                aria-label="Date réelle du transfert"
                value={date}
                disabled={dateUnknown}
                onChange={(e) => setDate(e.target.value)}
                className={inputCls}
              />
            </label>
            <label className="flex items-end gap-2 text-sm">
              <input
                type="checkbox"
                aria-label="Je ne sais plus (date)"
                checked={dateUnknown}
                onChange={(e) => {
                  setDateUnknown(e.target.checked);
                  if (e.target.checked) setDate('');
                }}
              />
              Je ne sais plus
            </label>
          </div>

          <label className="block">
            <span className="text-sm font-medium">Description (facultative)</span>
            <input
              type="text"
              aria-label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={120}
              className={inputCls}
            />
          </label>

          {source && amount && (
            <ul className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-950/40">
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
                  Crédité sur Épargne
                </span>
                <span className="tabular-nums font-medium">
                  {formatMoney(amount, currency)}
                </span>
              </li>
              <li className="flex justify-between gap-3">
                <span className="text-neutral-500 dark:text-neutral-400">
                  Contribution à l’objectif
                </span>
                <span className="tabular-nums font-medium">
                  {formatMoney(amount, currency)}
                </span>
              </li>
              <li className="flex justify-between gap-3 border-t border-neutral-200 pt-1 dark:border-neutral-800">
                <span className="text-neutral-500 dark:text-neutral-400">
                  Impact sur le Total disponible
                </span>
                <span className="tabular-nums font-semibold">
                  {formatMoney(
                    availableBalanceImpactOfTransfer(
                      amount,
                      fee,
                      source.type,
                      'SAVINGS',
                    ).toString(),
                    currency,
                  )}
                </span>
              </li>
            </ul>
          )}

          {errors.length > 0 && (
            <ul className="text-sm text-red-600 dark:text-red-400">
              {errors.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap gap-2">
            <button type="submit" className={btn}>
              Vérifier
            </button>
            <button type="button" onClick={onCancel} disabled={busy} className={btnOut}>
              Annuler
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-900 dark:bg-indigo-950/30">
          <h3 className="text-sm font-semibold text-indigo-800 dark:text-indigo-200">
            Confirmer cette contribution ?
          </h3>
          <dl className="mt-3 space-y-1 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-500 dark:text-neutral-400">Depuis</dt>
              <dd className="font-medium">
                {source ? ACCOUNT_TYPE_LABELS[source.type] : '—'}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-500 dark:text-neutral-400">Vers</dt>
              <dd className="font-medium">Épargne</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-500 dark:text-neutral-400">Montant réellement transféré</dt>
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
              <dt className="text-neutral-500 dark:text-neutral-400">Contribution à l’objectif</dt>
              <dd className="tabular-nums font-semibold">
                {formatMoney(draft.amount, currency)}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-500 dark:text-neutral-400">Date</dt>
              <dd>
                {draft.dateUnknown ? 'Je ne sais plus' : (draft.occurredAt ?? '—')}
              </dd>
            </div>
            {draft.description && (
              <div className="flex justify-between gap-3">
                <dt className="text-neutral-500 dark:text-neutral-400">Description</dt>
                <dd>{draft.description}</dd>
              </div>
            )}
          </dl>

          {err && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">{err}</p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => onSubmit(draft)}
              className={btn}
            >
              {busy ? 'Enregistrement…' : 'Confirmer'}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setErrors([]);
              }}
              disabled={busy}
              className={btnOut}
            >
              Modifier
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export default function SavingsPage() {
  const { status, user, signOut } = useAuth();
  const queryClient = useQueryClient();
  const [monthKey, setMonthKey] = useState(() =>
    monthKeyOf(toISODate(new Date())),
  );
  const [planEditor, setPlanEditor] = useState<{
    initial: SavingsPlanPublic | null;
  } | null>(null);
  const [contribOpen, setContribOpen] = useState(false);
  const [deleting, setDeleting] = useState<SavingsPlanPublic | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: apiGetAccounts,
    enabled: status === 'authenticated',
  });
  const viewQuery = useQuery({
    queryKey: ['savings', monthKey],
    queryFn: () => apiGetSavingsMonth(monthKey),
    enabled: status === 'authenticated',
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['savings'] });
    void queryClient.invalidateQueries({ queryKey: ['accounts'] });
  };

  const create = useMutation({
    mutationFn: (input: SavingsPlanCreate) => apiCreateSavingsPlan(input),
    onSuccess: () => {
      setPlanEditor(null);
      setError(null);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const update = useMutation({
    mutationFn: (v: { planId: string; input: SavingsPlanCreate }) =>
      apiUpdateSavingsPlan(v.planId, v.input),
    onSuccess: () => {
      setPlanEditor(null);
      setError(null);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const remove = useMutation({
    mutationFn: (planId: string) => apiDeleteSavingsPlan(planId),
    onSuccess: () => {
      setDeleting(null);
      setError(null);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const contribute = useMutation({
    mutationFn: (v: { planId: string; input: SavingsContributionCreate }) =>
      apiAddSavingsContribution(v.planId, v.input),
    onSuccess: () => {
      setContribOpen(false);
      setError(null);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
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

  const view = viewQuery.data;
  const accounts: AccountPublic[] = accountsQuery.data?.accounts ?? [];
  const sourceAccounts = accounts.filter((account) => account.type !== 'SAVINGS');
  const currency: Currency = view?.currency ?? 'MGA';
  const plan = view?.plan ?? null;
  const busy =
    create.isPending || update.isPending || remove.isPending || contribute.isPending;

  function handleSubmitPlan(input: SavingsPlanCreate) {
    if (planEditor?.initial) {
      update.mutate({ planId: planEditor.initial.id, input });
    } else {
      create.mutate(input);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-[28px]">Épargne</h1>

      <div className="mx-auto max-w-3xl px-4 py-8">
        {error && (
          <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            aria-label="Mois précédent"
            onClick={() => setMonthKey((m) => shiftMonth(m, -1))}
            className="rounded-lg border border-neutral-300 px-3 py-2 text-lg leading-none text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            ‹
          </button>
          <label className="flex flex-wrap items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900">
            <span className="font-medium text-neutral-800 dark:text-neutral-100">
              {view ? monthLabel(view.month) : monthLabel(monthKey)}
            </span>
            <input
              type="month"
              aria-label="Mois"
              value={monthKey}
              onChange={(e) => {
                if (e.target.value) {
                  setMonthKey(e.target.value);
                  setPlanEditor(null);
                  setContribOpen(false);
                }
              }}
              className="bg-transparent text-sm outline-none"
            />
          </label>
          <button
            type="button"
            aria-label="Mois suivant"
            onClick={() => setMonthKey((m) => shiftMonth(m, 1))}
            className="rounded-lg border border-neutral-300 px-3 py-2 text-lg leading-none text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            ›
          </button>
        </div>

        {viewQuery.isLoading && (
          <p className="mt-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
            Chargement…
          </p>
        )}

        {view && (
          <div className="mt-6 space-y-4">
            {/* Épargne RÉELLE (solde dérivé) — distincte des contributions. */}
            <section className={card}>
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                Épargne réelle
              </p>
              <p className="mt-1 text-3xl font-semibold tabular-nums">
                {view.savingsAccount
                  ? formatMoney(view.savingsAccount.balance, currency)
                  : '—'}
              </p>
              <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                Solde COURANT de votre compte Épargne (dérivé des transferts
                réels). Il est distinct des contributions au plan du mois.
              </p>
            </section>

            {!plan && !planEditor && (
              <section className={card}>
                <p className="text-sm font-medium">Aucun objectif pour ce mois</p>
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  Définissez un objectif d’épargne mensuel : montant fixe ou
                  pourcentage des revenus réellement reçus. Le plan ne déplace
                  jamais d’argent : il vous aide à suivre vos vrais transferts
                  vers Épargne.
                </p>
                <button
                  type="button"
                  className={`${btn} mt-3`}
                  onClick={() => {
                    setError(null);
                    setContribOpen(false);
                    setPlanEditor({ initial: null });
                  }}
                >
                  Définir un objectif du mois
                </button>
              </section>
            )}

            {plan && !planEditor && (
              <section className={card}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400">
                      Objectif du mois
                    </p>
                    <p className="mt-1 text-2xl font-semibold tabular-nums">
                      {formatMoney(view.target ?? '0', currency)}
                    </p>
                  </div>
                  {view.progress && <ProgressBadge progress={view.progress} />}
                </div>

                <div className="mt-4">
                  <ProgressBar
                    target={view.target ?? '0'}
                    contributed={view.contributed ?? '0'}
                  />
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <Metric
                    label="Déjà épargné"
                    value={formatMoney(view.contributed ?? '0', currency)}
                  />
                  <Metric
                    label="Reste"
                    value={formatMoney(view.remaining ?? '0', currency)}
                  />
                  <Metric
                    label={view.eligibleIncome !== null ? 'Revenus reçus' : 'Mode'}
                    value={
                      view.eligibleIncome !== null
                        ? formatMoney(view.eligibleIncome, currency)
                        : 'Montant fixe'
                    }
                  />
                </div>

                {view.progress === 'NO_INCOME_YET' && (
                  <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
                    En attente de revenus reçus ce mois-ci : la cible sera
                    calculée dès qu’un revenu réel sera enregistré.
                  </p>
                )}

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={btn}
                    disabled={contribOpen || busy}
                    onClick={() => {
                      setError(null);
                      setPlanEditor(null);
                      setContribOpen(true);
                    }}
                  >
                    J’ai épargné
                  </button>
                  <button
                    type="button"
                    className={btnOut}
                    onClick={() => {
                      setError(null);
                      setContribOpen(false);
                      setPlanEditor({ initial: plan });
                    }}
                  >
                    Modifier l’objectif
                  </button>
                  <button
                    type="button"
                    className={btnDanger}
                    onClick={() => {
                      setError(null);
                      setDeleting(plan);
                    }}
                  >
                    Supprimer l’objectif
                  </button>
                </div>
              </section>
            )}

            {planEditor && (
              <PlanEditor
                monthKey={monthKey}
                currency={currency}
                initial={planEditor.initial}
                busy={busy}
                err={error}
                onSubmit={handleSubmitPlan}
                onCancel={() => {
                  setPlanEditor(null);
                  setError(null);
                }}
              />
            )}

            {contribOpen && plan && (
              <ContributionEditor
                accounts={sourceAccounts}
                currency={currency}
                busy={busy}
                err={error}
                onSubmit={(input) =>
                  contribute.mutate({ planId: plan.id, input })
                }
                onCancel={() => {
                  setContribOpen(false);
                  setError(null);
                }}
              />
            )}

            {plan && view.contributions.length > 0 && (
              <section className={card}>
                <h2 className="text-base font-semibold">
                  Contributions de ce mois
                </h2>
                <ul className="mt-2 divide-y divide-neutral-200 dark:divide-neutral-800">
                  {view.contributions.map((item) => (
                    <li
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <div>
                        <div className="text-sm font-medium">
                          {ACCOUNT_TYPE_LABELS[item.transfer.source.type]} → Épargne
                        </div>
                        <div className="text-xs text-neutral-500 dark:text-neutral-400">
                          {item.transfer.occurredAt ?? 'Date inconnue'}
                          {item.transfer.description
                            ? ` · ${item.transfer.description}`
                            : ''}
                        </div>
                      </div>
                      <div className="text-right text-sm">
                        <div className="tabular-nums font-semibold">
                          {formatMoney(item.transfer.amount, currency)}
                        </div>
                        {item.transfer.feeAmount !== '0' && (
                          <div className="text-xs text-neutral-500 dark:text-neutral-400">
                            Frais : {formatMoney(item.transfer.feeAmount, currency)}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>

      {deleting && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
          >
            <h2 className="text-base font-semibold">Supprimer cet objectif ?</h2>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
              Le plan disparaît de ce mois, mais aucun transfert réel vers
              Épargne ne sera annulé : l’argent déjà épargné reste sur votre
              compte Épargne.
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
  );
}
