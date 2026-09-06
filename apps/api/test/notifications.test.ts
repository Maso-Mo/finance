import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { dateInputToDate } from '../src/dates.js';
import {
  generateDailyNotificationsForUser,
  runNotificationMaintenance,
} from '../src/notifications/notification-scheduler.js';

/**
 * CENTRE DE NOTIFICATIONS + GÉNÉRATION (étape 12) — API.
 *
 * Contrats couverts :
 *  - une notification est INFORMATIVE : jamais d'écriture financière, jamais
 *    de changement de statut (dépense/revenu/dette restent intacts) ;
 *  - au maximum UNE notification par (utilisateur × source × type × jour
 *    LOCAL), garanti au niveau BASE (dedupeKey UNIQUE) — y compris en
 *    concurrence (2 passes simultanées → 1 notification) ;
 *  - le scheduler respecte le jour LOCAL de l'utilisateur (timezone IANA) et
 *    sa cadence quotidienne ;
 *  - GET strictement read-only ; PATCH/POST = mutations explicites (lu /
 *    read-all / préférences) ; ownership A/B strict.
 */

const PASSWORD = 'correct-horse-battery-staple';
const NOW = '2026-09-20T09:30:00.000Z'; // UTC : jour local 2026-09-20

let tokenA = '';
let tokenB = '';
let tokenC = '';
let userA = '';
let userC = '';

async function register(email: string): Promise<{ token: string; id: string }> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: PASSWORD });
  expect(res.status).toBe(201);
  return { token: res.body.accessToken as string, id: res.body.user.id as string };
}

async function cleanDomain(): Promise<void> {
  await prisma.pushNotificationDelivery.deleteMany();
  await prisma.appNotification.deleteMany();
  await prisma.notificationPreference.deleteMany();
  await prisma.pushSubscription.deleteMany();
  await prisma.debtSettlement.deleteMany();
  await prisma.debt.deleteMany();
  await prisma.savingsContribution.deleteMany();
  await prisma.monthlySavingsPlan.deleteMany();
  await prisma.accountTransfer.deleteMany();
  await prisma.transactionAccountAllocation.deleteMany();
  await prisma.accountAdjustment.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.expectedIncome.deleteMany();
  await prisma.plannedExpense.deleteMany();
  await prisma.recurringExpenseRule.deleteMany();
  await prisma.monthlyBudget.deleteMany();
}

beforeAll(async () => {
  await prisma.refreshSession.deleteMany();
  await cleanDomain();
  await prisma.user.deleteMany();
  const a = await register('notif-a@example.com');
  const b = await register('notif-b@example.com');
  const c = await register('notif-c@example.com');
  tokenA = a.token;
  tokenB = b.token;
  tokenC = c.token;
  userA = a.id;
  userC = c.id;
});

beforeEach(async () => {
  await cleanDomain();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const getNotifications = (token: string, query = '') =>
  request(app).get(`/notifications${query}`).set(auth(token));
const patchPref = (token: string, body: Record<string, unknown>) =>
  request(app).patch('/notification-preferences').set(auth(token)).send(body);

async function setPref(
  token: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await patchPref(token, {
    timezone: 'UTC',
    localTime: '00:00',
    ...body,
  });
  expect(res.status).toBe(200);
}

/** Insertions DIRECTES de sources (minimales, invariants DB respectés). */
function createPlanned(
  userId: string,
  dueDate: string,
  status: 'PENDING' | 'PAID' | 'CANCELED' | 'SKIPPED' = 'PENDING',
  extra: Record<string, unknown> = {},
) {
  return prisma.plannedExpense.create({
    data: {
      userId,
      amount: '50000',
      currency: 'MGA',
      dueDate: dateInputToDate(dueDate),
      categoryUnknown: true,
      status,
      ...extra,
    },
  });
}

function createIncome(
  userId: string,
  timing: { expectedDate?: string; windowStart?: string; windowEnd?: string },
  status: 'PENDING' | 'RECEIVED' | 'CANCELED' = 'PENDING',
) {
  return prisma.expectedIncome.create({
    data: {
      userId,
      amount: '120000',
      currency: 'MGA',
      certainty: 'CONFIRMED',
      status,
      expectedDate: timing.expectedDate
        ? dateInputToDate(timing.expectedDate)
        : null,
      windowStart: timing.windowStart
        ? dateInputToDate(timing.windowStart)
        : null,
      windowEnd: timing.windowEnd ? dateInputToDate(timing.windowEnd) : null,
    },
  });
}

function createDebt(
  userId: string,
  over: {
    direction: 'I_OWE' | 'OWED_TO_ME';
    kind?: 'STANDARD' | 'INCOME_ADVANCE_RECEIVABLE';
    originalAmount?: string;
    dueDate?: string | null;
  },
) {
  return prisma.debt.create({
    data: {
      userId,
      direction: over.direction,
      kind: over.kind ?? 'STANDARD',
      originalAmount: over.originalAmount ?? '100000',
      currency: 'MGA',
      dueDate: over.dueDate ? dateInputToDate(over.dueDate) : null,
      dueDateUnknown: over.dueDate == null,
    },
  });
}

async function notificationTypesOf(token: string): Promise<string[]> {
  const res = await getNotifications(token);
  expect(res.status).toBe(200);
  return (res.body.notifications as { type: string }[]).map((n) => n.type);
}

async function allNotifications(token: string): Promise<
  Record<string, unknown>[]
> {
  const res = await getNotifications(token, '?limit=100');
  expect(res.status).toBe(200);
  return res.body.notifications as Record<string, unknown>[];
}

// ------------------------------------------------------------- PLANNED ------

describe('PlannedExpense — rappels due / overdue', () => {
  it('1. PENDING due aujourd’hui → PLANNED_EXPENSE_DUE (une seule)', async () => {
    await setPref(tokenA, {});
    const planned = await createPlanned(userA, '2026-09-20');

    const summary = await runNotificationMaintenance(NOW);
    expect(summary.generated).toBe(1);

    const notifications = await allNotifications(tokenA);
    expect(notifications).toHaveLength(1);
    const item = notifications[0] as Record<string, unknown>;
    expect(item.type).toBe('PLANNED_EXPENSE_DUE');
    expect(item.sourceType).toBe('PLANNED_EXPENSE');
    expect(item.sourceId).toBe(planned.id);
    expect(item.localDate).toBe('2026-09-20');
    expect(item.route).toBe('/planned');
    expect(item.isRead).toBe(false);
    expect(String(item.title)).toMatch(/Paiement à vérifier/);
  });

  it('2. PENDING future → aucune notification due', async () => {
    await setPref(tokenA, {});
    await createPlanned(userA, '2026-09-25');
    const summary = await runNotificationMaintenance(NOW);
    expect(summary.generated).toBe(0);
    expect(await notificationTypesOf(tokenA)).toEqual([]);
  });

  it.each(['PAID', 'CANCELED', 'SKIPPED'] as const)(
    '3-5. status %s → aucune notification',
    async (status) => {
      await setPref(tokenA, {});
      await createPlanned(userA, '2026-09-20', status);
      const summary = await runNotificationMaintenance(NOW);
      expect(summary.generated).toBe(0);
      expect(await notificationTypesOf(tokenA)).toEqual([]);
    },
  );

  it('6. PENDING en retard → PLANNED_EXPENSE_OVERDUE', async () => {
    await setPref(tokenA, {});
    const planned = await createPlanned(userA, '2026-09-19');
    const summary = await runNotificationMaintenance(NOW);
    expect(summary.generated).toBe(1);
    const notifications = await allNotifications(tokenA);
    expect(notifications[0]?.type).toBe('PLANNED_EXPENSE_OVERDUE');
    expect(notifications[0]?.sourceId).toBe(planned.id);
    expect(String(notifications[0]?.title)).toMatch(/Paiement en retard/);
  });

  it('7. Overdue le lendemain → NOUVELLE notification du nouveau jour (max 1/jour)', async () => {
    await setPref(tokenA, {});
    const planned = await createPlanned(userA, '2026-09-19');

    await runNotificationMaintenance(NOW); // 20 : overdue localDate 09-20
    await runNotificationMaintenance('2026-09-21T09:30:00.000Z'); // 21

    const notifications = await allNotifications(tokenA);
    const mine = notifications.filter(
      (n) => n.sourceId === planned.id,
    ) as Record<string, unknown>[];
    expect(mine).toHaveLength(2);
    expect(mine.map((n) => n.localDate).sort()).toEqual([
      '2026-09-20',
      '2026-09-21',
    ]);
    expect(mine.every((n) => n.type === 'PLANNED_EXPENSE_OVERDUE')).toBe(true);
  });

  it('8. Plusieurs passages scheduler le même jour → aucun doublon', async () => {
    await setPref(tokenA, {});
    const planned = await createPlanned(userA, '2026-09-20');

    const first = await runNotificationMaintenance(NOW);
    expect(first.generated).toBe(1);
    for (let i = 0; i < 5; i += 1) {
      const summary = await runNotificationMaintenance(NOW);
      expect(summary.generated).toBe(0);
    }
    const notifications = await allNotifications(tokenA);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.sourceId).toBe(planned.id);
  });
});

// --------------------------------------------------------------- INCOME ------

describe('ExpectedIncome — rappels date exacte / plage', () => {
  it('9. date exacte aujourd’hui → EXPECTED_INCOME_DUE', async () => {
    await setPref(tokenA, {});
    const income = await createIncome(userA, { expectedDate: '2026-09-20' });
    const summary = await runNotificationMaintenance(NOW);
    expect(summary.generated).toBe(1);
    const notifications = await allNotifications(tokenA);
    expect(notifications[0]?.type).toBe('EXPECTED_INCOME_DUE');
    expect(notifications[0]?.sourceId).toBe(income.id);
    expect(notifications[0]?.route).toBe('/expected');
    expect(String(notifications[0]?.title)).toMatch(/Revenu attendu aujourd/);
  });

  it('10. date exacte passée → EXPECTED_INCOME_OVERDUE', async () => {
    await setPref(tokenA, {});
    const income = await createIncome(userA, { expectedDate: '2026-09-18' });
    await runNotificationMaintenance(NOW);
    const notifications = await allNotifications(tokenA);
    expect(notifications[0]?.type).toBe('EXPECTED_INCOME_OVERDUE');
    expect(notifications[0]?.sourceId).toBe(income.id);
  });

  it('11. plage avant début → AUCUNE notification de fenêtre', async () => {
    await setPref(tokenA, {});
    await createIncome(userA, {
      windowStart: '2026-09-23',
      windowEnd: '2026-09-27',
    });
    const summary = await runNotificationMaintenance(NOW);
    expect(summary.generated).toBe(0);
    expect(await notificationTypesOf(tokenA)).toEqual([]);
  });

  it('12. chaque jour de la plage → 1 rappel par jour local', async () => {
    await setPref(tokenA, {});
    const income = await createIncome(userA, {
      windowStart: '2026-09-20',
      windowEnd: '2026-09-27',
    });
    await runNotificationMaintenance('2026-09-20T09:30:00.000Z');
    await runNotificationMaintenance('2026-09-21T09:30:00.000Z');
    await runNotificationMaintenance('2026-09-22T09:30:00.000Z');

    const res = await getNotifications(tokenA, '?limit=100');
    const mine = (res.body.notifications as Record<string, unknown>[]).filter(
      (n) => n.sourceId === income.id,
    );
    expect(mine).toHaveLength(3);
    expect(mine.every((n) => n.type === 'EXPECTED_INCOME_WINDOW')).toBe(true);
    expect(mine.map((n) => n.localDate).sort()).toEqual([
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
    ]);
  });

  it('13. double run le même jour → une seule notification', async () => {
    await setPref(tokenA, {});
    const income = await createIncome(userA, {
      windowStart: '2026-09-20',
      windowEnd: '2026-09-27',
    });
    const s1 = await runNotificationMaintenance(NOW);
    const s2 = await runNotificationMaintenance(NOW);
    expect(s1.generated).toBe(1);
    expect(s2.generated).toBe(0);
    const res = await getNotifications(tokenA, '?limit=100');
    expect(
      (res.body.notifications as Record<string, unknown>[]).filter(
        (n) => n.sourceId === income.id,
      ),
    ).toHaveLength(1);
  });

  it('14. après la plage → EXPECTED_INCOME_OVERDUE', async () => {
    await setPref(tokenA, {});
    const income = await createIncome(userA, {
      windowStart: '2026-09-20',
      windowEnd: '2026-09-22',
    });
    await runNotificationMaintenance('2026-09-23T09:30:00.000Z');
    const notifications = await allNotifications(tokenA);
    expect(notifications[0]?.sourceId).toBe(income.id);
    expect(notifications[0]?.type).toBe('EXPECTED_INCOME_OVERDUE');
  });

  it.each(['RECEIVED', 'CANCELED'] as const)(
    '15-16. status %s → plus aucune nouvelle notification',
    async (status) => {
      await setPref(tokenA, {});
      const income = await createIncome(userA, { expectedDate: '2026-09-20' }, status);
      const summary = await runNotificationMaintenance(NOW);
      expect(summary.generated).toBe(0);
      expect(await notificationTypesOf(tokenA)).toEqual([]);
      expect(income.id).toBeTruthy();
    },
  );
});

// ---------------------------------------------------------------- DEBT ------

describe('Debt — rappels d’échéance (I_OWE / OWED_TO_ME / avance)', () => {
  it('17. I_OWE due aujourd’hui → DEBT_DUE « Remboursement à vérifier »', async () => {
    await setPref(tokenA, {});
    const debt = await createDebt(userA, { direction: 'I_OWE', dueDate: '2026-09-20' });
    await runNotificationMaintenance(NOW);
    const notifications = await allNotifications(tokenA);
    expect(notifications[0]?.type).toBe('DEBT_DUE');
    expect(notifications[0]?.sourceId).toBe(debt.id);
    expect(notifications[0]?.route).toBe('/debts');
    expect(String(notifications[0]?.title)).toBe('Remboursement à vérifier');
  });

  it('18. OWED_TO_ME due aujourd’hui → « Somme à recevoir à vérifier »', async () => {
    await setPref(tokenA, {});
    const debt = await createDebt(userA, { direction: 'OWED_TO_ME', dueDate: '2026-09-20' });
    await runNotificationMaintenance(NOW);
    const notifications = await allNotifications(tokenA);
    expect(notifications[0]?.sourceId).toBe(debt.id);
    expect(notifications[0]?.type).toBe('DEBT_DUE');
    expect(String(notifications[0]?.title)).toBe('Somme à recevoir à vérifier');
  });

  it('18bis. avance OWED_TO_ME → formulation dédiée', async () => {
    await setPref(tokenA, {});
    const debt = await createDebt(userA, {
      direction: 'OWED_TO_ME',
      kind: 'INCOME_ADVANCE_RECEIVABLE',
      originalAmount: '300000',
      dueDate: '2026-09-20',
    });
    await runNotificationMaintenance(NOW);
    const notifications = await allNotifications(tokenA);
    expect(notifications[0]?.sourceId).toBe(debt.id);
    expect(String(notifications[0]?.title)).toBe('Avance sur revenu à recevoir');
  });

  it('19. échéance passée → DEBT_OVERDUE', async () => {
    await setPref(tokenA, {});
    const debt = await createDebt(userA, { direction: 'I_OWE', dueDate: '2026-09-15' });
    await runNotificationMaintenance(NOW);
    const notifications = await allNotifications(tokenA);
    expect(notifications[0]?.sourceId).toBe(debt.id);
    expect(notifications[0]?.type).toBe('DEBT_OVERDUE');
  });

  it('20. dette soldée (remaining = 0) → aucune nouvelle notification', async () => {
    await setPref(tokenA, {});
    const debt = await createDebt(userA, { direction: 'I_OWE', dueDate: '2026-09-20' });
    await prisma.debtSettlement.create({
      data: {
        debtId: debt.id,
        userId: userA,
        amount: '100000',
        currency: 'MGA',
        accountUnknown: true,
        dateUnknown: true,
      },
    });
    const summary = await runNotificationMaintenance(NOW);
    expect(summary.generated).toBe(0);
    expect(await notificationTypesOf(tokenA)).toEqual([]);
  });

  it('21. échéance inconnue → aucune notification temporelle inventée', async () => {
    await setPref(tokenA, {});
    await createDebt(userA, { direction: 'I_OWE', dueDate: null });
    const summary = await runNotificationMaintenance(NOW);
    expect(summary.generated).toBe(0);
    expect(await notificationTypesOf(tokenA)).toEqual([]);
  });
});

// ------------------------------------------------------------- TIMEZONE ------

describe('Timezone / cadence — jour LOCAL de l’utilisateur', () => {
  const EVENING = '2026-09-20T21:30:00.000Z'; // Antananarivo = 09-21 00:30

  it('30. deux fuseaux → jours locaux différents pour le même instant', async () => {
    await setPref(tokenA, { timezone: 'UTC' }); // local 09-20 21:30
    await setPref(tokenC, { timezone: 'Indian/Antananarivo' }); // local 09-21 00:30
    // Dépense due le 20 UTC → due pour A ; due le 21 → due pour C.
    await createPlanned(userA, '2026-09-20');
    await createPlanned(userC, '2026-09-21');

    await runNotificationMaintenance(EVENING);

    const resA = await getNotifications(tokenA, '?limit=100');
    const resC = await getNotifications(tokenC, '?limit=100');
    const mineA = resA.body.notifications[0] as Record<string, unknown>;
    const mineC = resC.body.notifications[0] as Record<string, unknown>;
    expect(mineA.type).toBe('PLANNED_EXPENSE_DUE');
    expect(mineA.localDate).toBe('2026-09-20');
    expect(mineC.type).toBe('PLANNED_EXPENSE_DUE');
    expect(mineC.localDate).toBe('2026-09-21');
  });

  it('30bis. avant l’heure locale de cadence → rien n’est généré', async () => {
    await patchPref(tokenA, { timezone: 'UTC', localTime: '09:00' });
    await createPlanned(userA, '2026-09-20');
    // 08:00 UTC < 09:00 local.
    const summary = await runNotificationMaintenance('2026-09-20T08:00:00.000Z');
    expect(summary.usersProcessed).toBe(0);
    expect(await notificationTypesOf(tokenA)).toEqual([]);
  });

  it('31. timezone invalide → 400', async () => {
    const res = await patchPref(tokenA, { timezone: 'Mars/Olympus' });
    expect(res.status).toBe(400);
  });

  it('31bis. création sans timezone → 400', async () => {
    const res = await request(app)
      .patch('/notification-preferences')
      .set(auth(tokenA))
      .send({ browserPushEnabled: true });
    expect(res.status).toBe(400);
  });
});

// ------------------------------------------------------------ CONCURRENCE ------

describe('Déduplication stricte (contrainte DB)', () => {
  it('56. deux passes SIMULTANÉES → UNE notification', async () => {
    await setPref(tokenA, {});
    const planned = await createPlanned(userA, '2026-09-20');
    await createIncome(userA, { expectedDate: '2026-09-20' });
    const debt = await createDebt(userA, { direction: 'I_OWE', dueDate: '2026-09-20' });

    const [s1, s2] = await Promise.all([
      runNotificationMaintenance(NOW),
      runNotificationMaintenance(NOW),
    ]);
    // Les deux passes ont généré (createMany skipDuplicates) mais la base n'a
    // gardé qu'UNE ligne par clé.
    expect(s1.generated + s2.generated).toBeGreaterThanOrEqual(3);

    const res = await getNotifications(tokenA, '?limit=100');
    const notifications = res.body.notifications as Record<string, unknown>[];
    expect(notifications).toHaveLength(3);
    expect(
      notifications.filter((n) => n.sourceId === planned.id),
    ).toHaveLength(1);
    expect(
      notifications.filter((n) => n.sourceId === debt.id),
    ).toHaveLength(1);
  });

  it('la contrainte UNIQUE dedupeKey est réellement en base', async () => {
    await setPref(tokenA, {});
    const planned = await createPlanned(userA, '2026-09-20');
    await generateDailyNotificationsForUser(userA, '2026-09-20', {
      pushAllowed: false,
      showAmounts: false,
    });
    // Insérer la même clé en direct doit violer l'UNIQUE.
    await expect(
      prisma.appNotification.create({
        data: {
          userId: userA,
          type: 'PLANNED_EXPENSE_DUE',
          sourceType: 'PLANNED_EXPENSE',
          sourceId: planned.id,
          localDate: dateInputToDate('2026-09-20'),
          dedupeKey: `${userA}|PLANNED_EXPENSE|${planned.id}|PLANNED_EXPENSE_DUE|2026-09-20`,
          title: 'duplicata',
          body: 'duplicata',
          route: '/planned',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

// ----------------------------------------------------------- CENTRE API ------

describe('Centre interne — API lu / non lu / pagination / ownership', () => {
  async function seedNotification(extra: Record<string, unknown> = {}) {
    return prisma.appNotification.create({
      data: {
        userId: userA,
        type: 'PLANNED_EXPENSE_DUE',
        sourceType: 'PLANNED_EXPENSE',
        sourceId: '00000000-0000-4000-8000-0000000000aa',
        localDate: dateInputToDate('2026-09-20'),
        dedupeKey: `seed-${Math.random().toString(36).slice(2)}`,
        title: 'Paiement à vérifier',
        body: 'Dépense prévue …',
        route: '/planned',
        ...extra,
      },
    });
  }

  it('22. GET /notifications sans auth → 401', async () => {
    const res = await request(app).get('/notifications');
    expect(res.status).toBe(401);
  });

  it('23. isolation A/B : B ne voit/lit JAMAIS une notification de A', async () => {
    const note = await seedNotification();
    const resB = await getNotifications(tokenB, '?limit=100');
    expect(resB.body.notifications).toEqual([]);

    const mark = await request(app)
      .patch(`/notifications/${note.id}/read`)
      .set(auth(tokenB));
    expect(mark.status).toBe(404);

    const dbNote = await prisma.appNotification.findUniqueOrThrow({
      where: { id: note.id },
    });
    expect(dbNote.isRead).toBe(false);
  });

  it('24. pagination (limit=2) + 25. unreadOnly', async () => {
    await setPref(tokenA, {});
    // 5 notifications espacées dans le temps.
    for (let i = 0; i < 5; i += 1) {
      await seedNotification({
        createdAt: new Date(Date.parse('2026-09-20T00:00:00.000Z') + i * 1000),
      });
    }
    const page1 = await getNotifications(tokenA, '?page=1&limit=2');
    expect(page1.status).toBe(200);
    expect(page1.body.notifications).toHaveLength(2);
    expect(page1.body.total).toBe(5);
    expect(page1.body.page).toBe(1);
    expect(page1.body.unreadCount).toBe(5);

    const page3 = await getNotifications(tokenA, '?page=3&limit=2');
    expect(page3.body.notifications).toHaveLength(1);

    // Marquer les 2 premières lues puis filtrer unreadOnly.
    for (const note of page1.body.notifications) {
      await request(app)
        .patch(`/notifications/${note.id}/read`)
        .set(auth(tokenA));
    }
    const unread = await getNotifications(tokenA, '?unreadOnly=true&limit=10');
    expect(unread.body.notifications).toHaveLength(3);
    expect(unread.body.unreadCount).toBe(3);
  });

  it('26. mark read → isRead true, readAt posé', async () => {
    const note = await seedNotification();
    const res = await request(app)
      .patch(`/notifications/${note.id}/read`)
      .set(auth(tokenA));
    expect(res.status).toBe(200);
    expect(res.body.notification.isRead).toBe(true);
    expect(res.body.notification.readAt).toBeTruthy();
  });

  it('27. read-all → tout lu', async () => {
    await setPref(tokenA, {});
    const a = await seedNotification();
    const b = await seedNotification();
    const res = await request(app)
      .post('/notifications/read-all')
      .set(auth(tokenA));
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    const dbA = await prisma.appNotification.findUniqueOrThrow({ where: { id: a.id } });
    const dbB = await prisma.appNotification.findUniqueOrThrow({ where: { id: b.id } });
    expect(dbA.isRead).toBe(true);
    expect(dbB.isRead).toBe(true);
  });

  it('28. marquer lu ne modifie AUCUNE source financière', async () => {
    await setPref(tokenA, {});
    const planned = await createPlanned(userA, '2026-09-20');
    await runNotificationMaintenance(NOW);
    const notifications = await allNotifications(tokenA);
    expect(notifications).toHaveLength(1);

    await request(app)
      .patch(`/notifications/${(notifications[0] as { id: string }).id}/read`)
      .set(auth(tokenA));

    const source = await prisma.plannedExpense.findUniqueOrThrow({
      where: { id: planned.id },
    });
    expect(source.status).toBe('PENDING');
    expect(source.confirmedTransactionId).toBeNull();
  });

  it('29. GET répétés strictement read-only', async () => {
    await setPref(tokenA, {});
    await createPlanned(userA, '2026-09-20');
    await runNotificationMaintenance(NOW);

    const snapshot = async () => ({
      planned: await prisma.plannedExpense.count(),
      income: await prisma.expectedIncome.count(),
      debts: await prisma.debt.count(),
      transactions: await prisma.transaction.count(),
      transfers: await prisma.accountTransfer.count(),
      notifications: await prisma.appNotification.count(),
      deliveries: await prisma.pushNotificationDelivery.count(),
      updatedAt: (
        await prisma.plannedExpense.findFirstOrThrow()
      ).updatedAt.toISOString(),
    });

    const before = await snapshot();
    for (let i = 0; i < 3; i += 1) {
      await getNotifications(tokenA, '?limit=100');
      await getNotifications(tokenA, '?unreadOnly=true');
      await request(app).get('/notification-preferences').set(auth(tokenA));
      await request(app).get('/notifications/push-config').set(auth(tokenA));
      await request(app).get('/push-subscriptions').set(auth(tokenA));
    }
    const after = await snapshot();
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------- PRÉFÉRENCES / CONFIG ------

describe('Préférences & push-config', () => {
  it('GET par défaut : timezone null, centre toujours utilisable', async () => {
    const res = await request(app)
      .get('/notification-preferences')
      .set(auth(tokenA));
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBeNull();
    expect(res.body.browserPushEnabled).toBe(false);
    expect(res.body.showAmountsInPush).toBe(false);
    expect(res.body.localTime).toBe('09:00');
  });

  it('PATCH partiel sur une préférence existante (sans timezone) fonctionne', async () => {
    await setPref(tokenA, { timezone: 'UTC' });
    const res = await patchPref(tokenA, { showAmountsInPush: true });
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe('UTC');
    expect(res.body.showAmountsInPush).toBe(true);
    expect(res.body.browserPushEnabled).toBe(false);
  });

  it('GET push-config : jamais de secret, jamais la clé privée', async () => {
    const res = await request(app)
      .get('/notifications/push-config')
      .set(auth(tokenA));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['publicKey', 'pushAvailable']);
    expect(res.body.publicKey).toBeNull(); // aucun VAPID configuré en test
    expect(res.body.pushAvailable).toBe(false);
  });

  it('GET /push-subscriptions / GET préférences exigent l’authentification', async () => {
    expect((await request(app).get('/push-subscriptions')).status).toBe(401);
    expect((await request(app).get('/notification-preferences')).status).toBe(401);
    expect((await request(app).get('/notifications/push-config')).status).toBe(401);
  });
});

// --------------------------------------------------- ANTI-EFFET FINANCIER ------

describe('60. Le scheduler ne modifie JAMAIS l’argent ni les statuts', () => {
  it('multi-passes : seules les tables notifications changent', async () => {
    await setPref(tokenA, {});
    const planned = await createPlanned(userA, '2026-09-20');
    const income = await createIncome(userA, { expectedDate: '2026-09-20' });
    const debt = await createDebt(userA, { direction: 'I_OWE', dueDate: '2026-09-20' });

    const snapshotFinancial = async () => ({
      transactions: await prisma.transaction.count(),
      allocations: await prisma.transactionAccountAllocation.count(),
      adjustments: await prisma.accountAdjustment.count(),
      transfers: await prisma.accountTransfer.count(),
      settlements: await prisma.debtSettlement.count(),
      budgets: await prisma.monthlyBudget.count(),
      savings: await prisma.monthlySavingsPlan.count(),
      contributions: await prisma.savingsContribution.count(),
      plannedStatus: (
        await prisma.plannedExpense.findUniqueOrThrow({ where: { id: planned.id } })
      ).status,
      incomeStatus: (
        await prisma.expectedIncome.findUniqueOrThrow({ where: { id: income.id } })
      ).status,
      debtOriginal: (
        await prisma.debt.findUniqueOrThrow({ where: { id: debt.id } })
      ).originalAmount.toString(),
      plannedUpdatedAt: (
        await prisma.plannedExpense.findUniqueOrThrow({ where: { id: planned.id } })
      ).updatedAt.getTime(),
    });

    const accountsBefore = await request(app).get('/accounts').set(auth(tokenA));
    const before = await snapshotFinancial();
    expect(accountsBefore.body.totalAvailable).toBeDefined();

    for (let i = 0; i < 3; i += 1) {
      await runNotificationMaintenance(NOW);
    }

    const accountsAfter = await request(app).get('/accounts').set(auth(tokenA));
    expect(accountsAfter.body.totalAvailable).toBe(
      accountsBefore.body.totalAvailable,
    );
    expect(await snapshotFinancial()).toEqual(before);

    // 3 notifications générées (1 par source) — seules les tables
    // notifications/delivery ont pu changer.
    expect(await prisma.appNotification.count()).toBe(3);
  });
});






