import { useSnapshotQuery } from '../lib/useSnapshotQuery';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ACCOUNT_TYPES, CURRENCIES } from '@finance/shared-types';
import type {
  AccountPublic,
  AccountType,
  Currency,
  TransactionPublic,
} from '@finance/shared-types';
import { useAuth } from '../auth/AuthContext';
import {
  apiGetAccounts,
  apiGetBudgets,
  apiGetForecast,
  apiGetReminders,
  apiGetTransactions,
  apiSetCurrency,
  apiSetTargetBalance,
} from '../auth/api';
import { BadgeDepasse, BadgeVert, Button, cx, Metric, Panel, ProgressBar } from '../components/ui';
import { IconArrowDown, IconArrowRight, IconArrowUp, IconTarget, IconWallet } from '../components/icons';
import { ACCOUNT_TYPE_LABELS, formatMoney, toISODate } from '../lib/format';
import { AnalyticsSection } from '../components/analytics';

const MONTH_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

function monthLabel(key: string): string {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  return `${MONTH_FR[(m || 1) - 1]} ${y}`;
}

function dateTitle(date: Date): string {
  return date.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

const ACCOUNT_COLORS: Record<AccountType, string> = {
  BANK: 'var(--violet)',
  MVOLA: 'var(--coral)',
  ORANGE_MONEY: 'var(--lemon)',
  AIRTEL_MONEY: 'var(--brand)',
  CASH: 'var(--positive)',
  SAVINGS: 'var(--ink-3)',
};

function signMoney(tx: TransactionPublic, currency: Currency): string {
  const formatted = formatMoney(tx.amount, currency);
  return tx.type === 'EXPENSE' ? `-${formatted}` : `+${formatted}`;
}

export default function HomePage() {
  const { status } = useAuth();
  const queryClient = useQueryClient();
  const [showDetails, setShowDetails] = useState(false);

  const today = useMemo(() => toISODate(new Date()), []);
  const monthKey = today.slice(0, 7);

  const dashboardQuery = useSnapshotQuery('dashboard', ['dashboard'], apiGetAccounts);

  const remindersQuery = useQuery({
    queryKey: ['reminders'],
    queryFn: () => apiGetReminders(today),
    enabled: status === 'authenticated',
  });

  const forecastQuery = useSnapshotQuery('forecast', ['financial-forecast', today], () => apiGetForecast(today));

  const budgetsQuery = useSnapshotQuery('budgets', ['budgets', monthKey, today], () => apiGetBudgets(monthKey, today));

  const recentQuery = useQuery({
    queryKey: ['transactions', 1],
    queryFn: () => apiGetTransactions(1, 5),
    enabled: status === 'authenticated',
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, balance }: { id: string; balance: string }) =>
      apiSetTargetBalance(id, balance),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      void queryClient.invalidateQueries({ queryKey: ['budgets'] });
    },
  });

  const currencyMutation = useMutation({
    mutationFn: apiSetCurrency,
    onSuccess: () => {
      void queryClient.invalidateQueries();
      void queryClient.invalidateQueries({ queryKey: ['budgets'] });
    },
  });

  const accounts = useMemo(() => {
    const data = dashboardQuery.data;
    if (!data) return [];
    return ACCOUNT_TYPES.map((type) =>
      data.accounts.find((a) => a.type === type),
    ).filter((a): a is AccountPublic => Boolean(a));
  }, [dashboardQuery.data]);

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

  const data = dashboardQuery.data;
  const currency: Currency = data?.currency ?? 'MGA';
  const totalAvailable = data?.totalAvailable ?? '0';
  const isLoading = dashboardQuery.isLoading;
  const isError = dashboardQuery.isError;
  const error = dashboardQuery.error;

  const savingsAccount = accounts.find((a) => a.type === 'SAVINGS');
  const spendingAccounts = accounts.filter((a) => a.type !== 'SAVINGS');
  const budget = budgetsQuery.data?.globalBudget ?? null;
  const spent = budgetsQuery.data?.spent;
  const forecast = forecastQuery.data;
  const reminders = remindersQuery.data;
  const toVerify = reminders
    ? [
        ...reminders.overdue.map((p) => ({ item: p, bucket: 'overdue' as const })),
        ...reminders.dueToday.map((p) => ({ item: p, bucket: 'dueToday' as const })),
        ...reminders.upcoming.map((p) => ({ item: p, bucket: 'upcoming' as const })),
      ]
    : [];
  const recent = recentQuery.data?.transactions ?? [];

  const heroOpen = showDetails;

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      {/* Titre + actions du jour */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[26px] font-bold tracking-tight text-ink sm:text-3xl">Finance</h1>
          <p className="mt-0.5 text-sm capitalize text-ink2">{dateTitle(new Date())}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="currency-select">Devise principale</label>
          <select
            id="currency-select"
            value={currency}
            disabled={currencyMutation.isPending}
            onChange={(e) => currencyMutation.mutate(e.target.value as Currency)}
            className="field !w-auto !py-2 !text-xs"
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <Link to="/transactions" id="guide-add" className="btn btn-primary gap-1.5">
            <IconArrowRight size={16} /> Ajouter
          </Link>
        </div>
      </div>

      {/* ===== Héros : Total disponible ===== */}
      <section
        id="guide-total"
        aria-label="Total disponible"
        className="card relative overflow-hidden p-6 sm:p-8"
        style={{
          background:
            'linear-gradient(150deg, var(--surface) 0%, color-mix(in srgb, var(--surface-2) 55%, var(--surface)) 100%)',
        }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full opacity-50"
          style={{ background: 'radial-gradient(circle, var(--brand-soft) 0%, transparent 70%)' }}
        />
        <div className="relative">
          <div className="flex items-center gap-2 text-[13px] font-medium text-ink2">
            <IconWallet size={15} className="text-brand-strong" />
            Total disponible
          </div>
          {dashboardQuery.offline && <p role="status" className="mt-2 text-sm text-ink2">Hors connexion · Dernière mise à jour : {new Date(dashboardQuery.syncedAt!).toLocaleString('fr-FR')}</p>}
          <p className="mt-3 break-words text-[40px] font-bold leading-none tracking-tight num text-ink sm:text-6xl">
            {isLoading ? '…' : formatMoney(totalAvailable, currency)}
          </p>
          <p className="mt-2.5 text-xs text-ink3">
            Banque · MVola · Orange Money · Airtel Money · Cash — hors Épargne.
          </p>

          {isError && (
            <p
              role="alert"
              className="mt-3 rounded-xl px-3 py-2 text-sm font-medium text-red-600"
              style={{
                color: 'var(--danger)',
                background: 'color-mix(in srgb, var(--danger) 12%, transparent)',
              }}
            >
              {error instanceof Error ? error.message : 'Erreur de chargement.'}
            </p>
          )}

          {updateMutation.isError && <p role="alert" className="mt-3 text-sm text-danger">{updateMutation.error.message}</p>}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              id="guide-details"
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              aria-expanded={heroOpen}
              className={heroOpen ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'}
            >
              {heroOpen ? 'Masquer les détails' : 'Détails'}
            </button>
          </div>
        </div>

        {heroOpen && (
          <div className="relative mt-6 border-t pt-5" style={{ borderColor: 'var(--edge)' }}>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {spendingAccounts.map((account) => (
                <AccountRow
                    key={account.id}
                    account={account}
                    currency={currency}
                    onUpdate={(id, balance) => updateMutation.mutate({ id, balance })}
                  />
              ))}
            </ul>
            <div
              className="mt-4 flex items-center justify-between gap-3 rounded-2xl px-3 py-3"
              style={{ background: 'var(--surface-2)' }}
            >
              <div className="flex items-center gap-3">
                <span
                  className="h-3 w-3 rounded-full"
                  style={{ background: ACCOUNT_COLORS.SAVINGS }}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">Épargne</p>
                  <p className="text-xs text-ink3">Exclue du Total disponible</p>
                </div>
              </div>
              <p className="num text-base font-bold text-ink sm:text-lg">
                {savingsAccount
                  ? formatMoney(savingsAccount.balance, currency)
                  : formatMoney('0', currency)}
              </p>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-ink3">
              Chaque solde est dérivé (solde de départ + opérations du journal).
              « Corriger le solde » ajuste le solde de départ tant qu’aucun
              mouvement n’existe, puis crée un ajustement. L’épargne n’est
              jamais incluse dans le Total disponible.
            </p>
          </div>
        )}
      </section>


      {/* ===== A. Dépenses du mois · B. Prévision fin de mois · Épargne ===== */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
        <Panel id="guide-spent" className="p-4 sm:p-5">
          {budgetsQuery.offline && <p className="text-xs text-ink2">Hors connexion · Période {budgetsQuery.data?.month} · {new Date(budgetsQuery.syncedAt!).toLocaleString('fr-FR')}</p>}
          <Metric
            label="Dépensé ce mois"
            value={
              budgetsQuery.isLoading
                ? '…'
                : spent != null
                  ? formatMoney(spent, currency)
                  : formatMoney('0', currency)
            }
            tone="negative"
          />
          <p className="mt-1 text-[11px] text-ink3">{monthLabel(monthKey)}</p>
        </Panel>
        <Panel id="guide-forecast" className="p-4 sm:p-5">
          {forecastQuery.offline && <p className="text-xs text-ink2">Hors connexion · {new Date(forecastQuery.syncedAt!).toLocaleString('fr-FR')}</p>}
          <Metric
            label="Prévision fin de mois"
            value={
              forecast
                ? formatMoney(forecast.monthEndAvailableForecast, currency)
                : '…'
            }
            tone={
              forecast && forecast.monthEndAvailableForecast.startsWith('-')
                ? 'negative'
                : 'brand'
            }
          />
          <p className="mt-1 text-[11px] text-ink3">Estimation, jamais une certitude</p>
        </Panel>
        <Panel className="col-span-2 p-4 sm:p-5 lg:col-span-1">
          <p className="text-xs font-medium text-ink2">Épargne aujourd’hui</p>
          <p className="mt-0.5 num text-xl font-bold tracking-tight text-ink">
            {savingsAccount
              ? formatMoney(savingsAccount.balance, currency)
              : formatMoney('0', currency)}
          </p>
          <Link
            to="/savings"
            className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-brand-strong"
          >
            Voir le plan d’épargne <IconArrowRight size={13} />
          </Link>
        </Panel>
      </div>

      {/* ===== C. Budget global ===== */}
      {budget ? (
        <Panel id="guide-budget" className="p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-ink">Limite de dépenses du mois</p>
            {budget.status === 'VERT' ? <BadgeVert /> : <BadgeDepasse />}
          </div>
          <div className="mt-3 flex items-end justify-between gap-3">
            <p className="num text-2xl font-bold tracking-tight text-ink">
              {spent != null ? formatMoney(spent, currency) : formatMoney('0', currency)}
            </p>
            <p className="num text-sm text-ink2">
              sur {formatMoney(budget.amount, currency)}
            </p>
          </div>
          <ProgressBar
            className="mt-3"
            tone={budget.status === 'VERT' ? 'brand' : 'danger'}
            ratio={
              Number(budget.amount) > 0 ? Number(spent ?? '0') / Number(budget.amount) : 0
            }
          />
          <div className="mt-2 flex items-center justify-between text-xs text-ink2">
            <span>
              Restant : <span className="num">{formatMoney(budget.remaining, currency)}</span>
            </span>
            <Link to="/budgets" className="font-semibold text-brand-strong">
              Détail du mois
            </Link>
          </div>
        </Panel>
      ) : (
        <Panel id="guide-budget" className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <p className="text-sm font-semibold text-ink">Limite de dépenses du mois</p>
            <p className="text-xs text-ink2">
              Aucune limite définie pour {monthLabel(monthKey).toLowerCase()}.
            </p>
          </div>
          <Link to="/budgets" className="btn btn-secondary btn-sm">
            Définir un budget
          </Link>
        </Panel>
      )}


      <AnalyticsSection currency={currency} />

      {/* ===== D. À vérifier ===== */}
      <Panel id="guide-todo" className="p-5 sm:p-6">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold tracking-tight text-ink">À vérifier</h2>
          {reminders && toVerify.length > 0 ? (
            <span className="badge-soft">{toVerify.length}</span>
          ) : null}
        </div>
        {!reminders ? (
          <p className="mt-3 text-sm text-ink3">…</p>
        ) : toVerify.length === 0 ? (
          <p className="mt-3 text-sm text-ink2">Rien à confirmer pour le moment. 🎉</p>
        ) : (
          <ul className="mt-2 divide-y" style={{ borderColor: 'var(--edge)' }}>
            {toVerify.slice(0, 5).map(({ item: planned, bucket }) => (
              <li key={planned.id} className="row">
                <span
                  className={cx(
                    'h-2 w-2 shrink-0 rounded-full',
                    bucket === 'overdue' && 'bg-[var(--danger)]',
                    bucket === 'dueToday' && 'bg-[var(--brand)]',
                    bucket === 'upcoming' && 'bg-[var(--lemon)]',
                  )}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">Paiement prévu</p>
                  <p className="truncate text-xs text-ink2">
                    {planned.description ??
                      planned.category?.name ??
                      (planned.categoryUnknown ? 'Sans catégorie' : 'Dépense planifiée')}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="num text-sm font-semibold text-ink">
                    −{formatMoney(planned.amount, currency)}
                  </p>
                  <p className="text-[11px] text-ink3">
                    {bucket === 'overdue'
                      ? 'En retard'
                      : bucket === 'dueToday'
                        ? "Aujourd'hui"
                        : 'Bientôt'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {reminders &&
        reminders.overdue.length + reminders.dueToday.length + reminders.upcoming.length >
          0 ? (
          <Link
            to="/planned"
            className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-brand-strong"
          >
            Voir les dépenses planifiées <IconArrowRight size={13} />
          </Link>
        ) : null}
      </Panel>


      {/* ===== E. Transactions récentes ===== */}
      <Panel id="guide-recent" className="p-5 sm:p-6">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold tracking-tight text-ink">
            Transactions récentes
          </h2>
          <Link to="/transactions" className="text-xs font-semibold text-brand-strong">
            Tout voir
          </Link>
        </div>
        {recentQuery.isLoading ? (
          <p className="mt-3 text-sm text-ink3">…</p>
        ) : recent.length === 0 ? (
          <div className="mt-3 flex items-center gap-3">
            <IconWallet size={18} className="text-ink3" />
            <p className="text-sm text-ink2">
              Aucune opération pour l’instant.{' '}
              <Link to="/transactions" className="font-semibold text-brand-strong">
                Ajouter la première
              </Link>
            </p>
          </div>
        ) : (
          <ul className="mt-2 divide-y" style={{ borderColor: 'var(--edge)' }}>
            {recent.slice(0, 5).map((tx) => {
              const isExpense = tx.type === 'EXPENSE';
              const Icon = isExpense ? IconArrowDown : IconArrowUp;
              const label = tx.description ?? (isExpense
                ? (tx.category?.name ?? (tx.categoryUnknown ? 'Catégorie ?' : 'Dépense'))
                : 'Revenu');
              return (
                <li key={tx.id} className="row">
                  <span
                    className={cx(
                      'flex h-9 w-9 items-center justify-center rounded-xl',
                      isExpense
                        ? 'bg-[color-mix(in_srgb,var(--danger)_13%,transparent)] text-[var(--danger)]'
                        : 'bg-[color-mix(in_srgb,var(--positive)_13%,transparent)] text-[var(--positive)]',
                    )}
                    aria-hidden="true"
                  >
                    <Icon size={17} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{label}</p>
                    <p className="truncate text-xs text-ink2">
                      {isExpense ? 'Dépense' : 'Revenu'}
                      {tx.occurredAt
                        ? ` · ${new Date(`${tx.occurredAt}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`
                        : ' · Date ?'}
                    </p>
                  </div>
                  <p
                    className={cx(
                      'shrink-0 num text-sm font-bold',
                      isExpense ? 'text-[var(--danger)]' : 'text-[var(--positive)]',
                    )}
                  >
                    {signMoney(tx, currency)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {/* Accès épargne mis en avant quand un compte épargne existe */}
      {savingsAccount && (
        <Link
          to="/savings"
          className="card card-hover flex items-center justify-between gap-3 p-4"
        >
          <span className="flex items-center gap-3">
            <span
              className="flex h-10 w-10 items-center justify-center rounded-2xl"
              style={{
                background: 'color-mix(in srgb, var(--violet) 18%, transparent)',
                color: 'var(--violet)',
              }}
            >
              <IconTarget size={19} />
            </span>
            <span>
              <span className="block text-sm font-semibold text-ink">
                Mes objectifs d’épargne
              </span>
              <span className="block text-xs text-ink2">
                Plan du mois et contributions
              </span>
            </span>
          </span>
          <IconArrowRight size={17} className="text-ink3" />
        </Link>
      )}
    </div>
  );
}


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
  const [value, setValue] = useState(account.balance);

  function startEditing() {
    setValue(account.balance);
    setEditing(true);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onUpdate(account.id, trimmed);
    setEditing(false);
  }

  return (
    <li
      className="flex items-center justify-between gap-3 rounded-2xl px-3 py-3"
      style={{ background: 'var(--surface-2)' }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="h-3 w-3 shrink-0 rounded-full"
          style={{ background: ACCOUNT_COLORS[account.type] }}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">
            {ACCOUNT_TYPE_LABELS[account.type]}
          </p>
          <p className="text-[11px] text-ink3">
            Départ : {formatMoney(account.initialBalance, currency)}
          </p>
        </div>
      </div>
      {!editing ? (
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={cx(
              'num text-sm font-bold',
              account.balance.startsWith('-') ? 'text-[var(--danger)]' : 'text-ink',
            )}
          >
            {formatMoney(account.balance, currency)}
          </span>
          <button
            type="button"
            onClick={startEditing}
            title="Déclarer le solde réel"
            className="btn btn-ghost btn-sm !px-2.5 !text-xs text-ink2"
          >
            Corriger
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex shrink-0 items-center gap-1.5">
          <input
            type="text"
            inputMode="decimal"
            aria-label={`Nouveau solde ${ACCOUNT_TYPE_LABELS[account.type]}`}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ''))}
            className="field !w-28 !py-1.5 !text-sm num"
          />
          <button type="submit" className="btn btn-primary btn-sm">OK</button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="btn btn-ghost btn-sm !px-2.5"
            aria-label="Annuler la correction"
          >
            Annuler
          </button>
        </form>
      )}
    </li>
  );
}

