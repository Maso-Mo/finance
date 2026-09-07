import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGetNotifications } from '../auth/api';

/**
 * Cloche de notifications (étape 12) — badge « non lues » du centre interne.
 *
 * Le compteur vient des AppNotification `isRead = false` (GET read-only),
 * jamais d'un calcul métier financier côté React. Accessible clavier et doté
 * d'un aria-label clair. Si le backend est indisponible, la cloche reste
 * silencieusement accessible (le centre, lui, reste fonctionnel).
 */
export function NotificationsBell() {
  const query = useQuery({
    queryKey: ['notification-unread-count'],
    queryFn: () => apiGetNotifications({ limit: 1 }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const unreadCount =
    query.data && query.data.unreadCount > 0 ? query.data.unreadCount : 0;

  return (
    <Link
      to="/notifications"
      data-guide="bell"
      aria-label={
        unreadCount > 0
          ? `Notifications : ${unreadCount} non lues`
          : 'Notifications'
      }
      className="relative inline-flex h-8 w-8 items-center justify-center rounded-lg border border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
      title="Centre de notifications"
    >
      <span aria-hidden="true" className="text-base leading-none">
        🔔
      </span>
      {unreadCount > 0 && (
        <span
          aria-hidden="true"
          className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-none text-white"
        >
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </Link>
  );
}
