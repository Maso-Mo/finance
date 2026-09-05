import { useMemo, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AccountPublic, CategoryPublic, Currency,
  PlannedExpenseCreate, PlannedExpenseConfirmPaid,
  PlannedExpensePublic, PlannedExpenseUpdate,
  RecurringExpenseCreate, RecurringExpensePublic,
} from '@finance/shared-types';
import { useAuth } from '../auth/AuthContext';
import {
  apiCancelPlannedExpense, apiConfirmPlannedExpensePaid,
  apiCreatePlannedExpense, apiCreateRecurringExpense,
  apiDeleteRecurringExpense, apiGetAccounts, apiGetCategories,
  apiGetPlannedExpenses, apiGetRecurringExpenses,
  apiSkipPlannedExpense, apiUpdatePlannedExpense, apiUpdateRecurringExpense,
} from '../auth/api';
import { ThemeToggle } from '../components/ThemeToggle';
import { formatMoney, toISODate } from '../lib/format';
import {
  buildConfirmPaidPayload, buildPlannedExpensePayload, buildRecurringExpensePayload,
} from '../lib/planned';

const inputCls = 'mt-1 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const btn = 'rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50';
const btnOut = 'rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800';
const btnDanger = 'rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50';
const card = 'rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900';

type FormKind = 'none' | 'one' | 'recur';

function dateHuman(value: string): string {
  return new Date(`${value}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}
function catName(item: { category: { name: string } | null; categoryUnknown: boolean }): string {
  return item.category?.name ?? (item.categoryUnknown ? 'Catégorie ?' : '—');
}

function errorsList(errors: string[]) {
  if (errors.length === 0) return null;
  return (
    <ul className="space-y-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
      {errors.map((e) => <li key={e}>{e}</li>)}
    </ul>
  );
}

function CField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

export default function PlannedExpensesPage() {
  const { status, user, signOut } = useAuth();
  const queryClient = useQueryClient();
  const [today] = useState(() => toISODate(new Date()));
  const [form, setForm] = useState<FormKind>('none');
  const [editing, setEditing] = useState<PlannedExpensePublic | null>(null);
  const [editingRule, setEditingRule] = useState<RecurringExpensePublic | null>(null);
  const [paying, setPaying] = useState<PlannedExpensePublic | null>(null);
  const [cancelId, setCancelId] = useState<PlannedExpensePublic | null>(null);
  const [skipId, setSkipId] = useState<PlannedExpensePublic | null>(null);
  const [disableId, setDisableId] = useState<RecurringExpensePublic | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accountsQuery = useQuery({ queryKey: ['dashboard'], queryFn: apiGetAccounts, enabled: status === 'authenticated' });
  const categoriesQuery = useQuery({ queryKey: ['categories'], queryFn: apiGetCategories, enabled: status === 'authenticated' });
  const plannedQuery = useQuery({ queryKey: ['planned', today], queryFn: () => apiGetPlannedExpenses(today), enabled: status === 'authenticated' });
  const recurringQuery = useQuery({ queryKey: ['recurring'], queryFn: apiGetRecurringExpenses, enabled: status === 'authenticated' });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['planned'] });
    void queryClient.invalidateQueries({ queryKey: ['recurring'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    void queryClient.invalidateQueries({ queryKey: ['reminders'] });
  };

  const create = useMutation({ mutationFn: apiCreatePlannedExpense, onSuccess: () => { setForm('none'); refresh(); }, onError: (e: Error) => setError(e.message) });
  const update = useMutation({ mutationFn: (v: { id: string; input: PlannedExpenseUpdate }) => apiUpdatePlannedExpense(v.id, v.input), onSuccess: () => { setEditing(null); setForm('none'); refresh(); }, onError: (e: Error) => setError(e.message) });
  const cancel = useMutation({ mutationFn: apiCancelPlannedExpense, onSuccess: () => { setCancelId(null); refresh(); }, onError: (e: Error) => setError(e.message) });
  const skip = useMutation({ mutationFn: apiSkipPlannedExpense, onSuccess: () => { setSkipId(null); refresh(); }, onError: (e: Error) => setError(e.message) });
  const confirmPaid = useMutation({ mutationFn: (v: { id: string; input: PlannedExpenseConfirmPaid }) => apiConfirmPlannedExpensePaid(v.id, v.input), onSuccess: () => { setPaying(null); refresh(); }, onError: (e: Error) => setError(e.message) });
  const createRecur = useMutation({ mutationFn: apiCreateRecurringExpense, onSuccess: () => { setForm('none'); refresh(); }, onError: (e: Error) => setError(e.message) });
  const updateRecur = useMutation({ mutationFn: (v: { id: string; input: RecurringExpenseCreate }) => apiUpdateRecurringExpense(v.id, v.input), onSuccess: () => { setEditingRule(null); setForm('none'); refresh(); }, onError: (e: Error) => setError(e.message) });
  const disable = useMutation({ mutationFn: apiDeleteRecurringExpense, onSuccess: () => { setDisableId(null); refresh(); }, onError: (e: Error) => setError(e.message) });

  const accounts: AccountPublic[] = accountsQuery.data?.accounts ?? [];
  const categories: CategoryPublic[] = categoriesQuery.data?.categories ?? [];
  const currency: Currency = accountsQuery.data?.currency ?? 'MGA';
  const planned = plannedQuery.data?.plannedExpenses ?? [];
  const recurring = recurringQuery.data?.recurringExpenses ?? [];

  const pendingGroups = useMemo(() => {
    const groups: Record<'overdue' | 'due' | 'upcoming' | 'later', PlannedExpensePublic[]> = {
      overdue: [], due: [], upcoming: [], later: [],
    };
    for (const item of planned) {
      if (item.status !== 'PENDING' || !item.bucket) continue;
      if (item.bucket in groups) groups[item.bucket as 'overdue' | 'due' | 'upcoming' | 'later'].push(item);
    }
    return groups;
  }, [planned]);
  const resolved = planned.filter((item) => item.status !== 'PENDING');

  if (status === 'loading') {
    return <div className="flex min-h-screen items-center justify-center bg-neutral-100 text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">Restauration de session…</div>;
  }
  if (status === 'guest') {
    return <Navigate to="/login" replace />;
  }

  const activeCount = pendingGroups.overdue.length + pendingGroups.due.length + pendingGroups.upcoming.length + pendingGroups.later.length;
  return (
    <main className="min-h-screen bg-neutral-100 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/" className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800">Accueil</Link>
          <h1 className="text-lg font-semibold">Dépenses à venir</h1>
          <span className="hidden text-xs text-neutral-500 sm:inline dark:text-neutral-400">{user?.email}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ThemeToggle />
          <button type="button" onClick={() => void signOut()} className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800">Déconnexion</button>
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-4 py-8">
        {error && <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
        {form === 'none' && !paying && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => { setForm('one'); setEditing(null); }} className={btn}>Nouvelle dépense future</button>
            <button type="button" onClick={() => { setForm('recur'); setEditingRule(null); }} className={btnOut}>Nouvelle dépense mensuelle</button>
          </div>
        )}
        {form === 'one' && (
          <div className="mb-6">
            <PlannedOneForm categories={categories} initial={editing ?? undefined}
              busy={create.isPending || update.isPending} err={error}
              onSubmit={(input) => editing ? update.mutate({ id: editing.id, input }) : create.mutate(input)}
              onCancel={() => { setForm('none'); setEditing(null); setError(null); }} />
          </div>
        )}
        {form === 'recur' && (
          <div className="mb-6">
            <RecurForm categories={categories} initial={editingRule ?? undefined}
              busy={createRecur.isPending || updateRecur.isPending} err={error}
              onSubmit={(input) => editingRule ? updateRecur.mutate({ id: editingRule.id, input }) : createRecur.mutate(input)}
              onCancel={() => { setForm('none'); setEditingRule(null); setError(null); }} />
          </div>
        )}
        {paying && (
          <div className="mb-6">
            <PayForm planned={paying} accounts={accounts} categories={categories} currency={currency}
              busy={confirmPaid.isPending} err={error}
              onSubmit={(input) => confirmPaid.mutate({ id: paying.id, input })}
              onCancel={() => { setPaying(null); setError(null); }} />
          </div>
        )}

        <section className={card}>
          <h2 className="text-base font-semibold">« Payé ? » — {activeCount} à surveiller</h2>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">Planifier n'est pas dépenser : une échéance ne devient une vraie dépense qu'après « Oui, payé ».</p>
          {activeCount === 0 && <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">Aucune échéance en attente. 🎉</p>}
          {(['overdue', 'due', 'upcoming', 'later'] as const).map((bucket) => {
            const items = pendingGroups[bucket];
            if (items.length === 0) return null;
            return (
              <div key={bucket} className="mt-4">
                <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
                  {{ overdue: 'En retard', due: "Aujourd'hui", upcoming: 'À venir', later: 'Plus tard' }[bucket]} ({items.length})
                </h3>
                <ul className="mt-2 space-y-2">
                  {items.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{item.description ?? 'Dépense planifiée'}</div>
                        <div className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{dateHuman(item.dueDate)} · {formatMoney(item.amount, currency)} · {catName(item)}{item.recurringRuleId ? ' · mensuel' : ' · ponctuel'}</div>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <button type="button" onClick={() => { setPaying(item); setError(null); }} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700">Payé ?</button>
                        <button type="button" onClick={() => (item.recurringRuleId ? setSkipId(item) : setCancelId(item))} className="rounded-lg border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800">{item.recurringRuleId ? 'Ignorer ce mois' : 'Annuler'}</button>
                        {!item.recurringRuleId && (
                          <button type="button" onClick={() => { setEditing(item); setForm('one'); }} className="rounded-lg border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300">Modifier</button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                              </div>
              );
            })}
          {resolved.length > 0 && (
            <div className="mt-5 border-t border-neutral-200 pt-3 dark:border-neutral-800">
              <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">Historique ({resolved.length})</h3>
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{resolved.map((i) => `${i.status === 'PAID' ? 'Payée' : i.status === 'SKIPPED' ? 'Ignorée' : 'Annulée'} · ${dateHuman(i.dueDate)} · ${formatMoney(i.amount, currency)}`).join(' — ')}</p>
            </div>
          )}
        </section>
        <section className={`mt-6 ${card}`}>
          <h2 className="text-base font-semibold">Dépenses mensuelles</h2>
          {recurring.length === 0 && <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">Aucune règle. Ajoutez-en une avec « Nouvelle dépense mensuelle ».</p>}
          <ul className="mt-3 space-y-2">
            {recurring.map((rule) => (
              <li key={rule.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{rule.description ?? 'Dépense récurrente'}{!rule.isActive && <span className="ml-2 rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">désactivée</span>}</div>
                  <div className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{formatMoney(rule.amount, currency)} tous les {rule.dayOfMonth} du mois · {catName(rule)}{rule.endDate ? ` · jusqu'au ${dateHuman(rule.endDate)}` : ''} · {rule.pendingOccurrences} échéance(s)</div>
                </div>
                {rule.isActive && (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button type="button" onClick={() => { setEditingRule(rule); setForm('recur'); }} className="rounded-lg border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300">Modifier</button>
                    <button type="button" onClick={() => setDisableId(rule)} className="rounded-lg border border-neutral-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-neutral-700 dark:text-red-400 dark:hover:bg-red-950/40">Désactiver</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
        <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-500">Les échéances planifiées ne modifient ni vos soldes ni votre Total disponible. Elles ne deviennent réelles qu'après « Oui, payé » (journal des Transactions).</p>
      </div>
      {modalConfirm(cancelId, 'Annuler cette dépense ?', 'Seront annulées (CANCELED) : ' + (cancelId ? `${formatMoney(cancelId.amount, currency)} le ${dateHuman(cancelId.dueDate)}.` : ''), 'Oui, annuler', () => { if (cancelId) cancel.mutate(cancelId.id); })}
      {modalConfirm(skipId, 'Ignorer cette occurrence ?', 'Seul ce mois-ci sera ignoré (SKIPPED). Les mois suivants continueront d’exister.', 'Oui, ignorer ce mois', () => { if (skipId) skip.mutate(skipId.id); })}
      {modalConfirm(disableId, 'Désactiver cette récurrence ?', 'Aucune nouvelle échéance ne sera générée. Les paiements enregistrés restent visibles.', 'Oui, désactiver', () => { if (disableId) disable.mutate(disableId.id); })}
    </main>
  );
}

function modalConfirm(anchor: unknown, title: string, text: string, okLabel: string, onOk: () => void): React.ReactNode {
  if (!anchor) return null;
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">{text}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={onOk} className={btnDanger}>{okLabel}</button>
          <button type="button" className="rounded-lg border border-neutral-300 px-4 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:text-neutral-200">Pas encore</button>
        </div>
      </div>
    </div>
  );
}

function closeButton(label: string, onClick: () => void) {
  return (
    <button type="button" onClick={onClick} className="rounded-lg border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800">{label}</button>
  );
}

function PlannedOneForm({ categories, initial, busy, err, onSubmit, onCancel }: {
  categories: CategoryPublic[];
  initial?: PlannedExpensePublic;
  busy: boolean;
  err: string | null;
  onSubmit: (input: PlannedExpenseCreate) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(initial?.amount ?? '');
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? '');
  const [categoryId, setCategoryId] = useState(initial?.category?.id ?? '');
  const [categoryUnknown, setCategoryUnknown] = useState(initial?.categoryUnknown ?? false);
  const [description, setDescription] = useState(initial?.description ?? '');
  const [errors, setErrors] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const { payload, errors: errs } = buildPlannedExpensePayload({ amount, dueDate, categoryId, categoryUnknown, description });
    if (!payload) { setErrors(errs); setConfirm(false); return; }
    setErrors([]); setConfirm(true);
    if (confirm) onSubmit(payload);
  };

  if (confirm) {
    return (
      <section className={card}>
        <h2 className="text-base font-semibold">Confirmer la dépense future</h2>
        <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-200">{amount} prévues le {dueDate} · {categoryUnknown ? 'Je ne sais pas encore' : catName({ category: categories.find((c) => c.id === categoryId) ?? null, categoryUnknown: false })}</p>
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">Aucun solde n’est modifié avant « Oui, payé ».</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => { setConfirm(false); const built = buildPlannedExpensePayload({ amount, dueDate, categoryId, categoryUnknown, description }); if (built.payload) onSubmit(built.payload); }} className={btn}>{busy ? '…' : 'Confirmer la planification'}</button>
          <button type="button" onClick={() => setConfirm(false)} className="rounded-lg border border-neutral-300 px-4 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:text-neutral-200">Modifier</button>
        </div>
      </section>
    );
  }

  return (
    <section className={card}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{initial ? 'Modifier la dépense future' : 'Nouvelle dépense future'}</h2>
        {closeButton('Annuler', onCancel)}
      </div>
      <form onSubmit={submit} className="mt-4 space-y-4">
        <CField label="Montant prévu"><input type="text" inputMode="decimal" aria-label="Montant prévu" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="80000" className={inputCls} /></CField>
        <CField label="Date prévue"><input type="date" aria-label="Date prévue" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputCls} /></CField>
        <fieldset>
          <legend className="text-sm font-medium">Catégorie</legend>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <select aria-label="Catégorie" disabled={categoryUnknown} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950">
              <option value="">Choisir…</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={categoryUnknown} onChange={(e) => { setCategoryUnknown(e.target.checked); if (e.target.checked) setCategoryId(''); }} /> Je ne sais pas encore</label>
          </div>
        </fieldset>
        <CField label="Description (facultative)"><input type="text" maxLength={120} aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} /></CField>
        {errorsList(errors)}
        {err && errors.length === 0 && <p className="text-sm text-red-600 dark:text-red-400">{err}</p>}
        <button type="submit" className={btn}>Vérifier et confirmer…</button>
      </form>
    </section>
  );
}

function RecurForm({ categories, initial, busy, err, onSubmit, onCancel }: {
  categories: CategoryPublic[];
  initial?: RecurringExpensePublic;
  busy: boolean;
  err: string | null;
  onSubmit: (input: RecurringExpenseCreate) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(initial?.amount ?? '');
  const [dayOfMonth, setDayOfMonth] = useState(initial ? String(initial.dayOfMonth) : '');
  const [startDate, setStartDate] = useState(initial?.startDate ?? '');
  const [endDate, setEndDate] = useState(initial?.endDate ?? '');
  const [categoryId, setCategoryId] = useState(initial?.category?.id ?? '');
  const [categoryUnknown, setCategoryUnknown] = useState(initial?.categoryUnknown ?? false);
  const [description, setDescription] = useState(initial?.description ?? '');
  const [errors, setErrors] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    const { payload, errors: errs } = buildRecurringExpensePayload({ amount, dayOfMonth, startDate, endDate, categoryId, categoryUnknown, description });
    if (!payload) { setErrors(errs); return; }
    setErrors([]);
    if (!confirm) setConfirm(true);
    else onSubmit(payload);
  }

  if (confirm) {
    const category = categoryUnknown ? 'Je ne sais pas encore' : (categories.find((c) => c.id === categoryId)?.name ?? '—');
    return (
      <section className={card}>
        <h2 className="text-base font-semibold">Confirmer la récurrence</h2>
        <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-200">{amount} tous les {dayOfMonth} du mois · du {startDate}{endDate ? ` au ${endDate}` : ''} · {category}</p>
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">Des occurrences PENDING seront créées (mois courant + 3). Aucun solde modifié.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => onSubmit(buildRecurringExpensePayload({ amount, dayOfMonth, startDate, endDate, categoryId, categoryUnknown, description }).payload as RecurringExpenseCreate)} className={btn}>{busy ? '…' : 'Confirmer la récurrence'}</button>
          <button type="button" onClick={() => setConfirm(false)} className="rounded-lg border border-neutral-300 px-4 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:text-neutral-200">Modifier</button>
        </div>
      </section>
    );
  }

  return (
    <section className={card}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{initial ? 'Modifier la dépense mensuelle' : 'Nouvelle dépense mensuelle'}</h2>
        {closeButton('Annuler', onCancel)}
      </div>
      <form onSubmit={submit} className="mt-4 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <CField label="Montant mensuel"><input type="text" inputMode="decimal" aria-label="Montant mensuel" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} className={inputCls} /></CField>
          <CField label="Jour du mois (1 à 31)"><input type="number" min={1} max={31} step={1} aria-label="Jour du mois" value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} className={inputCls} /></CField>
        </div>
        <p className="rounded-lg bg-neutral-100 px-3 py-2 text-xs text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300">Tous les {dayOfMonth || '5'} du mois. Si ce jour n’existe pas (29/30/31), l’échéance est placée le dernier jour du mois.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <CField label="Date de début"><input type="date" aria-label="Date de début" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputCls} /></CField>
          <CField label="Date de fin (facultative)"><input type="date" aria-label="Date de fin" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputCls} /></CField>
        </div>
        <fieldset>
          <legend className="text-sm font-medium">Catégorie</legend>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <select aria-label="Catégorie" disabled={categoryUnknown} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950">
              <option value="">Choisir…</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={categoryUnknown} onChange={(e) => { setCategoryUnknown(e.target.checked); if (e.target.checked) setCategoryId(''); }} /> Je ne sais pas encore</label>
          </div>
        </fieldset>
        <CField label="Description (facultative)"><input type="text" maxLength={120} aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} /></CField>
        {errorsList(errors)}
        {err && errors.length === 0 && <p className="text-sm text-red-600 dark:text-red-400">{err}</p>}
        <button type="submit" className={btn}>Vérifier et confirmer…</button>
      </form>
    </section>
  );
}

function PayForm({ planned, accounts, categories, currency, busy, err, onSubmit, onCancel }: {
  planned: PlannedExpensePublic;
  accounts: AccountPublic[];
  categories: CategoryPublic[];
  currency: Currency;
  busy: boolean;
  err: string | null;
  onSubmit: (input: PlannedExpenseConfirmPaid) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(planned.amount);
  const [date, setDate] = useState(planned.dueDate);
  const [dateUnknown, setDateUnknown] = useState(false);
  const [accountUnknown, setAccountUnknown] = useState(false);
  const [allocations, setAllocations] = useState<Record<string, string>>(Object.fromEntries(accounts.map((a) => [a.id, ''])));
  const [categoryId, setCategoryId] = useState(planned.category?.id ?? '');
  const [categoryUnknown, setCategoryUnknown] = useState(planned.categoryUnknown);
  const [description, setDescription] = useState(planned.description ?? '');
  const [errors, setErrors] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    const { payload, errors: errs } = buildConfirmPaidPayload({ amount, date, dateUnknown, accountUnknown, allocations, categoryId, categoryUnknown, description }, accounts);
    if (!payload) { setErrors(errs); setConfirm(false); return; }
    setErrors([]);
    if (!confirm) setConfirm(true);
    else onSubmit(payload);
  }

  if (confirm) {
    return (
      <section className={card}>
        <h2 className="text-base font-semibold">Confirmer le paiement réel</h2>
        <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-200">
          {amount} {currency} réellement payé{dateUnknown ? ' (date ?)' : ` le ${date}`} · {accountUnknown ? 'Compte ?' : accounts.filter((a) => (allocations[a.id] ?? '').trim()).map((a) => `${a.type} ${allocations[a.id]}`).join(' + ')} · {categoryUnknown ? 'Catégorie ?' : categories.find((c) => c.id === categoryId)?.name ?? '—'}
        </p>
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">Prévu {planned.amount} le {planned.dueDate}. La Transaction réelle est créée maintenant (solde mis à jour).</p>
        {err && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{err}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => { const b = buildConfirmPaidPayload({ amount, date, dateUnknown, accountUnknown, allocations, categoryId, categoryUnknown, description }, accounts); if (b.payload) onSubmit(b.payload); }} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">{busy ? '…' : 'Oui, j’ai réellement payé'}</button>
          <button type="button" onClick={() => setConfirm(false)} className="rounded-lg border border-neutral-300 px-4 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:text-neutral-200">Modifier</button>
        </div>
      </section>
    );
  }

  return (
    <section className={card}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{planned.description ?? 'Dépense planifiée'} — Payé ?</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">Prévu {planned.amount} le {planned.dueDate}. Corrigez si le réel diffère.</p>
        </div>
        {closeButton('Fermer', onCancel)}
      </div>
      <form onSubmit={submit} className="mt-4 space-y-4">
        <CField label="Montant réellement payé"><input type="text" inputMode="decimal" aria-label="Montant réel" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} className={inputCls} /></CField>
        <fieldset>
          <legend className="text-sm font-medium">Date réelle</legend>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <input type="date" aria-label="Date réelle" disabled={dateUnknown} value={date} onChange={(e) => setDate(e.target.value)} className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950" />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={dateUnknown} onChange={(e) => setDateUnknown(e.target.checked)} /> Je ne sais plus</label>
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-sm font-medium">Compte(s) réel(s)</legend>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={accountUnknown} onChange={(e) => setAccountUnknown(e.target.checked)} /> Je ne sais plus</label>
          {!accountUnknown && (
            <div className="mt-2 space-y-2">
              {accounts.map((account) => (
                <label key={account.id} className="flex items-center justify-between gap-3">
                  <span className="text-sm">{account.type}</span>
                  <input type="text" inputMode="decimal" aria-label={`Part ${account.type}`} value={allocations[account.id] ?? ''} onChange={(e) => setAllocations((prev) => ({ ...prev, [account.id]: e.target.value.replace(/[^\d.]/g, '') }))} placeholder="Montant…" className="w-32 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-right text-sm tabular-nums dark:border-neutral-700 dark:bg-neutral-950" />
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <fieldset>
          <legend className="text-sm font-medium">Catégorie</legend>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <select aria-label="Catégorie" disabled={categoryUnknown} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950">
              <option value="">Choisir…</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={categoryUnknown} onChange={(e) => { setCategoryUnknown(e.target.checked); if (e.target.checked) setCategoryId(''); }} /> Je ne sais plus</label>
          </div>
        </fieldset>
        <CField label="Description"><input type="text" maxLength={120} aria-label="Description réelle" value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} /></CField>
        {errorsList(errors)}
        {err && errors.length === 0 && <p className="text-sm text-red-600 dark:text-red-400">{err}</p>}
        <button type="submit" className={btn}>Vérifier…</button>
      </form>
    </section>
  );
}
