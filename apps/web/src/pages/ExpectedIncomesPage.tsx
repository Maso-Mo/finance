import { useMemo, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AccountPublic, Currency, ExpectedIncomeCertainty,
  ExpectedIncomeConfirmReceived, ExpectedIncomeCreate,
  ExpectedIncomePublic, ExpectedIncomeUpdate,
} from '@finance/shared-types';
import { useAuth } from '../auth/AuthContext';
import {
  apiCancelExpectedIncome, apiConfirmExpectedIncomeReceived,
  apiCreateExpectedIncome, apiGetAccounts, apiGetExpectedIncomes,
  apiUpdateExpectedIncome,
} from '../auth/api';
import { ThemeToggle } from '../components/ThemeToggle';
import { NotificationsBell } from '../components/NotificationsBell';
import { formatMoney, toISODate } from '../lib/format';
import { buildExpectedIncomePayload, buildIncomeReceivedPayload, timingOf } from '../lib/income';

const inputCls = 'mt-1 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const btn = 'rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50';
const btnOut = 'rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800';
const btnDanger = 'rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50';
const card = 'rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900';

export default function ExpectedIncomesPage() {
  const { status, user, signOut } = useAuth();
  const queryClient = useQueryClient();
  const [today] = useState(() => toISODate(new Date()));
  const [form, setForm] = useState(false);
  const [editing, setEditing] = useState<ExpectedIncomePublic | null>(null);
  const [receiving, setReceiving] = useState<ExpectedIncomePublic | null>(null);
  const [cancelId, setCancelId] = useState<ExpectedIncomePublic | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accountsQuery = useQuery({ queryKey: ['dashboard'], queryFn: apiGetAccounts, enabled: status === 'authenticated' });
  const incomesQuery = useQuery({ queryKey: ['expected-incomes', today], queryFn: () => apiGetExpectedIncomes(today), enabled: status === 'authenticated' });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['expected-incomes'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const create = useMutation({ mutationFn: apiCreateExpectedIncome, onSuccess: () => { setForm(false); setEditing(null); setError(null); refresh(); }, onError: (e: Error) => setError(e.message) });
  const update = useMutation({ mutationFn: (v: { id: string; input: ExpectedIncomeUpdate }) => apiUpdateExpectedIncome(v.id, v.input), onSuccess: () => { setForm(false); setEditing(null); setError(null); refresh(); }, onError: (e: Error) => setError(e.message) });
  const cancel = useMutation({ mutationFn: apiCancelExpectedIncome, onSuccess: () => { setCancelId(null); setError(null); refresh(); }, onError: (e: Error) => setError(e.message) });
  const confirmReceived = useMutation({ mutationFn: (v: { id: string; input: ExpectedIncomeConfirmReceived }) => apiConfirmExpectedIncomeReceived(v.id, v.input), onSuccess: () => { setReceiving(null); setError(null); refresh(); }, onError: (e: Error) => setError(e.message) });

  const accounts: AccountPublic[] = accountsQuery.data?.accounts ?? [];
  const currency: Currency = accountsQuery.data?.currency ?? 'MGA';
  const incomes = incomesQuery.data?.expectedIncomes ?? [];
  const pending = useMemo(() => incomes.filter((i) => i.status === 'PENDING'), [incomes]);
  const resolved = useMemo(() => incomes.filter((i) => i.status !== 'PENDING'), [incomes]);

  if (status === 'loading') {
    return <div className="flex min-h-screen items-center justify-center bg-neutral-100 text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">Restauration de session…</div>;
  }
  if (status === 'guest') {
    return <Navigate to="/login" replace />;
  }
  return (
    <main className="min-h-screen bg-neutral-100 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/" className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800">Accueil</Link>
          <h1 className="text-lg font-semibold">Revenus à venir</h1>
          <span className="hidden text-xs text-neutral-500 sm:inline dark:text-neutral-400">{user?.email}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <NotificationsBell />
          <ThemeToggle />
          <button type="button" onClick={() => void signOut()} className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800">Déconnexion</button>
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-4 py-8">
        {error && <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
        {!form && !receiving && (
          <div className="mb-4">
            <button type="button" onClick={() => { setForm(true); setEditing(null); setError(null); }} className={btn}>Ajouter un revenu attendu</button>
          </div>
        )}
        {form && (
          <div className="mb-6">
            <IncomeForm
              currency={currency}
              initial={editing ?? undefined}
              busy={create.isPending || update.isPending}
              err={error}
              onSubmit={(input) => (editing ? update.mutate({ id: editing.id, input }) : create.mutate(input))}
              onCancel={() => { setForm(false); setEditing(null); setError(null); }}
            />
          </div>
        )}
        {receiving && (
          <div className="mb-6">
            <ReceiveForm
              item={receiving}
              accounts={accounts}
              currency={currency}
              busy={confirmReceived.isPending}
              err={error}
              onSubmit={(input) => confirmReceived.mutate({ id: receiving.id, input })}
              onCancel={() => { setReceiving(null); setError(null); }}
            />
          </div>
        )}

        <section className={card}>
          <h2 className="text-base font-semibold">« Reçu ? » — {pending.length} à surveiller</h2>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">Un revenu futur n’est pas de l’argent disponible : aucun compte ni Total disponible ne bouge avant « Oui, je l’ai reçu ». Les revenus Incertains ne sont jamais traités comme garantis.</p>
          {pending.length === 0 && <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">Aucun revenu en attente.</p>}
          <ul className="mt-3 space-y-2">
            {pending.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {certaintyBadge(item.certainty)}
                    {statusBadge(item)}
                    <span>{item.description ?? 'Revenu attendu'}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                    {formatMoney(item.amount, currency)} · {timingOf(item)}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button type="button" aria-label="Reçu ?" onClick={() => { setReceiving(item); setError(null); }} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700">Reçu ?</button>
                  <button type="button" onClick={() => { setEditing(item); setForm(true); setError(null); }} className="rounded-lg border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800">Modifier</button>
                  <button type="button" onClick={() => setCancelId(item)} className="rounded-lg border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800">Annuler</button>
                </div>
              </li>
            ))}
          </ul>
          {resolved.length > 0 && (
            <div className="mt-5 border-t border-neutral-200 pt-3 dark:border-neutral-800">
              <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">Historique ({resolved.length})</h3>
              <ul className="mt-2 space-y-1">
                {resolved.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                    {certaintyBadge(i.certainty)}
                    <span>{i.description ?? 'Revenu'} · {formatMoney(i.amount, currency)} · {timingOf(i)}</span>
                    <span className="italic">{i.status === 'RECEIVED' ? (i.receivedTransaction ? `reçu : ${formatMoney(i.receivedTransaction.amount, currency)}` : 'reçu') : 'annulé'}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
        <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-500">« Confirmé » = réellement attendu ; « Incertain » = espéré, non garanti. Un revenu futur ne devient une Transaction INCOME réelle qu’après « Oui, je l’ai reçu » (journal des Transactions).</p>
      </div>
      {cancelId && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            <h2 className="text-base font-semibold">Annuler ce revenu attendu ?</h2>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">{formatMoney(cancelId.amount, currency)} {timingOf(cancelId)}. Il restera visible comme « Annulé » dans l’historique.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={() => cancel.mutate(cancelId.id)} className={btnDanger}>Oui, annuler</button>
              <button type="button" onClick={() => setCancelId(null)} className="rounded-lg border border-neutral-300 px-4 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:text-neutral-200">Pas encore</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
function errorsList(errors: string[]) {
  if (errors.length === 0) return null;
  return (
    <ul className="space-y-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
      {errors.map((e) => (
        <li key={e}>{e}</li>
      ))}
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

function certaintyBadge(certainty: ExpectedIncomeCertainty) {
  return certainty === 'CONFIRMED' ? (
    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">Confirmé</span>
  ) : (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">Incertain</span>
  );
}

function statusBadge(item: ExpectedIncomePublic) {
  if (item.status === 'PENDING') {
    const label = item.reminderBucket === 'dueToday' ? "Aujourd'hui"
      : item.reminderBucket === 'inWindow' ? 'Dans la période attendue'
        : item.reminderBucket === 'overdue' ? 'En retard'
          : item.reminderBucket === 'upcoming' ? 'À venir' : 'En attente';
    return (
      <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">{label}</span>
    );
  }
  const label = item.status === 'RECEIVED' ? 'Reçu' : 'Annulé';
  return (
    <span className={item.status === 'RECEIVED'
      ? 'rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700 dark:bg-sky-900/40 dark:text-sky-300'
      : 'rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'}
    >
      {label}
    </span>
  );
}

function IncomeForm({
  currency, initial, busy, err, onSubmit, onCancel,
}: {
  currency: Currency;
  initial?: ExpectedIncomePublic;
  busy: boolean;
  err: string | null;
  onSubmit: (input: ExpectedIncomeCreate | ExpectedIncomeUpdate) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(initial?.amount ?? '');
  const [certainty, setCertainty] = useState<ExpectedIncomeCertainty>(initial?.certainty ?? 'CONFIRMED');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [dateMode, setDateMode] = useState<'exact' | 'range'>(initial?.expectedDate ? 'exact' : 'range');
  const [expectedDate, setExpectedDate] = useState(initial?.expectedDate ?? '');
  const [windowStart, setWindowStart] = useState(initial?.windowStart ?? '');
  const [windowEnd, setWindowEnd] = useState(initial?.windowEnd ?? '');
  const [errors, setErrors] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    const values = { amount, certainty, description, dateMode, expectedDate, windowStart, windowEnd };
    const { payload, errors: errs } = buildExpectedIncomePayload(values);
    if (!payload) { setErrors(errs); setConfirm(false); return; }
    setErrors([]);
    if (!confirm) setConfirm(true);
    else onSubmit(payload);
  }

  if (confirm) {
    const values = { amount, certainty, description, dateMode, expectedDate, windowStart, windowEnd };
    return (
      <section className={card}>
        <h2 className="text-base font-semibold">Confirmer le revenu attendu</h2>
        <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-200">
          {formatMoney(amount, currency)} · {certainty === 'CONFIRMED' ? 'Confirmé' : 'Incertain'} · {dateMode === 'exact' ? `le ${expectedDate}` : `entre le ${windowStart} et le ${windowEnd}`}
        </p>
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">Aucun solde n’est modifié tant que vous n’avez pas confirmé « Oui, je l’ai reçu ».</p>
        {err && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{err}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => { setConfirm(false); const b = buildExpectedIncomePayload(values); if (b.payload) onSubmit(b.payload); }} className={btn}>{busy ? '…' : 'Confirmer la planification'}</button>
          <button type="button" onClick={() => setConfirm(false)} className={btnOut}>Modifier</button>
        </div>
      </section>
    );
  }
  return (
    <section className={card}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{initial ? 'Modifier le revenu attendu' : 'Nouveau revenu attendu'}</h2>
        <button type="button" onClick={onCancel} className="rounded-lg border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800">Annuler</button>
      </div>
      <form onSubmit={submit} className="mt-4 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <CField label="Montant attendu"><input type="text" inputMode="decimal" aria-label="Montant attendu" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} className={inputCls} /></CField>
          <CField label="Description (facultative)"><input type="text" maxLength={120} aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} /></CField>
        </div>
        <fieldset>
          <legend className="text-sm font-medium">Certitude du revenu futur</legend>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm"><input type="radio" name="certainty" checked={certainty === 'CONFIRMED'} onChange={() => setCertainty('CONFIRMED')} /> Confirmé (réellement attendu)</label>
            <label className="flex items-center gap-2 text-sm"><input type="radio" name="certainty" checked={certainty === 'UNCERTAIN'} onChange={() => setCertainty('UNCERTAIN')} /> Incertain (espéré, non garanti)</label>
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-sm font-medium">Quand ?</legend>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm"><input type="radio" name="dateMode" checked={dateMode === 'exact'} onChange={() => setDateMode('exact')} /> Date exacte</label>
            <label className="flex items-center gap-2 text-sm"><input type="radio" name="dateMode" checked={dateMode === 'range'} onChange={() => setDateMode('range')} /> Période</label>
          </div>
          {dateMode === 'exact' ? (
            <div className="mt-2">
              <input type="date" aria-label="Date exacte" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} className={inputCls} />
            </div>
          ) : (
            <div className="mt-2 grid gap-4 sm:grid-cols-2">
              <CField label="Début de période"><input type="date" aria-label="Début de période" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} className={inputCls} /></CField>
              <CField label="Fin de période"><input type="date" aria-label="Fin de période" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} className={inputCls} /></CField>
            </div>
          )}
        </fieldset>
        {errorsList(errors)}
        {err && errors.length === 0 && <p className="text-sm text-red-600 dark:text-red-400">{err}</p>}
        <button type="submit" className={btn}>Vérifier et confirmer…</button>
      </form>
    </section>
  );
}
function ReceiveForm({
  item, accounts, currency, busy, err, onSubmit, onCancel,
}: {
  item: ExpectedIncomePublic;
  accounts: AccountPublic[];
  currency: Currency;
  busy: boolean;
  err: string | null;
  onSubmit: (input: ExpectedIncomeConfirmReceived) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(item.amount);
  const [date, setDate] = useState(item.expectedDate ?? '');
  const [dateUnknown, setDateUnknown] = useState(false);
  const [accountUnknown, setAccountUnknown] = useState(false);
  const [allocations, setAllocations] = useState<Record<string, string>>(
    Object.fromEntries(accounts.map((a) => [a.id, ''])),
  );
  const [description, setDescription] = useState(item.description ?? '');
  const [errors, setErrors] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    const { payload, errors: errs } = buildIncomeReceivedPayload(
      { amount, date, dateUnknown, accountUnknown, allocations, description },
      accounts,
    );
    if (!payload) { setErrors(errs); setConfirm(false); return; }
    setErrors([]);
    if (!confirm) setConfirm(true);
    else onSubmit(payload);
  }

  if (confirm) {
    const parts = accounts.filter((a) => (allocations[a.id] ?? '').trim());
    const summary = accountUnknown
      ? 'Compte ?'
      : parts.map((a) => `${a.type} ${allocations[a.id]}`).join(' + ');
    return (
      <section className={card}>
        <h2 className="text-base font-semibold">Confirmer la réception réelle</h2>
        <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-200">
          {formatMoney(amount, currency)} réellement reçu{dateUnknown ? ' (date ?)' : ` le ${date}`} · {summary}
        </p>
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          Attendu : {formatMoney(item.amount, currency)} {timingOf(item)}. Une vraie Transaction INCOME est créée maintenant (le solde augmente).
        </p>
        {err && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{err}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => { const b = buildIncomeReceivedPayload({ amount, date, dateUnknown, accountUnknown, allocations, description }, accounts); if (b.payload) onSubmit(b.payload); }} className={btn}>{busy ? '…' : 'Oui, je l’ai reçu'}</button>
          <button type="button" onClick={() => setConfirm(false)} className={btnOut}>Modifier</button>
          <button type="button" onClick={onCancel} className={btnOut}>Pas encore</button>
        </div>
      </section>
    );
  }

  return (
    <section className={card}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{item.description ?? 'Revenu attendu'} — Reçu ?</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">Attendu {formatMoney(item.amount, currency)} {timingOf(item)}. Corrigez si le réel diffère.</p>
        </div>
        <button type="button" onClick={onCancel} className={btnOut}>Pas encore</button>
      </div>
      <form onSubmit={submit} className="mt-4 space-y-4">
        <CField label="Montant réellement reçu"><input type="text" inputMode="decimal" aria-label="Montant réel" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} className={inputCls} /></CField>
        <fieldset>
          <legend className="text-sm font-medium">Date réelle de réception</legend>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <input type="date" aria-label="Date réelle" disabled={dateUnknown} value={date} onChange={(e) => setDate(e.target.value)} className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950" />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={dateUnknown} onChange={(e) => setDateUnknown(e.target.checked)} /> Je ne sais plus</label>
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-sm font-medium">Compte(s) de destination</legend>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={accountUnknown} onChange={(e) => setAccountUnknown(e.target.checked)} /> Compte inconnu (« Je ne sais plus »)</label>
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
        <CField label="Description (facultative)"><input type="text" maxLength={120} aria-label="Description réelle" value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} /></CField>
        {errorsList(errors)}
        {err && errors.length === 0 && <p className="text-sm text-red-600 dark:text-red-400">{err}</p>}
        <button type="submit" className={btn}>Vérifier…</button>
      </form>
    </section>
  );
}
