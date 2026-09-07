import { Suspense, useState, type ComponentType } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useOnboarding } from '../onboarding';
import { NotificationsBell } from './NotificationsBell';
import { ThemeToggle } from './ThemeToggle';
import { Dialog } from './overlay';
import { Button, cx } from './ui';
import {
  IconArrowRight,
  IconBell,
  IconCalendarClock,
  IconGauge,
  IconHome,
  IconInfo,
  IconList,
  IconLogout,
  IconPlus,
  IconScale,
  IconSparkles,
  IconTarget,
  IconTransfer,
  IconTrendUp,
} from './icons';

interface NavEntry {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}

const GROUP_1: NavEntry[] = [{ to: '/', label: 'Accueil', icon: IconHome }];

const GROUP_MOVES: NavEntry[] = [
  { to: '/transactions', label: 'Transactions', icon: IconList },
  { to: '/transfers', label: 'Transferts', icon: IconTransfer },
];

const GROUP_PLAN: NavEntry[] = [
  { to: '/planned', label: 'Dépenses prévues', icon: IconCalendarClock },
  { to: '/expected', label: 'Revenus attendus', icon: IconTrendUp },
  { to: '/budgets', label: 'Budgets', icon: IconGauge },
];

const GROUP_WEALTH: NavEntry[] = [
  { to: '/savings', label: 'Épargne', icon: IconTarget },
  { to: '/debts', label: 'Dettes', icon: IconScale },
];

/** Toutes les destinations de « Plus » (mobile) sauf Accueil/Transactions/Planifié/Assistant. */
const PLUS_ENTRIES: NavEntry[] = [
  { to: '/transfers', label: 'Transferts', icon: IconTransfer },
  { to: '/expected', label: 'Revenus attendus', icon: IconTrendUp },
  { to: '/budgets', label: 'Budgets', icon: IconGauge },
  { to: '/savings', label: 'Épargne', icon: IconTarget },
  { to: '/debts', label: 'Dettes', icon: IconScale },
  { to: '/notifications', label: 'Notifications', icon: IconBell },
];

function GroupLabel({ children }: { children: string }) {
  return (
    <p className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink3 first:pt-2">
      {children}
    </p>
  );
}

function Brand() {
  return (
    <NavLink to="/" className="flex items-center gap-2.5 px-1" aria-label="Finance — accueil">
      <span
        className="flex h-9 w-9 items-center justify-center rounded-2xl text-[16px] font-black text-brand-ink"
        style={{ background: 'var(--brand)' }}
      >
        F
      </span>
      <span className="text-[19px] font-bold tracking-tight text-ink">Finance</span>
    </NavLink>
  );
}

function DesktopNavLink({ to, label, icon: Icon, end }: NavEntry & { end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
          isActive ? 'text-ink' : 'text-ink2 hover:bg-raise hover:text-ink',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            size={18}
            className={cx(
              'shrink-0',
              isActive ? 'text-brand-strong' : 'text-ink3 group-hover:text-ink2',
            )}
          />
          <span className="flex-1">{label}</span>
          {isActive ? (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: 'var(--brand)' }}
            />
          ) : null}
        </>
      )}
    </NavLink>
  );
}

function DesktopSidebar() {
  const { user, signOut } = useAuth();
  const { start } = useOnboarding();
  return (
    <aside
      className="fixed inset-y-0 left-0 z-40 hidden w-[264px] flex-col border-r bg-canvas px-3 pb-4 pt-5 lg:flex"
      style={{ borderColor: 'var(--edge)' }}
      aria-label="Navigation principale"
    >
      <div className="px-1">
        <Brand />
      </div>

      <nav data-guide="nav" className="mt-3 flex-1 overflow-y-auto pb-2">
        <GroupLabel>Pilotage</GroupLabel>
        <ul className="space-y-0.5">
          {GROUP_1.map((entry) => (
            <li key={entry.to}>
              <DesktopNavLink {...entry} end />
            </li>
          ))}
        </ul>

        <GroupLabel>Mouvements</GroupLabel>
        <ul className="space-y-0.5">
          {GROUP_MOVES.map((entry) => (
            <li key={entry.to}>
              <DesktopNavLink {...entry} />
            </li>
          ))}
        </ul>

        <GroupLabel>Planification</GroupLabel>
        <ul className="space-y-0.5">
          {GROUP_PLAN.map((entry) => (
            <li key={entry.to}>
              <DesktopNavLink {...entry} />
            </li>
          ))}
        </ul>

        <GroupLabel>Patrimoine</GroupLabel>
        <ul className="space-y-0.5">
          {GROUP_WEALTH.map((entry) => (
            <li key={entry.to}>
              <DesktopNavLink {...entry} />
            </li>
          ))}
        </ul>

        <GroupLabel>Produit</GroupLabel>
        <ul className="space-y-0.5">
          <li data-guide="assistant">
            <DesktopNavLink to="/assistant" label="Assistant" icon={IconSparkles} />
          </li>
          <li data-guide="bell">
            <DesktopNavLink to="/notifications" label="Notifications" icon={IconBell} />
          </li>
          <li>
            <button
              type="button"
              onClick={start}
              data-testid="relaunch-guide"
              aria-label="Relancer la prise en main guidée"
              className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-ink2 transition-colors hover:bg-raise hover:text-ink"
            >
              <IconInfo size={18} className="shrink-0 text-ink3 group-hover:text-brand-strong" />
              <span className="flex-1">Prise en main</span>
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: 'var(--brand)' }}
                aria-hidden="true"
              />
            </button>
          </li>
        </ul>
      </nav>

      <div className="border-t pt-3" style={{ borderColor: 'var(--edge)' }}>
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-ink">{user?.email ?? '…'}</p>
            <p className="text-[11px] text-ink3">Espace personnel</p>
          </div>
          <ThemeToggle showLabel={false} />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full !justify-start"
          onClick={() => void signOut()}
        >
          <IconLogout size={16} /> Déconnexion
        </Button>
      </div>
    </aside>
  );
}

/** Vrai si la route courante correspond à `to` (prefix sûr pour « / »). */
function useIsActive(to: string): boolean {
  const { pathname } = useLocation();
  if (to === '/') return pathname === '/';
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** Bandeau supérieur mobile : marque + cloche + thème (hidden >= 1024 px). */
function MobileTopBar() {
  return (
    <div
      className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b bg-canvas/95 px-4 py-2.5 backdrop-blur lg:hidden"
      style={{ borderColor: 'var(--edge)' }}
    >
      <Brand />
      <div className="flex items-center gap-1">
        <NotificationsBell />
        <div
          className="ml-1 flex items-center rounded-full px-1"
          style={{ background: 'var(--surface-2)' }}
        >
          <ThemeToggle showLabel={false} />
        </div>
      </div>
    </div>
  );
}

function MobileTabItem({ to, label, icon: Icon, end }: NavEntry & { end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10.5px] font-medium transition-colors',
          isActive ? 'text-ink' : 'text-ink3',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span className="relative">
            <Icon size={21} className={isActive ? 'text-brand-strong' : ''} />
          </span>
          <span className="truncate">{label}</span>
        </>
      )}
    </NavLink>
  );
}

/** Barre de navigation fixe en bas (mobile < 1024 px) : 5 entrées maximum. */
function MobileBottomNav() {
  const { signOut } = useAuth();
  const { start } = useOnboarding();
  const [plusOpen, setPlusOpen] = useState(false);
  const anyPlusActive = PLUS_ENTRIES.some((entry) => useIsActive(entry.to));

  return (
    <>
      <nav
        data-guide="nav"
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-canvas/95 px-1 pb-[max(env(safe-area-inset-bottom),6px)] pt-1 backdrop-blur lg:hidden"
        style={{ borderColor: 'var(--edge)' }}
        aria-label="Navigation mobile"
      >
        <div className="mx-auto flex max-w-lg items-stretch justify-between">
          <MobileTabItem to="/" label="Accueil" icon={IconHome} end />
          <MobileTabItem to="/transactions" label="Transactions" icon={IconList} />
          <MobileTabItem to="/planned" label="Planifié" icon={IconCalendarClock} />
          <MobileTabItem to="/assistant" label="Assistant" icon={IconSparkles} />
          <button
            type="button"
            onClick={() => setPlusOpen(true)}
            aria-expanded={plusOpen}
            aria-haspopup="dialog"
            data-guide="plus"
            className={cx(
              'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10.5px] font-medium',
              anyPlusActive ? 'text-ink' : 'text-ink3',
            )}
          >
            <IconPlus size={21} className={anyPlusActive ? 'text-brand-strong' : ''} />
            Plus
          </button>
        </div>
      </nav>

      <Dialog
        open={plusOpen}
        onClose={() => setPlusOpen(false)}
        title="Tout le reste"
        footer={
          <Button
            variant="ghost"
            className="w-full !justify-center text-danger"
            onClick={() => {
              setPlusOpen(false);
              void signOut();
            }}
          >
            <IconLogout size={16} /> Déconnexion
          </Button>
        }
      >
        <ul className="divide-y" style={{ borderColor: 'var(--edge)' }}>
          {PLUS_ENTRIES.map((entry) => (
            <li key={entry.to}>
              <NavLink
                to={entry.to}
                onClick={() => setPlusOpen(false)}
                className={({ isActive }) =>
                  cx(
                    'flex items-center gap-3 py-3 text-[15px] font-medium',
                    isActive ? 'text-ink' : 'text-ink2',
                  )
                }
              >
                <span
                  className="flex h-10 w-10 items-center justify-center rounded-2xl"
                  style={{ background: 'var(--surface-2)' }}
                >
                  <entry.icon size={19} />
                </span>
                <span className="flex-1">{entry.label}</span>
                <IconArrowRight size={17} className="text-ink3" />
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="mt-1 border-t pt-3" style={{ borderColor: 'var(--edge)' }}>
          <button
            type="button"
            onClick={() => {
              setPlusOpen(false);
              start();
            }}
            className="group flex w-full items-center gap-3 py-2 text-left text-[15px] font-medium text-ink2 transition-colors hover:text-ink"
          >
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl"
              style={{ background: 'var(--brand-soft)' }}
            >
              <IconInfo size={19} className="text-brand-strong" />
            </span>
            <span className="flex-1">Prise en main guidée</span>
            <IconArrowRight size={17} className="text-ink3" />
          </button>
          <p className="mt-1 px-1 text-[11px] text-ink3">
            Revoir l’aide au démarrage à tout moment, sans rien réinitialiser.
          </p>
        </div>
      </Dialog>
    </>
  );
}

/**
 * Structure applicative : sidebar desktop (>= 1024 px) à gauche, barre
 * inférieure mobile (< 1024 px), contenu centré et aéré. Le code-splitting par
 * route (lazy) reste intact : les pages sont chargées via <Outlet/> + Suspense.
 */
export default function Chrome() {
  return (
    <div className="min-h-screen bg-canvas text-ink lg:pl-[264px]">
      <DesktopSidebar />
      <MobileTopBar />
      <main id="contenu" className="min-h-screen">
        <div className="mx-auto w-full max-w-6xl px-4 pb-28 pt-4 sm:px-6 sm:pt-6 lg:px-10 lg:pb-14 lg:pt-8">
          <Suspense
            fallback={
              <div className="flex min-h-[40vh] items-center justify-center">
                <div
                  className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent"
                  style={{ borderColor: 'var(--edge-strong)', borderTopColor: 'var(--brand)' }}
                />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </div>
      </main>
      <MobileBottomNav />
    </div>
  );
}

