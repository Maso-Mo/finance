import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountPublic, AccountingKind, AccountingRow, AccountType } from '@finance/shared-types';
import { toMoney } from '@finance/finance-core';
import { apiExportAccounting, apiGetAccountingJournal, apiGetAccountingOverview, apiSetTargetBalance } from '../auth/api';
import { Button, Panel } from '../components/ui';
import { Dialog } from '../components/overlay';
import { ACCOUNT_TYPE_LABELS, formatMoney, toISODate } from '../lib/format';

const filters: [AccountingKind, string][] = [['ALL', 'Tous'], ['INCOME', 'Revenus'], ['EXPENSE', 'Dépenses'], ['TRANSFER', 'Transferts'], ['ADJUSTMENT', 'Corrections'], ['DEBT', 'Dettes']];
const accountsLabel = (text: string) => text.split(', ').map(key => ACCOUNT_TYPE_LABELS[key as AccountType] ?? key).join(', ');
export default function AccountingPage() {
  const { user, status } = useAuth();
  const [month, setMonth] = useState(toISODate(new Date()).slice(0, 7));
  const [kind, setKind] = useState<AccountingKind>('ALL');
  const [page, setPage] = useState(1);
  const [account, setAccount] = useState<AccountPublic | null>(null);
  const [target, setTarget] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [exportError, setExportError] = useState('');
  const client = useQueryClient();
  const overview = useQuery({ queryKey: ['accounting', user?.id, month], enabled: status === 'authenticated', queryFn: () => apiGetAccountingOverview(month) });
  const journal = useQuery({ queryKey: ['accounting-journal', user?.id, month, kind, page], enabled: status === 'authenticated', queryFn: () => apiGetAccountingJournal(month, kind, page) });
  const correction = useMutation({ mutationFn: () => apiSetTargetBalance(account!.id, target), onSuccess: async () => {
    setAccount(null); setConfirm(false); await client.invalidateQueries();
  } });
  const data = overview.data;
  const currency = data?.currency ?? 'MGA';
  const validTarget = /^\d+(\.\d{1,2})?$/.test(target);
  const previousMonth = new Date(); previousMonth.setDate(1); previousMonth.setMonth(previousMonth.getMonth() - 1);
  const changeMonth = (value: string) => { if (value) { setMonth(value); setPage(1); } };
  const exportPeriod = async () => {
    try {
      setExportError(''); const blob = await apiExportAccounting(month); const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `finance-${month}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setExportError('Export indisponible. Une connexion à Finance est nécessaire.'); }
  };
  const entries = (row: AccountingRow) => <><span className="text-positive">+{formatMoney(row.incoming, currency)}</span><span className="text-ink2">−{formatMoney(row.outgoing, currency)}</span></>;
  if (status === 'guest') return <Navigate to="/login" replace />;
  if (status === 'loading') return <p>Restauration de session…</p>;
  return <div className="flex flex-col gap-5">
    <header><h1 className="text-2xl font-bold">Comptabilité</h1><p className="mt-1 text-sm text-ink2">Contrôle tes mouvements et vérifie que tes comptes correspondent à la réalité.</p></header>
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-sm">Période <input aria-label="Période" className="field w-auto" type="month" value={month} onChange={e => changeMonth(e.target.value)} /></label>
      <Button variant="secondary" size="sm" onClick={() => changeMonth(toISODate(new Date()).slice(0, 7))}>Ce mois</Button>
      <Button variant="secondary" size="sm" onClick={() => changeMonth(toISODate(previousMonth).slice(0, 7))}>Mois précédent</Button>
      <Button variant="secondary" size="sm" onClick={() => void exportPeriod()}>Exporter la période</Button>
    </div>
    {exportError && <p role="alert">{exportError}</p>}
    {overview.isError && <p role="alert">{overview.error.message}</p>}
    {overview.isLoading && <p>Chargement de la période…</p>}
    {data && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{[
      ['Revenus réels', data.income], ['Dépenses réelles', data.expense], ['Résultat de la période', data.result], ['Mouvements internes', data.internal],
    ].map(([label, value]) => <Panel key={label} className="p-4"><p className="text-sm text-ink2">{label}</p><p className="mt-2 break-words text-xl font-bold num">{formatMoney(value!, currency)}</p></Panel>)}</div>}
    <section aria-label="Journal comptable personnel">
      <h2 className="text-lg font-semibold">Journal de la période</h2>
      <p className="text-xs text-ink2">Transferts, corrections et remboursements sont visibles ici mais exclus du résultat. Les frais de transfert restent séparés.</p>
      <div className="my-3 flex gap-2 overflow-x-auto pb-1" aria-label="Filtres">{filters.map(([value, label]) => <Button key={value} size="sm" variant={kind === value ? 'primary' : 'secondary'} aria-pressed={kind === value} onClick={() => { setKind(value); setPage(1); }}>{label}</Button>)}</div>
      {journal.isError && <p role="alert">{journal.error.message}</p>}
      {journal.isLoading && <p>Chargement du journal…</p>}
      {journal.data?.rows.length === 0 && <Panel className="p-5">Aucun mouvement pour cette période.</Panel>}
      {!!journal.data?.rows.length && <>
        <div className="hidden lg:block"><table className="w-full text-left text-sm"><thead><tr>{['Date', 'Type', 'Description', 'Compte(s)', 'Entrée', 'Sortie'].map(label => <th className="p-2" key={label}>{label}</th>)}</tr></thead><tbody>{journal.data.rows.map(row => <tr className="border-t border-edge" key={row.id}><td className="p-2">{row.date.slice(0, 10)}</td><td className="p-2">{row.type}</td><td className="max-w-64 break-words p-2">{row.description || '—'}{row.fees !== '0' && <small className="block">Frais : {formatMoney(row.fees, currency)}</small>}</td><td className="p-2">{accountsLabel(row.source)}{row.source && row.destination ? ' → ' : ''}{accountsLabel(row.destination)}</td><td className="p-2 text-positive num">{formatMoney(row.incoming, currency)}</td><td className="p-2 num">{formatMoney(row.outgoing, currency)}</td></tr>)}</tbody></table></div>
        <ul className="space-y-2 lg:hidden">{journal.data.rows.map(row => <li className="card break-words p-4 text-sm" key={row.id}><div className="flex flex-wrap justify-between gap-2"><strong>{row.type}</strong><span className="text-ink2">{row.date.slice(0, 10)}</span></div><p className="my-1">{row.description || '—'}</p><p className="text-xs text-ink2">{accountsLabel(row.source)}{row.source && row.destination ? ' → ' : ''}{accountsLabel(row.destination)}</p><div className="mt-2 flex flex-wrap justify-between gap-2 num">{entries(row)}</div>{row.fees !== '0' && <p className="mt-1 text-xs">Frais : {formatMoney(row.fees, currency)}</p>}</li>)}</ul>
      </>}
      {journal.data && <div className="mt-3 flex items-center justify-between gap-2"><Button size="sm" variant="secondary" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Précédent</Button><span className="text-xs">Page {page} / {Math.max(1, Math.ceil(journal.data.total / journal.data.limit))}</span><Button size="sm" variant="secondary" disabled={page * journal.data.limit >= journal.data.total} onClick={() => setPage(p => p + 1)}>Suivant</Button></div>}
    </section>
    <section><h2 className="text-lg font-semibold">Vérification des comptes</h2><p className="mb-3 text-xs text-ink2">Soldes calculés actuels, indépendamment de la période sélectionnée. Épargne incluse.</p><ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{data?.accounts.map(a => <li className="card p-4" key={a.id}><h3 className="font-semibold">{ACCOUNT_TYPE_LABELS[a.type]}</h3><p className="my-2 num">{formatMoney(a.balance, currency)}</p><Button size="sm" variant="secondary" onClick={() => { setAccount(a); setTarget(''); setConfirm(false); correction.reset(); }}>Vérifier le solde</Button></li>)}</ul></section>
    <Dialog open={!!account} title={`Vérifier le solde — ${account ? ACCOUNT_TYPE_LABELS[account.type] : ''}`} onClose={() => { if (!correction.isPending) setAccount(null); }} footer={<><Button variant="secondary" onClick={() => confirm ? setConfirm(false) : setAccount(null)}>Annuler</Button><Button disabled={!validTarget || correction.isPending} onClick={() => confirm ? correction.mutate() : setConfirm(true)}>{confirm ? 'Corriger le solde' : 'Vérifier l’écart'}</Button></>}>
      {confirm && account ? <div className="space-y-3"><p>Solde Finance : {formatMoney(account.balance, currency)}</p><p>Solde réel saisi : {formatMoney(target, currency)}</p><p className="font-semibold">Écart : {formatMoney(toMoney(target).minus(account.balance).toFixed(2), currency)}</p><p className="text-sm text-ink2">Confirme cette correction. Les mouvements existants sont conservés.</p></div> : <label>Solde réel actuellement<input className="field mt-2" inputMode="decimal" value={target} onChange={e => setTarget(e.target.value)} autoFocus /></label>}
      {correction.isError && <p role="alert" className="mt-3 text-danger">{correction.error.message}</p>}
    </Dialog>
  </div>;
}
