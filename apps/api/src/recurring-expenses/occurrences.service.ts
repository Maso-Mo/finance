import { prisma } from '../db.js';
import { dateInputToDate, dbDateToISO, todayLocalISO } from '../dates.js';
import { generateMonthlyOccurrences } from '@finance/finance-core';
import { Prisma } from '../generated/prisma/client.js';
import type { RecurringExpenseRule } from '../generated/prisma/client.js';

/**
 * Génération / synchronisation des OCCURRENCES d'une règle récurrente.
 *
 * Une RecurringExpenseRule n'est PAS une dépense : elle génère des
 * PlannedExpense PENDING, une par mois calendaire. La synchronisation est :
 *  - déterministe (finance-core) ;
 *  - idempotente (aucun doublon : contrainte unique + createMany skipDuplicates) ;
 *  - sans effet financier : rien n'est payé, aucun solde n'est touché ;
 *  - sûre même si le cron n'a pas tourné pendant plusieurs jours (rattrapage
 *    propre des mois manquants lors du prochain appel).
 *
 * Règles de synchronisation (invariant « au plus une occurrence par mois ») :
 *  - mois déjà résolu (PAID / CANCELED / SKIPPED) → jamais réécrit ;
 *  - mois PENDING → mis à jour (montant/jour/catégorie après édition) ;
 *  - mois candidat absent → créé PENDING ;
 *  - PENDING devenu hors périmètre (start/end modifiés, règle désactivée) →
 *    CANCELED proprement.
 */

export type RuleLike = RecurringExpenseRule;

function dueKey(date: Date): string {
  return dbDateToISO(date).slice(0, 7);
}

/** Champs récurrents d'une occurrence (copiés depuis la règle). */
function occurrenceData(rule: RuleLike) {
  return {
    userId: rule.userId,
    amount: rule.amount,
    currency: rule.currency,
    categoryId: rule.categoryId,
    categoryUnknown: rule.categoryUnknown,
    description: rule.description,
    recurringRuleId: rule.id,
  };
}

/**
 * Synchronise les occurrences d'une règle dans une transaction Prisma.
 * Doit être appelé AVEC la règle déjà à jour (création, édition, startup).
 */
export async function syncRuleOccurrences(
  tx: Prisma.TransactionClient,
  rule: RuleLike,
  referenceDate: string = todayLocalISO(),
): Promise<void> {
  if (!rule.isActive) {
    // Règle désactivée : on n'ajoute RIEN. Les PENDING résiduelles sont
    // annulées par l'appelant (désactivation), pas ici.
    return;
  }

  const dueDates = generateMonthlyOccurrences({
    startDate: dbDateToISO(rule.startDate),
    endDate: rule.endDate ? dbDateToISO(rule.endDate) : null,
    dayOfMonth: rule.dayOfMonth,
    referenceDate,
  });

  const dueByMonth = new Map<string, string>();
  for (const due of dueDates) {
    dueByMonth.set(due.slice(0, 7), due);
  }

  const rows = await tx.plannedExpense.findMany({
    where: { recurringRuleId: rule.id },
    select: { id: true, status: true, dueDate: true },
  });

  const resolvedMonths = new Set<string>();
  const pendingsByMonth = new Map<string, { id: string }>();
  for (const row of rows) {
    if (row.status === 'PENDING') {
      pendingsByMonth.set(dueKey(row.dueDate), { id: row.id });
    } else {
      resolvedMonths.add(dueKey(row.dueDate));
    }
  }

  // Mise à jour des occurrences PENDING candidates + collecte des créations.
  const toCreate: Prisma.PlannedExpenseCreateManyInput[] = [];
  for (const [month, due] of dueByMonth) {
    if (resolvedMonths.has(month)) {
      // Mois déjà payé/ignoré/annulé : invariant « une occurrence par mois ».
      continue;
    }
    const pending = pendingsByMonth.get(month);
    if (pending) {
      await tx.plannedExpense.update({
        where: { id: pending.id },
        data: {
          ...occurrenceData(rule),
          dueDate: dateInputToDate(due),
        },
      });
    } else {
      toCreate.push({
        ...occurrenceData(rule),
        dueDate: dateInputToDate(due),
      });
    }
  }
  if (toCreate.length > 0) {
    await tx.plannedExpense.createMany({
      data: toCreate,
      skipDuplicates: true,
    });
  }

  // PENDING hors candidats (périmètre déplacé) → CANCELED proprement.
  const keep = new Set(dueByMonth.keys());
  const cancelIds: string[] = [];
  for (const [month, pending] of pendingsByMonth) {
    if (!keep.has(month) || resolvedMonths.has(month)) {
      cancelIds.push(pending.id);
    }
  }
  if (cancelIds.length > 0) {
    await tx.plannedExpense.updateMany({
      where: { id: { in: cancelIds } },
      data: { status: 'CANCELED' },
    });
  }
}

/** Rattrapage de TOUTES les règles actives de l'utilisateur (appel lecture). */
export async function ensureOccurrencesForUser(
  userId: string,
  referenceDate: string = todayLocalISO(),
): Promise<void> {
  const rules = await prisma.recurringExpenseRule.findMany({
    where: { userId, isActive: true },
  });
  if (rules.length === 0) {
    return;
  }
  await prisma.$transaction(async (tx) => {
    for (const rule of rules) {
      await syncRuleOccurrences(tx, rule, referenceDate);
    }
  });
}

/** Rattrapage global (démarrage API + node-cron). Idempotent. */
export async function ensureAllActiveOccurrences(
  referenceDate: string = todayLocalISO(),
): Promise<void> {
  const rules = await prisma.recurringExpenseRule.findMany({
    where: { isActive: true },
  });
  if (rules.length === 0) {
    return;
  }
  await prisma.$transaction(async (tx) => {
    for (const rule of rules) {
      await syncRuleOccurrences(tx, rule, referenceDate);
    }
  });
}
