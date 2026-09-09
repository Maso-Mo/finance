import { useSnapshotQuery } from '../lib/useSnapshotQuery';
import { useMemo, useState } from 'react';
import type { AnalyticsOverviewResponse, Currency, MonthlyCashflowPoint } from '@finance/shared-types';
import { apiGetAnalyticsOverview } from '../auth/api';
import { formatMoney } from '../lib/format';
import { Button, Panel } from './ui';

/**
 * Analytique du tableau de bord — STRICTEMENT lecture seule.
 * Données : GET /analytics/overview (calcul dérivé du journal des
 * Transactions actives, sans effet de bord). Deux visualisations :
 *  1. Flux mensuels revenus/dépenses (6 mois) — barres groupées : teal =
 *     revenus, corail = dépenses. La forme et le texte restent le repère
 *     principal, jamais la couleur seule.
 *  2. Dépenses du mois courant par catégorie (anneau + liste avec %).
 */

const MONTH_ABBREVIATIONS = [
  'janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
  'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.',
] as const;

/** « 2026-07 » → « juil. 2026 ». */
export function monthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-');
  const index = month ? Number(month) - 1 : -1;
  const label = index >= 0 && index < 12 ? (MONTH_ABBREVIATIONS[index] ?? month) : (month ?? monthKey);
  return year && label ? `${label} ${year}` : monthKey;
}

const SEGMENT_COLORS = [
  'var(--brand)',
  'var(--positive)',
  'var(--petrol)',
  'var(--violet)',
  'var(--coral)',
  'var(--lemon)',
  'var(--positive)',
  'var(--ink-3)',
  'var(--danger)',
] as const;

function toNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
/* ============== Graphique « revenus vs dépenses » (6 mois) ============== */

function CashflowChart({ points, currency }: { points: MonthlyCashflowPoint[]; currency: Currency }) {
  const [selectedIndex, setSelectedIndex] = useState(() => Math.max(0, points.length - 1));
  const point = points[selectedIndex];

  const maxValue = useMemo(
    () => Math.max(1, ...points.flatMap((p) => [toNumber(p.income), toNumber(p.expense)])),
    [points],
  );

  if (points.length === 0 || !points.some((p) => toNumber(p.income) > 0 || toNumber(p.expense) > 0)) {
    return (
      <p className="text-sm text-ink3">
        Aucune activité sur les 6 derniers mois — vos revenus et dépenses
        apparaîtront ici dès vos premières opérations.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-4 text-[12px] font-medium text-ink2">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[4px]" style={{ background: 'var(--positive)' }} />
          Revenus
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[4px]" style={{ background: 'var(--danger)' }} />
          Dépenses
        </span>
      </div>

      <ul className="flex h-[168px] items-end justify-between gap-2" aria-label="Flux mensuels">
        {points.map((p, index) => {
          const income = toNumber(p.income);
          const expense = toNumber(p.expense);
          const incomeHeight = income > 0 ? Math.max(4, (income / maxValue) * 100) : 0;
          const expenseHeight = expense > 0 ? Math.max(4, (expense / maxValue) * 100) : 0;
          const active = index === selectedIndex;
          return (
            <li key={p.month} className="flex min-w-0 flex-1 flex-col items-center">
              <button
                type="button"
                onClick={() => setSelectedIndex(index)}
                aria-pressed={active}
                aria-label={`${monthLabel(p.month)} — revenus ${formatMoney(p.income, currency)}, dépenses ${formatMoney(p.expense, currency)}`}
                className="flex h-full w-full flex-col items-center justify-end gap-1.5 rounded-xl px-1 pt-2 transition-colors hover:bg-surface-2"
              >
                <div className="flex h-[120px] w-full items-end justify-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="w-[min(22px,45%)] rounded-t-[5px]"
                    style={{ height: `${incomeHeight}%`, background: active ? 'var(--positive)' : 'var(--positive)', opacity: active ? 1 : 0.82 }}
                  />
                  <span
                    aria-hidden="true"
                    className="w-[min(22px,45%)] rounded-t-[5px]"
                    style={{ height: `${expenseHeight}%`, background: 'var(--danger)', opacity: active ? 1 : 0.8 }}
                  />
                </div>
                <span aria-hidden="true" className={`text-[11px] font-medium ${active ? 'text-ink' : 'text-ink3'}`}>
                  {p.month.slice(5)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p role="status" aria-live="polite" className="mt-3 rounded-xl px-3 py-2.5 text-[13px] text-ink2" style={{ background: 'var(--surface-2)' }}>
        {point ? (
          <>
            <span className="font-semibold text-ink">{monthLabel(point.month)}</span>
            {' · revenus '}
            <span className="num font-semibold" style={{ color: 'var(--positive)' }}>
              {formatMoney(point.income, currency)}
            </span>
            {' · dépenses '}
            <span className="num font-semibold" style={{ color: 'var(--danger)' }}>
              {formatMoney(point.expense, currency)}
            </span>
          </>
        ) : null}
      </p>
    </div>
  );
}
/* ============== Anneau « Où est parti mon argent ? » ============== */

function buildDonutGradient(items: Array<{ label: string; share: number }>): string | null {
  if (items.length === 0) return null;
  let cursor = 0;
  const stops: string[] = [];
  items.forEach((item, index) => {
    const color = SEGMENT_COLORS[index % SEGMENT_COLORS.length] ?? 'var(--ink-3)';
    const start = cursor;
    const end = Math.min(1, cursor + item.share);
    stops.push(`${color} ${(start * 360).toFixed(2)}deg ${(end * 360).toFixed(2)}deg`);
    cursor = end;
  });
  return `conic-gradient(${stops.join(', ')})`;
}

function ExpenseBreakdown({
  categories,
  currency,
}: {
  categories: AnalyticsOverviewResponse['currentMonthExpenseCategories'];
  currency: Currency;
}) {
  const gradient = useMemo(
    () => buildDonutGradient(categories.map((c) => ({ label: c.label, share: c.share }))),
    [categories],
  );
  const summary = useMemo(
    () => categories.map((c) => `${c.label} ${Math.round(c.share * 100)} %`).join(', '),
    [categories],
  );

  if (categories.length === 0) {
    return (
      <p className="text-sm leading-relaxed text-ink3">
        Rien à répartir ce mois-ci : dès que vous enregistrerez des dépenses,
        leur détail par catégorie apparaîtra ici.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="relative mx-auto h-36 w-36 shrink-0">
        <div
          role="img"
          aria-label={`Répartition des dépenses du mois : ${summary}`}
          className="h-full w-full rounded-full"
          style={{ background: gradient ?? 'var(--surface-2)' }}
        />
        <div
          aria-hidden="true"
          className="absolute rounded-full"
          style={{ inset: '21%', background: 'var(--surface)', boxShadow: '0 0 0 1px var(--edge)' }}
        />
      </div>
      <ul className="min-w-0 flex-1 space-y-1.5">
        {categories.map((category, index) => (
          <li
            key={`${category.categoryId ?? 'unknown'}-${category.label}`}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: SEGMENT_COLORS[index % SEGMENT_COLORS.length] ?? 'var(--ink-3)' }}
              />
              <span className="break-words text-ink2">{category.label}</span>
            </span>
            <span className="shrink-0 text-[13px]">
              <span className="num font-semibold text-ink">{formatMoney(category.amount, currency)}</span>
              <span className="ml-1.5 text-ink3">{Math.round(category.share * 100)} %</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
/* ============== Vue d'ensemble (intégration page d'accueil) ============== */

export function AnalyticsSection({
  currency,
  today,
}: {
  currency: Currency;
  /** Optionnel : date de référence YYYY-MM-DD pour des tests déterministes. */
  today?: string;
}) {
  const query = useSnapshotQuery('analytics', ['analytics-overview', today ?? 'now'], () => apiGetAnalyticsOverview(6, today));
  const data = query.data;

  return (
    <section
      id="guide-analytics"
      aria-label="Analytique de vos finances — lecture seule"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-ink">
            Analyser mes finances
          </h2>
          <p className="text-xs text-ink3">
            Revenus et dépenses sur 6 mois · répartition du mois en cours
          </p>
        </div>
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold text-ink3"
          style={{ background: 'var(--surface-2)' }}
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--positive)' }} />
          Lecture seule
        </span>
      </div>

      {query.offline && <p role="status" className="rounded-xl bg-raise p-3 text-sm text-ink2"><strong>Hors connexion</strong> · Dernière mise à jour : {new Date(query.syncedAt!).toLocaleString('fr-FR')} · Période : {data?.currentMonth}</p>}
      {query.isLoading && !data ? (
        <div className="grid gap-3 lg:grid-cols-5">
          <Panel className="p-5 lg:col-span-3">
            <p className="text-sm text-ink3">Chargement de l’analyse…</p>
          </Panel>
          <Panel className="p-5 lg:col-span-2">
            <p className="text-sm text-ink3">Chargement de l’analyse…</p>
          </Panel>
        </div>
      ) : null}

      {query.isError && !data ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3"
          style={{ background: 'color-mix(in srgb, var(--danger) 10%, transparent)' }}
        >
          <p className="text-sm" style={{ color: 'var(--danger)' }}>
            L’analyse est momentanément indisponible. {query.error?.message}
          </p>
          <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
            Réessayer
          </Button>
        </div>
      ) : null}

      {data ? (
        <div className="grid gap-3 lg:grid-cols-5">
          <Panel className="p-5 sm:p-6 lg:col-span-3">
            <div className="mb-4">
              <p className="text-sm font-semibold text-ink">Revenus vs dépenses</p>
              <p className="mt-0.5 text-xs text-ink3">
                Mois par mois — chaque barre est cliquable pour le détail
              </p>
            </div>
            <CashflowChart points={data.monthlyCashflow} currency={data.currency} />
          </Panel>
          <Panel className="p-5 sm:p-6 lg:col-span-2">
            <div className="mb-4">
              <p className="text-sm font-semibold text-ink">Où est parti mon argent&nbsp;?</p>
              <p className="mt-0.5 text-xs text-ink3">
                Dépenses du mois en cours par catégorie
              </p>
            </div>
            <ExpenseBreakdown categories={data.currentMonthExpenseCategories} currency={data.currency} />
          </Panel>
        </div>
      ) : null}
    </section>
  );
}



