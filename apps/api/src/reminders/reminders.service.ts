import { prisma } from '../db.js';
import { todayLocalISO } from '../dates.js';
import { toPlannedPublic } from '../planned-expenses/planned-expenses.service.js';
import type { RemindersResponse } from '@finance/shared-types';

/**
 * Rappels internes « Payé ? » (V1, read-only).
 *
 * Aucune table Reminder : l'état est DÉRIVÉ de dueDate + status (finance-core).
 * Une dépense PAID / CANCELED / SKIPPED n'est jamais un rappel actif.
 * Le frontend transmet son jour local (YYYY-MM-DD) afin que « aujourd'hui »,
 * « en retard » et « à venir » soient calculés dans SON fuseau, pas celui du
 * serveur.
 *
 * STRICTEMENT READ-ONLY : aucune écriture Prisma, aucune génération
 * d'occurrence. La maintenance des occurrences n'a lieu qu'aux actions
 * explicites (mutation de règle, bootstrap API, node-cron).
 */
export async function getReminders(
  userId: string,
  today: string = todayLocalISO(),
): Promise<RemindersResponse> {
  const rows = await prisma.plannedExpense.findMany({
    where: { userId, status: 'PENDING' },
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    include: { category: { select: { id: true, name: true } } },
  });

  const planned = rows.map((row) => toPlannedPublic(row as Parameters<typeof toPlannedPublic>[0], today));
  const overdue: typeof planned = [];
  const dueToday: typeof planned = [];
  const upcoming: typeof planned = [];
  for (const item of planned) {
    if (item.bucket === 'overdue') {
      overdue.push(item);
    } else if (item.bucket === 'due') {
      dueToday.push(item);
    } else if (item.bucket === 'upcoming') {
      upcoming.push(item);
    }
    // 'later' n'est pas un rappel immédiat : il reste visible dans la page
    // « Dépenses à venir » (GET /planned-expenses).
  }

  return { today, overdue, dueToday, upcoming };
}
