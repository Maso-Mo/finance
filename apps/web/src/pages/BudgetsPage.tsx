import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BudgetStatus,
  CategoryPublic,
  Currency,
  MonthlyBudgetCreate,
} from '@finance/shared-types';
import { useAuth } from '../auth/AuthContext';
import {
  apiCreateBudget,
  apiDeleteBudget,
  apiGetBudgets,
  apiGetCategories,
  apiUpdateBudget,
} from '../auth/api';
import { ThemeToggle } from '../components/ThemeToggle';
import { formatMoney, toISODate } from '../lib/format';

/**
 * Page « Budgets » (étape 8).
 *
 * Un budget est une LIMITE analytique : il n'est JAMAIS de l'argent.
 *  - il ne crée ni ne modifie aucune Transaction, aucun compte ni solde ;
 *  - « Dépensé » est TOUJOURS dérivé du journal réel des Transactions ;
 *  - statut binaire affiché EN TEXTE : Vert / Dépassé (lisible sans couleur) ;
 *  - prévision = estimation simple de fin de mois, jamais une certitude.
 * Mobile : blocs verticaux, aucun tableau à défilement horizontal.
 */

const MONTHS_FR = [
  'Janvier',
  'Février',
  'Mars',
  'Avril',
  'Mai',
  'Juin',
  'Juillet',
  'Août',
  'Septembre',
  'Octobre',
  'Novembre',
  'Décembre',
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

/** Décalage de mois pur (« YYYY-MM » + offset) : aucune dépendance Date. */
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

function StatusBadge({ status }: { status: BudgetStatus }) {
  return status === 'VERT' ? (
    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
      Vert
    </span>
  ) : (
    <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:bg-red-900/40 dark:text-red-300">
      Dépassé
    </span>
  );
}

/** Barre de progression SIMPLE (visuelle ; le texte reste la référence lisible). */
function ProgressBar({
  spent,
  budget,
  status,
}: {
  spent: string;
  budget: string;
  status: BudgetStatus;
}) {
  const ratio =
    Number(budget) > 0
      ? Math.min(100, (Number(spent) / Number(budget)) * 100)
      : 0;
  const fill =
    status === 'DEPASSE'
      ? 'h-full rounded-full bg-red-500'
      : 'h-full rounded-full bg-emerald-500';
  return (
    <div
      role="img"
      aria-label={`Utilisation du budget : ${Math.round(ratio)} %`}
      className="h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
    >
      <div className={fill} style={{ width: `${ratio}%` }} />
    </div>
  );
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

export default function BudgetsPage() {
  const { status, user, signOut } = useAuth();
  const queryClient = useQueryClient();
  const [today] = useState(() => toISODate(new Date()));
  const [monthKey, setMonthKey] = useState(() =>
    monthKeyOf(toISODate(new Date())),
  );
  const [globalFormOpen, setGlobalFormOpen] = useState(false);
  const [categoryFormOpen, setCategoryFormOpen] = useState(false);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(
    null,
  );
  const [deleting, setDeleting] = useState<{
    id: string;
    label: string;
    amount: string;
    isGlobal: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: apiGetCategories,
    enabled: status === 'authenticated',
  });
  const budgetsQuery = useQuery({
    queryKey: ['budgets', monthKey],
    queryFn: () => apiGetBudgets(monthKey, today),
    enabled: status === 'authenticated',
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['budgets'] });
  };

  const closeForms = () => {
    setGlobalFormOpen(false);
    setCategoryFormOpen(false);
    setEditingCategoryId(null);
    setError(null);
  };

  const create = useMutation({
    mutationFn: (input: MonthlyBudgetCreate) => apiCreateBudget(input),
    onSuccess: () => {
      closeForms();
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const update = useMutation({
    mutationFn: (v: { id: string; amount: string }) =>
      apiUpdateBudget(v.id, v.amount),
    onSuccess: () => {
      closeForms();
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const remove = useMutation({
    mutationFn: (budgetId: string) => apiDeleteBudget(budgetId),
    onSuccess: () => {
      setDeleting(null);
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

  const data = budgetsQuery.data;
  const currency: Currency = data?.currency ?? 'MGA';
  const categories: CategoryPublic[] = categoriesQuery.data?.categories ?? [];
  const budgetedCategoryIds = new Set(
    (data?.categoryBudgets ?? []).map((b) => b.category.id),
  );
  const availableCategories = categories.filter(
    (c) => !budgetedCategoryIds.has(c.id),
  );
  const busy = create.isPending || update.isPending || remove.isPending;

  function startGlobalForm() {
    setError(null);
    setGlobalFormOpen(true);
    setCategoryFormOpen(false);
    setEditingCategoryId(null);
  }

  function startCategoryForm() {
    setError(null);
    setCategoryFormOpen(true);
    setGlobalFormOpen(false);
    setEditingCategoryId(null);
  }

  function askDelete(target: {
    id: string;
    label: string;
    amount: string;
    isGlobal: boolean;
  }) {
    setError(null);
    setDeleting(target);
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
          <h1 className="text-lg font-semibold">Budgets</h1>
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
        {error && (
          <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}

        {/* Sélecteur de mois : ‹ mois › + saisie directe. */}
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
              {data ? monthLabel(data.month) : monthLabel(monthKey)}
            </span>
            <input
              type="month"
              aria-label="Mois"
              value={monthKey}
              onChange={(e) => {
                if (e.target.value) {
                  setMonthKey(e.target.value);
                }
              }}
              className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
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

        <div className="mt-6 space-y-4">
          {/* Synthèse du mois : dépensé réel + prévision (déterministes). */}
          <section className={card}>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Dépenses réelles du mois
            </p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Metric label="Dépensé" value={data ? formatMoney(data.spent, currency) : '…'} />
              <Metric
                label="Prévision fin de mois"
                value={data ? formatMoney(data.forecast, currency) : '…'}
              />
            </div>
            <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              Estimation = dépenses réelles du mois ÷ jours écoulés × jours du mois.
              Les revenus futurs et dépenses planifiées n’entrent jamais dans ce calcul.
            </p>
          </section>
          {/* Budget global du mois. */}
          <section className={card}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold">Budget global</h2>
              {!globalFormOpen &&
                (data?.globalBudget ? (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={startGlobalForm}
                      className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                    >
                      Modifier
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        data.globalBudget &&
                        askDelete({
                          id: data.globalBudget.id,
                          label: 'Budget global',
                          amount: data.globalBudget.amount,
                          isGlobal: true,
                        })
                      }
                      className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                    >
                      Supprimer
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={startGlobalForm} className={btn}>
                    Définir un budget global
                  </button>
                ))}
            </div>

            {globalFormOpen && (
              <BudgetAmountForm
                title={
                  data?.globalBudget
                    ? 'Modifier le budget global'
                    : 'Nouveau budget global'
                }
                amountLabel="Montant du budget global"
                initialAmount={data?.globalBudget?.amount ?? ''}
                busy={busy}
                err={null}
                onSubmit={(amount) => {
                  if (data?.globalBudget) {
                    update.mutate({ id: data.globalBudget.id, amount });
                  } else {
                    create.mutate({ month: monthKey, amount });
                  }
                }}
                onCancel={() => setGlobalFormOpen(false)}
              />
            )}

            {!globalFormOpen &&
              (data?.globalBudget ? (
                <div className="mt-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-lg font-semibold tabular-nums text-neutral-800 dark:text-neutral-100">
                      {formatMoney(data.globalBudget.amount, currency)}
                    </p>
                    <StatusBadge status={data.globalBudget.status} />
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <Metric label="Dépensé" value={formatMoney(data.spent, currency)} />
                    <Metric
                      label="Restant"
                      value={formatMoney(data.globalBudget.remaining, currency)}
                    />
                    <Metric
                      label="Prévision fin de mois"
                      value={formatMoney(data.globalBudget.forecast, currency)}
                    />
                  </div>
                  <ProgressBar
                    spent={data.spent}
                    budget={data.globalBudget.amount}
                    status={data.globalBudget.status}
                  />
                </div>
              ) : (
                <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
                  Aucun budget global pour ce mois. Le budget est une limite — il ne
                  modifie jamais vos comptes ni le Total disponible.
                </p>
              ))}
          </section>
          {/* Budgets par catégorie. */}
          <section className={card}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold">Budgets par catégorie</h2>
              {!categoryFormOpen &&
                availableCategories.length > 0 && (
                  <button type="button" onClick={startCategoryForm} className={btnOut}>
                    Ajouter un budget par catégorie
                  </button>
                )}
            </div>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              La somme des budgets par catégorie n’a pas à égaler le budget global :
              chaque limite est indépendante.
            </p>

            {categoryFormOpen && (
              <CategoryAddForm
                monthKey={monthKey}
                categories={availableCategories}
                busy={busy}
                err={null}
                onSubmit={(categoryId, amount) =>
                  create.mutate({ month: monthKey, categoryId, amount })
                }
                onCancel={() => setCategoryFormOpen(false)}
              />
            )}

            {data && data.categoryBudgets.length === 0 && !categoryFormOpen && (
              <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
                Aucun budget par catégorie pour ce mois. Choisissez « Ajouter un
                budget par catégorie » pour limiter une catégorie de dépenses.
              </p>
            )}

            {data && data.categoryBudgets.length > 0 && (
              <ul className="mt-4 space-y-3">
                {data.categoryBudgets.map((budget) => (
                  <li
                    key={budget.id}
                    className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950/30"
                  >
                    {editingCategoryId === budget.id ? (
                      <BudgetAmountForm
                        title={`Modifier le budget ${budget.category.name}`}
                        amountLabel={`Montant du budget ${budget.category.name}`}
                        initialAmount={budget.amount}
                        busy={busy}
                        err={null}
                        onSubmit={(amount) =>
                          update.mutate({ id: budget.id, amount })
                        }
                        onCancel={() => setEditingCategoryId(null)}
                      />
                    ) : (
                      <>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                              {budget.category.name}
                            </span>
                            <StatusBadge status={budget.status} />
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingCategoryId(budget.id);
                                setGlobalFormOpen(false);
                                setCategoryFormOpen(false);
                              }}
                              className="rounded-lg border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                            >
                              Modifier
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                askDelete({
                                  id: budget.id,
                                  label: budget.category.name,
                                  amount: budget.amount,
                                  isGlobal: false,
                                })
                              }
                              className="rounded-lg border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                            >
                              Supprimer
                            </button>
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <Metric label="Budget" value={formatMoney(budget.amount, currency)} />
                          <Metric label="Dépensé" value={formatMoney(budget.spent, currency)} />
                          <Metric label="Restant" value={formatMoney(budget.remaining, currency)} />
                          <Metric label="Prévision" value={formatMoney(budget.forecast, currency)} />
                        </div>
                        <div className="mt-3">
                          <ProgressBar
                            spent={budget.spent}
                            budget={budget.amount}
                            status={budget.status}
                          />
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="text-xs text-neutral-500 dark:text-neutral-500">
            Les budgets sont des limites analytiques. « Dépensé » provient du
            journal réel des Transactions (source de vérité) ; les budgets ne
            modifient jamais un compte, un solde ni le Total disponible. La
            prévision est une estimation simple, pas une certitude.
          </p>
        </div>
      </div>

      {deleting && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            <h2 className="text-base font-semibold">
              Supprimer {deleting.isGlobal ? 'le budget global' : `le budget ${deleting.label}`} ?
            </h2>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
              Limite actuelle : {formatMoney(deleting.amount, currency)}. Supprimer
              un budget ne supprime et ne modifie jamais une Transaction, un compte
              ni le Total disponible.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => remove.mutate(deleting.id)}
                className={btnDanger}
              >
                {busy ? '…' : 'Oui, supprimer'}
              </button>
              <button
                type="button"
                onClick={() => setDeleting(null)}
                className="rounded-lg border border-neutral-300 px-4 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:text-neutral-200"
              >
                Annuler
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/** Formulaire simple de limite (global ou catégorie) : montant uniquement. */
function BudgetAmountForm({
  title,
  amountLabel,
  initialAmount,
  busy,
  err,
  onSubmit,
  onCancel,
}: {
  title: string;
  amountLabel: string;
  initialAmount: string;
  busy: boolean;
  err: string | null;
  onSubmit: (amount: string) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(initialAmount);
  const [invalid, setInvalid] = useState<string | null>(null);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = amount.trim();
    if (!trimmed) {
      setInvalid('Indiquez un montant.');
      return;
    }
    setInvalid(null);
    onSubmit(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-3">
      <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{title}</p>
      <label className="block">
        <span className="text-sm font-medium">{amountLabel}</span>
        <input
          type="text"
          inputMode="decimal"
          autoFocus
          aria-label={amountLabel}
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
          className={inputCls}
        />
      </label>
      {invalid && <p className="text-sm text-red-600 dark:text-red-400">{invalid}</p>}
      {err && <p className="text-sm text-red-600 dark:text-red-400">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={btn}>
          {busy ? '…' : 'Enregistrer'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={btnOut}>
          Annuler
        </button>
      </div>
    </form>
  );
}

/** Ajout d'un budget par catégorie : choix de la catégorie + montant. */
function CategoryAddForm({
  monthKey,
  categories,
  busy,
  err,
  onSubmit,
  onCancel,
}: {
  monthKey: string;
  categories: CategoryPublic[];
  busy: boolean;
  err: string | null;
  onSubmit: (categoryId: string, amount: string) => void;
  onCancel: () => void;
}) {
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = amount.trim();
    if (!categoryId) {
      setInvalid('Choisissez une catégorie.');
      return;
    }
    if (!trimmed) {
      setInvalid('Indiquez un montant.');
      return;
    }
    setInvalid(null);
    onSubmit(categoryId, trimmed);
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-3">
      <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
        Nouveau budget par catégorie — {monthKey}
      </p>
      {categories.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Toutes les catégories ont déjà un budget pour ce mois.
        </p>
      ) : (
        <>
          <label className="block">
            <span className="text-sm font-medium">Catégorie</span>
            <select
              aria-label="Catégorie"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className={inputCls}
            >
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium">Montant du budget catégorie</span>
            <input
              type="text"
              inputMode="decimal"
              aria-label="Montant du budget catégorie"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
              className={inputCls}
            />
          </label>
          {invalid && <p className="text-sm text-red-600 dark:text-red-400">{invalid}</p>}
          {err && <p className="text-sm text-red-600 dark:text-red-400">{err}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={btn}>
              {busy ? '…' : 'Créer le budget'}
            </button>
            <button type="button" onClick={onCancel} disabled={busy} className={btnOut}>
              Annuler
            </button>
          </div>
        </>
      )}
    </form>
  );
}

