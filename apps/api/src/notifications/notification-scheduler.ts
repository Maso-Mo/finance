/**
 * Scheduler / maintenance de NOTIFICATIONS (étape 12).
 *
 * ⚠ RÈGLE ABSOLUE : cette passe ne crée QUE des AppNotification et des
 * données de livraison Push. Elle ne modifie JAMAIS une Transaction, un
 * AccountTransfer, un DebtSettlement, un AccountAdjustment, un solde, un
 * budget, un statut de PlannedExpense/ExpectedIncome/Debt ou un plan
 * d'épargne (testé explicitement dans la suite API).
 *
 * Cadence V1 :
 *  - passe quotidienne, exécutée à chaque tick du cron (toutes les heures) ;
 *  - pour chaque utilisateur ayant une PRÉFÉRENCE (timezone IANA), on calcule
 *    son jour LOCAL et son heure locale ; tant que `localTime` (09:00 par
 *    défaut) n'est pas atteint, la passe ne génère rien pour lui ;
 *  - DÉDUPLICATION BASE : `dedupeKey` UNIQUE = « au maximum UNE notification
 *    par (utilisateur × source × type × jour LOCAL) » → createMany
 *    skipDuplicates + relances répétées du cron = aucun doublon, même en
 *    concurrence ;
 *  - rappels OVERDUE : un JOUR LOCAL différent produit une NOUVELLE clé → un
 *    rappel quotidien max par jour en retard, l'historique du centre reste.
 *
 * Bootstrap : `runNotificationMaintenance(now)` est aussi appelé au démarrage
 * de l'API (rattrapage du jour courant, toujours idempotent).
 *
 * Déclencheurs UNIQUEMENT explicites : cron, bootstrap — JAMAIS un GET.
 */
import { prisma } from '../db.js';
import { dateInputToDate, dbDateToISO } from '../dates.js';
import {
  classifyExpectedIncomeByDate,
  classifyExpectedIncomeByWindow,
  debtRemaining,
  debtSettledAmount,
  isDailyWindowReached,
  isValidTimeZone,
  zonedDateISO,
  zonedTimeHHMM,
} from '@finance/finance-core';
import { isWebPushConfigured } from './push-config.js';
import {
  defaultPushBody,
  debtCenterBody,
  debtCenterTitle,
  detailedPushBody,
  formatDateForText,
  incomeCenterBody,
  incomeCenterTitle,
  plannedCenterBody,
  plannedCenterTitle,
} from './texts.js';
import { sendWebPush } from './push-transport.js';

/** Routes internes ouvertes au clic (aucune action financière au clic). */
const ROUTE_BY_SOURCE = {
  PLANNED_EXPENSE: '/planned',
  EXPECTED_INCOME: '/expected',
  DEBT: '/debts',
} as const;

/** Une livraison PENDING « fraîche » est considérée en cours : on ne l'envoie
 * pas deux fois. Au-delà, on considère le créateur disparu et on reprend. */
const STALE_PENDING_MS = 5 * 60 * 1000;

export interface NotificationMaintenanceSummary {
  /** Utilisateurs (préférence active) dont la fenêtre locale est atteinte. */
  usersProcessed: number;
  /** AppNotification nouvellement créées (0 si déjà présentes). */
  generated: number;
  /** Livraisons Push marquées SENT. */
  deliveriesSent: number;
  /** Livraisons Push en échec (réessayées plus tard). */
  deliveriesFailed: number;
  /** Abonnements désactivés après 404/410 du fournisseur. */
  subscriptionsDisabled: number;
}

type PlannedCandidate = {
  id: string;
  amount: { toString(): string };
  currency: string;
  description: string | null;
  dueDate: Date;
};

type IncomeCandidate = {
  id: string;
  amount: { toString(): string };
  currency: string;
  description: string | null;
  expectedDate: Date | null;
  windowStart: Date | null;
  windowEnd: Date | null;
};

type DebtCandidate = {
  id: string;
  direction: string;
  kind: string;
  originalAmount: { toString(): string };
  currency: string;
  counterpartyName: string | null;
  dueDate: Date | null;
  /** Σ montants des règlements ACTIFS. */
  settled: string;
};

/** Événement prêt à insérer (une ligne = une notification). */
type DailyNotificationInsert = {
  userId: string;
  sourceType: string;
  sourceId: string;
  type: string;
  localDate: Date;
  dedupeKey: string;
  title: string;
  body: string;
  route: string;
  pushBody: string | null;
};

export function dedupeKeyFor(
  userId: string,
  sourceType: string,
  sourceId: string,
  type: string,
  localDateISO: string,
): string {
  return `${userId}|${sourceType}|${sourceId}|${type}|${localDateISO}`;
}

function dailyPushBody(
  type: string,
  showAmounts: boolean,
  amount: string,
  currency: string,
): string | null {
  if (!showAmounts) {
    return defaultPushBody(type);
  }
  return detailedPushBody(type, amount, currency);
}

function plannedEvents(
  userId: string,
  todayISO: string,
  rows: PlannedCandidate[],
  pushAllowed: boolean,
  showAmounts: boolean,
): DailyNotificationInsert[] {
  const events: DailyNotificationInsert[] = [];
  for (const row of rows) {
    const dueISO = dbDateToISO(row.dueDate);
    const type =
      dueISO < todayISO ? 'PLANNED_EXPENSE_OVERDUE' : 'PLANNED_EXPENSE_DUE';
    const amount = row.amount.toString();
    events.push({
      userId,
      sourceType: 'PLANNED_EXPENSE',
      sourceId: row.id,
      type,
      localDate: dateInputToDate(todayISO),
      dedupeKey: dedupeKeyFor(userId, 'PLANNED_EXPENSE', row.id, type, todayISO),
      title: plannedCenterTitle(
        type as 'PLANNED_EXPENSE_DUE' | 'PLANNED_EXPENSE_OVERDUE',
      ),
      body: plannedCenterBody(
        type as 'PLANNED_EXPENSE_DUE' | 'PLANNED_EXPENSE_OVERDUE',
        {
          amount,
          currency: row.currency,
          description: row.description,
          dueDate: dueISO,
        },
      ),
      route: ROUTE_BY_SOURCE.PLANNED_EXPENSE,
      pushBody: pushAllowed
        ? dailyPushBody(type, showAmounts, amount, row.currency)
        : null,
    });
  }
  return events;
}

function incomeEvents(
  userId: string,
  todayISO: string,
  rows: IncomeCandidate[],
  pushAllowed: boolean,
  showAmounts: boolean,
): DailyNotificationInsert[] {
  const events: DailyNotificationInsert[] = [];
  for (const row of rows) {
    const amount = row.amount.toString();
    let type: string | null = null;
    let timingLabel = '';
    if (row.expectedDate) {
      const exactISO = dbDateToISO(row.expectedDate);
      const bucket = classifyExpectedIncomeByDate(exactISO, todayISO, 'PENDING');
      if (bucket === 'dueToday') {
        type = 'EXPECTED_INCOME_DUE';
        timingLabel = `aujourd'hui (${formatDateForText(exactISO)})`;
      } else if (bucket === 'overdue') {
        type = 'EXPECTED_INCOME_OVERDUE';
        timingLabel = `du ${formatDateForText(exactISO)}`;
      }
    } else if (row.windowStart && row.windowEnd) {
      const startISO = dbDateToISO(row.windowStart);
      const endISO = dbDateToISO(row.windowEnd);
      const bucket = classifyExpectedIncomeByWindow(
        startISO,
        endISO,
        todayISO,
        'PENDING',
      );
      if (bucket === 'inWindow') {
        type = 'EXPECTED_INCOME_WINDOW';
        timingLabel = `du ${formatDateForText(startISO)} au ${formatDateForText(endISO)}`;
      } else if (bucket === 'overdue') {
        type = 'EXPECTED_INCOME_OVERDUE';
        timingLabel = `du ${formatDateForText(startISO)} au ${formatDateForText(endISO)}`;
      }
    }
    if (!type) {
      continue;
    }
    events.push({
      userId,
      sourceType: 'EXPECTED_INCOME',
      sourceId: row.id,
      type,
      localDate: dateInputToDate(todayISO),
      dedupeKey: dedupeKeyFor(userId, 'EXPECTED_INCOME', row.id, type, todayISO),
      title: incomeCenterTitle(
        type as
          | 'EXPECTED_INCOME_DUE'
          | 'EXPECTED_INCOME_WINDOW'
          | 'EXPECTED_INCOME_OVERDUE',
      ),
      body: incomeCenterBody(
        type as
          | 'EXPECTED_INCOME_DUE'
          | 'EXPECTED_INCOME_WINDOW'
          | 'EXPECTED_INCOME_OVERDUE',
        {
          amount,
          currency: row.currency,
          description: row.description,
          timingLabel,
        },
      ),
      route: ROUTE_BY_SOURCE.EXPECTED_INCOME,
      pushBody: pushAllowed
        ? dailyPushBody(type, showAmounts, amount, row.currency)
        : null,
    });
  }
  return events;
}

function debtEvents(
  userId: string,
  todayISO: string,
  rows: DebtCandidate[],
  pushAllowed: boolean,
  showAmounts: boolean,
): DailyNotificationInsert[] {
  const events: DailyNotificationInsert[] = [];
  for (const row of rows) {
    if (!row.dueDate) {
      continue; // aucune échéance connue → aucun rappel temporel inventé.
    }
    const remaining = debtRemaining(row.originalAmount.toString(), row.settled);
    if (remaining.lte(0)) {
      continue; // dette soldée → plus aucun rappel quotidien.
    }
    const dueISO = dbDateToISO(row.dueDate);
    const type = dueISO < todayISO ? 'DEBT_OVERDUE' : 'DEBT_DUE';
    const remainingText = remaining.toString();
    events.push({
      userId,
      sourceType: 'DEBT',
      sourceId: row.id,
      type,
      localDate: dateInputToDate(todayISO),
      dedupeKey: dedupeKeyFor(userId, 'DEBT', row.id, type, todayISO),
      title: debtCenterTitle(
        type as 'DEBT_DUE' | 'DEBT_OVERDUE',
        row.direction,
        row.kind,
      ),
      body: debtCenterBody(type as 'DEBT_DUE' | 'DEBT_OVERDUE', {
        remaining: remainingText,
        currency: row.currency,
        direction: row.direction as 'I_OWE' | 'OWED_TO_ME',
        kind: row.kind as 'STANDARD' | 'INCOME_ADVANCE_RECEIVABLE',
        counterpartyName: row.counterpartyName,
        dueDate: dueISO,
      }),
      route: ROUTE_BY_SOURCE.DEBT,
      pushBody: pushAllowed
        ? dailyPushBody(type, showAmounts, remainingText, row.currency)
        : null,
    });
  }
  return events;
}

/**
 * Étape 1 — génération idempotente des notifications du jour LOCAL d'un
 * utilisateur. Ne crée QUE des AppNotification (aucune écriture financière).
 */
export async function generateDailyNotificationsForUser(
  userId: string,
  todayISO: string,
  options: { pushAllowed: boolean; showAmounts: boolean },
): Promise<number> {
  const day = dateInputToDate(todayISO);
  const [planned, incomes, debts] = await Promise.all([
    prisma.plannedExpense.findMany({
      where: { userId, status: 'PENDING', dueDate: { lte: day } },
      select: {
        id: true,
        amount: true,
        currency: true,
        description: true,
        dueDate: true,
      },
    }),
    prisma.expectedIncome.findMany({
      where: {
        userId,
        status: 'PENDING',
        OR: [{ expectedDate: { lte: day } }, { windowStart: { lte: day } }],
      },
      select: {
        id: true,
        amount: true,
        currency: true,
        description: true,
        expectedDate: true,
        windowStart: true,
        windowEnd: true,
      },
    }),
    prisma.debt.findMany({
      where: { userId, deletedAt: null, dueDate: { not: null, lte: day } },
      select: {
        id: true,
        direction: true,
        kind: true,
        originalAmount: true,
        currency: true,
        counterpartyName: true,
        dueDate: true,
        settlements: { where: { deletedAt: null }, select: { amount: true } },
      },
    }),
  ]);

  const settledByDebt = (debt: (typeof debts)[number]): string =>
    debtSettledAmount(debt.settlements.map((s) => s.amount.toString())).toString();

  const events: DailyNotificationInsert[] = [
    ...plannedEvents(
      userId,
      todayISO,
      planned as unknown as PlannedCandidate[],
      options.pushAllowed,
      options.showAmounts,
    ),
    ...incomeEvents(
      userId,
      todayISO,
      incomes as unknown as IncomeCandidate[],
      options.pushAllowed,
      options.showAmounts,
    ),
    ...debtEvents(
      userId,
      todayISO,
      debts.map((debt) => ({
        id: debt.id,
        direction: debt.direction,
        kind: debt.kind,
        originalAmount: debt.originalAmount,
        currency: debt.currency,
        counterpartyName: debt.counterpartyName,
        dueDate: debt.dueDate,
        settled: settledByDebt(debt),
      })) as unknown as DebtCandidate[],
      options.pushAllowed,
      options.showAmounts,
    ),
  ];

  if (events.length === 0) {
    return 0;
  }
  const inserted = await prisma.appNotification.createMany({
    data: events.map((event) => ({
      userId: event.userId,
      type: event.type as never,
      sourceType: event.sourceType,
      sourceId: event.sourceId,
      localDate: event.localDate,
      dedupeKey: event.dedupeKey,
      title: event.title,
      body: event.body,
      route: event.route,
      pushBody: event.pushBody,
    })),
    skipDuplicates: true,
  });
  return inserted.count;
}

/** Abonnements ACTIFS (jamais désactivés) d'un utilisateur. */
async function activeSubscriptionsOf(userId: string): Promise<
  { id: string; endpoint: string; p256dh: string; auth: string }[]
> {
  return prisma.pushSubscription.findMany({
    where: { userId, disabledAt: null },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
}

/**
 * Étape 2 — envoi Web Push des notifications du jour (idempotent grâce à
 * l'UNIQUE(notificationId, pushSubscriptionId)). Une erreur de livraison ne
 * fait JAMAIS rollback d'une AppNotification ni d'une donnée financière.
 */
export async function deliverDailyPush(
  userId: string,
  todayISO: string,
): Promise<{ sent: number; failed: number; disabled: number }> {
  if (!isWebPushConfigured()) {
    return { sent: 0, failed: 0, disabled: 0 };
  }
  const notifications = await prisma.appNotification.findMany({
    where: { userId, localDate: dateInputToDate(todayISO), pushBody: { not: null } },
    select: { id: true, route: true, pushBody: true },
  });
  if (notifications.length === 0) {
    return { sent: 0, failed: 0, disabled: 0 };
  }
  const subscriptions = await activeSubscriptionsOf(userId);
  if (subscriptions.length === 0) {
    return { sent: 0, failed: 0, disabled: 0 };
  }

  let sent = 0;
  let failed = 0;
  let disabled = 0;
  for (const notification of notifications) {
    for (const subscription of subscriptions) {
      const outcome = await deliverOne(
        notification.id,
        notification.pushBody,
        notification.route,
        subscription,
      );
      if (outcome === 'sent') {
        sent += 1;
      } else if (outcome === 'failed') {
        failed += 1;
      } else if (outcome === 'disabled') {
        disabled += 1;
      }
    }
  }
  return { sent, failed, disabled };
}

type DeliveryOutcome = 'sent' | 'failed' | 'disabled' | 'skipped';

async function deliverOne(
  notificationId: string,
  pushBody: string | null,
  route: string,
  subscription: { id: string; endpoint: string; p256dh: string; auth: string },
): Promise<DeliveryOutcome> {
  const payload = { title: 'Finance', body: pushBody ?? '', route };

  // 1. Réserver la paire (UNIQUE au niveau base) → jamais deux envois.
  let row: {
    id: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  } | null = null;
  try {
    row = await prisma.pushNotificationDelivery.create({
      data: {
        notificationId,
        pushSubscriptionId: subscription.id,
        status: 'PENDING',
        payload,
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') {
      throw error;
    }
    row = await prisma.pushNotificationDelivery.findUniqueOrThrow({
      where: {
        notificationId_pushSubscriptionId: {
          notificationId,
          pushSubscriptionId: subscription.id,
        },
      },
    });
    if (row.status === 'SENT') {
      return 'skipped';
    }
    if (Date.now() - row.updatedAt.getTime() < STALE_PENDING_MS) {
      // Une autre passe est en train d'envoyer : on ne double pas.
      return 'skipped';
    }
    // Créateur disparu (crash) : on reprend l'envoi.
  }

  const result = await sendWebPush(
    {
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    },
    payload,
  );

  if (result.ok) {
    await prisma.pushNotificationDelivery.update({
      where: { id: row.id },
      data: { status: 'SENT', sentAt: new Date() },
    });
    return 'sent';
  }
  if (result.code === 'SUBSCRIPTION_GONE') {
    await prisma.pushSubscription.update({
      where: { id: subscription.id },
      data: { disabledAt: new Date() },
    });
    await prisma.pushNotificationDelivery.update({
      where: { id: row.id },
      data: { status: 'FAILED', failedAt: new Date(), lastErrorCode: 'SUBSCRIPTION_GONE' },
    });
    return 'disabled';
  }
  await prisma.pushNotificationDelivery.update({
    where: { id: row.id },
    data: { status: 'FAILED', failedAt: new Date(), lastErrorCode: result.code },
  });
  return 'failed';
}

/**
 * Passe de maintenance NOTIFICATIONS (cron + bootstrap).
 *
 * Idempotente et testable : `now` est injectable (les tests pilotent le jour
 * LOCAL des utilisateurs sans dépendre de l'heure réelle de la machine).
 */
export async function runNotificationMaintenance(
  now: Date | string = new Date(),
): Promise<NotificationMaintenanceSummary> {
  const instant = typeof now === 'string' ? new Date(now) : now;
  const prefs = await prisma.notificationPreference.findMany();

  const summary: NotificationMaintenanceSummary = {
    usersProcessed: 0,
    generated: 0,
    deliveriesSent: 0,
    deliveriesFailed: 0,
    subscriptionsDisabled: 0,
  };

  for (const pref of prefs) {
    if (!isValidTimeZone(pref.timezone)) {
      // Préférence invalide (normalement refusée à l'écriture) : on ignore.
      continue;
    }
    const localTime = zonedTimeHHMM(instant, pref.timezone);
    if (!isDailyWindowReached(localTime, pref.localTime)) {
      continue;
    }
    summary.usersProcessed += 1;
    const todayISO = zonedDateISO(instant, pref.timezone);
    const pushAllowed =
      pref.browserPushEnabled && isWebPushConfigured();

    summary.generated += await generateDailyNotificationsForUser(pref.userId, todayISO, {
      pushAllowed,
      showAmounts: pref.showAmountsInPush,
    });

    if (pushAllowed) {
      const result = await deliverDailyPush(pref.userId, todayISO);
      summary.deliveriesSent += result.sent;
      summary.deliveriesFailed += result.failed;
      summary.subscriptionsDisabled += result.disabled;
    }
  }

  return summary;
}



