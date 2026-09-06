import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AppNotificationPublic,
  NotificationPreferencePublic,
} from '@finance/shared-types';
import { useAuth } from '../auth/AuthContext';
import {
  apiCreatePushSubscription,
  apiDeletePushSubscription,
  apiGetNotificationPreferences,
  apiGetNotifications,
  apiGetPushConfig,
  apiGetPushSubscriptions,
  apiMarkNotificationRead,
  apiReadAllNotifications,
  apiUpdateNotificationPreferences,
} from '../auth/api';
import { ThemeToggle } from '../components/ThemeToggle';
import {
  currentPushStatus,
  disableBrowserPush,
  enableBrowserPush,
  isBrowserPushSupported,
  subscriptionToPayload,
} from '../lib/push';

const card =
  'rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900';
const btn =
  'rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800';
const btnPrimary =
  'rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50';

const TIMEZONES = [
  'UTC',
  'Indian/Antananarivo',
  'Europe/Paris',
  'America/Toronto',
  'Africa/Nairobi',
  'America/New_York',
  'Europe/London',
];

const TYPE_LABEL: Record<AppNotificationPublic['type'], string> = {
  PLANNED_EXPENSE_DUE: 'Paiement à vérifier',
  PLANNED_EXPENSE_OVERDUE: 'Paiement en retard',
  EXPECTED_INCOME_DUE: 'Revenu attendu',
  EXPECTED_INCOME_WINDOW: 'Revenu attendu — reçu ?',
  EXPECTED_INCOME_OVERDUE: 'Revenu non confirmé',
  DEBT_DUE: 'Échéance dette',
  DEBT_OVERDUE: 'Échéance dette en retard',
};

export default function NotificationsPage() {
  const { status, user, signOut } = useAuth();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'none' | 'push' | 'save'>('none');

  const prefsQuery = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: apiGetNotificationPreferences,
    staleTime: 30_000,
  });
  const pushConfigQuery = useQuery({
    queryKey: ['push-config'],
    queryFn: apiGetPushConfig,
    staleTime: 30_000,
  });
  const listQuery = useQuery({
    queryKey: ['notifications', page],
    queryFn: () => apiGetNotifications({ page, limit: 20 }),
    staleTime: 15_000,
  });
  const subscriptionsQuery = useQuery({
    queryKey: ['push-subscriptions'],
    queryFn: apiGetPushSubscriptions,
    staleTime: 30_000,
  });

  const prefs: NotificationPreferencePublic | undefined = prefsQuery.data;
  const detected = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return 'UTC';
    }
  }, []);
  const [timezone, setTimezone] = useState<string | null>(null);

  useEffect(() => {
    if (prefs && timezone === null) {
      setTimezone(prefs.timezone ?? detected);
    }
  }, [prefs, timezone, detected]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    void queryClient.invalidateQueries({
      queryKey: ['notification-unread-count'],
    });
    void queryClient.invalidateQueries({ queryKey: ['notification-preferences'] });
    void queryClient.invalidateQueries({ queryKey: ['push-subscriptions'] });
  };

  const saveMutation = useMutation({
    mutationFn: () =>
      apiUpdateNotificationPreferences({ timezone: timezone ?? detected }),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });

  const toggleAmountsMutation = useMutation({
    mutationFn: (value: boolean) =>
      apiUpdateNotificationPreferences({ showAmountsInPush: value }),
    onSuccess: () => refresh(),
    onError: (e: Error) => setError(e.message),
  });

  const markReadMutation = useMutation({
    mutationFn: apiMarkNotificationRead,
    onSuccess: () => refresh(),
  });
  const readAllMutation = useMutation({
    mutationFn: apiReadAllNotifications,
    onSuccess: () => refresh(),
  });

  async function handleEnablePush() {
    setError(null);
    setBusy('push');
    try {
      const result = await enableBrowserPush(pushConfigQuery.data?.publicKey ?? null);
      if (!result.ok) {
        setError(result.message ?? 'Activation impossible.');
        return;
      }
      const payload = subscriptionToPayload(result.subscription);
      if (!payload.endpoint) {
        setError('Abonnement navigateur invalide.');
        return;
      }
      await apiCreatePushSubscription(payload);
      await apiUpdateNotificationPreferences({
        browserPushEnabled: true,
        timezone: timezone ?? detected,
      });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Échec de l’activation.');
    } finally {
      setBusy('none');
    }
  }

  async function handleDisablePush() {
    setError(null);
    setBusy('push');
    try {
      await disableBrowserPush();
      const { subscriptions } = await apiGetPushSubscriptions();
      for (const subscription of subscriptions) {
        await apiDeletePushSubscription(subscription.id);
      }
      await apiUpdateNotificationPreferences({
        browserPushEnabled: false,
        timezone: timezone ?? detected,
      });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Échec de la désactivation.');
    } finally {
      setBusy('none');
    }
  }

  function submitTimezone(event: FormEvent) {
    event.preventDefault();
    setError(null);
    saveMutation.mutate();
  }

  if (status === 'loading') {
    return <div className="flex min-h-screen items-center justify-center bg-neutral-100 text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">Restauration de session…</div>;
  }
  if (status === 'guest') {
    return <Navigate to="/login" replace />;
  }

  const list = listQuery.data;
  const pushSupported = isBrowserPushSupported();
  const pushAvailable = pushConfigQuery.data?.pushAvailable ?? false;
  const pushPermission = currentPushStatus().permission;
  const subscriptions = subscriptionsQuery.data?.subscriptions ?? [];
  const hasActiveSubscription = subscriptions.some((s) => s.disabledAt === null);

  return (
    <main className="min-h-screen bg-neutral-100 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/" className={btn}>Accueil</Link>
          <h1 className="text-lg font-semibold">Notifications</h1>
          <span className="hidden text-xs text-neutral-500 sm:inline dark:text-neutral-400">{user?.email}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ThemeToggle />
          <button type="button" onClick={() => void signOut()} className={btn}>Déconnexion</button>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-8">
        {error && (
          <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{error}</p>
        )}

        <section className={`${card} mb-6`} aria-label="Paramètres des notifications">
          <h2 className="text-base font-semibold">Paramètres</h2>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            Notifications dans l’application : toujours actives. Notifications
            navigateur : optionnelles, activées uniquement sur votre clic
            explicite.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <form onSubmit={submitTimezone} className="flex flex-col gap-2">
              <label className="block">
                <span className="text-sm font-medium">Fuseau horaire</span>
                <input
                  list="finance-timezones"
                  value={timezone ?? ''}
                  onChange={(e) => setTimezone(e.target.value)}
                  aria-label="Fuseau horaire"
                  className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
                />
                <datalist id="finance-timezones">
                  {TIMEZONES.map((tz) => <option key={tz} value={tz} />)}
                </datalist>
              </label>
              <button type="submit" disabled={busy === 'save'} className={btnPrimary}>
                Enregistrer le fuseau
              </button>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                Jour local détecté : {detected}. Corrigez si besoin.
              </p>
            </form>

            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Notifications navigateur</p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    {!pushSupported
                      ? 'Non prises en charge sur ce navigateur.'
                      : !pushAvailable
                        ? 'Indisponibles côté serveur — le centre interne reste actif.'
                        : pushPermission === 'denied'
                          ? 'Refusées par ce navigateur.'
                          : 'Reçues même si l’onglet Finance est fermé.'}
                  </p>
                </div>
                {pushSupported && pushAvailable ? (
                  prefs?.browserPushEnabled ? (
                    <button type="button" onClick={() => void handleDisablePush()} disabled={busy === 'push'} className={btn}>Désactiver</button>
                  ) : pushPermission === 'denied' ? (
                    <span className="text-xs font-medium text-neutral-400 dark:text-neutral-500">Bloqué par le navigateur</span>
                  ) : (
                    <button type="button" onClick={() => void handleEnablePush()} disabled={busy === 'push'} className={btnPrimary}>Activer</button>
                  )
                ) : (
                  <span className="text-xs font-medium text-neutral-400 dark:text-neutral-500">Non disponible</span>
                )}
              </div>

              <label className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">
                  Afficher les montants dans les notifications navigateur
                </span>
                <input
                  type="checkbox"
                  checked={prefs?.showAmountsInPush ?? false}
                  onChange={(e) => toggleAmountsMutation.mutate(e.target.checked)}
                  aria-label="Afficher les montants dans les notifications navigateur"
                  className="h-4 w-4 accent-indigo-600"
                />
              </label>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                Désactivé par défaut : les push restent génériques
                (confidentialité : écran verrouillé, salle partagée).
              </p>
              {subscriptions.length > 0 && (
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {hasActiveSubscription ? subscriptions.length : 0} appareil(s)
                  enregistré(s) pour le Web Push.
                </p>
              )}
            </div>
          </div>
        </section>

        <section className={card} aria-label="Centre de notifications">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Centre de notifications</h2>
            {(list?.unreadCount ?? 0) > 0 && (
              <button type="button" onClick={() => readAllMutation.mutate()} className={btn}>
                Tout marquer comme lu
              </button>
            )}
          </div>

          {list && list.notifications.length === 0 && (
            <p className="mt-6 py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
              Aucune notification pour le moment.
            </p>
          )}

          <ul className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
            {list?.notifications.map((notification) => (
              <NotificationRow
                key={notification.id}
                notification={notification}
                onOpen={() => {
                  if (!notification.isRead) markReadMutation.mutate(notification.id);
                }}
                onMarkRead={() => markReadMutation.mutate(notification.id)}
              />
            ))}
          </ul>

          {list && list.total > list.limit && (
            <div className="mt-4 flex items-center justify-between gap-3">
              <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className={btn}>
                Précédent
              </button>
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                Page {list.page} / {Math.ceil(list.total / list.limit)}
              </span>
              <button type="button" disabled={page * list.limit >= list.total} onClick={() => setPage((p) => p + 1)} className={btn}>
                Suivant
              </button>
            </div>
          )}
        </section>

        <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
          Une notification est uniquement informative : elle n’effectue jamais
          une action financière. « Marquer comme lu » ne confirme ni un
          paiement, ni un revenu, ni un remboursement.
        </p>
      </div>
    </main>
  );
}

function dateHuman(value: string): string {
  return new Date(`${value}T00:00:00`).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function NotificationRow({
  notification,
  onOpen,
  onMarkRead,
}: {
  notification: AppNotificationPublic;
  onOpen: () => void;
  onMarkRead: () => void;
}) {
  return (
    <li className="flex items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {!notification.isRead && (
            <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
              Non lue
            </span>
          )}
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            {TYPE_LABEL[notification.type]}
          </span>
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            {dateHuman(notification.localDate)}
          </span>
        </div>
        <p className={`mt-1 text-sm ${notification.isRead ? 'text-neutral-500 dark:text-neutral-400' : 'font-medium text-neutral-800 dark:text-neutral-100'}`}>
          {notification.body}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <Link to={notification.route} onClick={onOpen} className={btn} aria-label={`Ouvrir ${notification.title}`}>
          Ouvrir
        </Link>
        {!notification.isRead && (
          <button type="button" onClick={onMarkRead} className="text-xs text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400">
            Marquer comme lu
          </button>
        )}
      </div>
    </li>
  );
}

