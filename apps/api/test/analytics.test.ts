import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import {
  analyticsOverviewResponseSchema,
  type AnalyticsOverviewResponse,
} from '@finance/shared-types';

/**
 * ANALYTIQUE LECTURE-SEULE (dashboard) — GET /analytics/overview.
 *
 * Contrats couverts :
 *  - GET strictement read-only (aucune écriture, aucun changement de statut) ;
 *  - fenêtre = `months` mois terminant au mois de `today` (défaut 6), mois sans
 *    activité ramenés à zéro, ordre chronologique ;
 *  - seules les Transactions actives INCOME/EXPENSE avec date d'occurrence
 *    connue sont incluses (soft-deleted, sans date, hors fenêtre exclues) ;
 *  - `currentMonthExpenseCategories` = dépenses réelles du mois courant
 *    ventilées par catégorie (descendant, parts 0..1), l'inconnue distincte ;
 *  - ownership strict A/B et paramètres invalides → 400.
 */

const PASSWORD = 'correct-horse-battery-staple';
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** `2026-08-15` → Date UTC à MIDI (comme le stockage des transactions). */
function atNoon(date: string): Date {
  return new Date(`${date}T12:00:00.000Z`);
}

type RegisterResult = { token: string; id: string };

let userA: RegisterResult;
let userB: RegisterResult;
let categories: { id: string; name: string }[];

async function register(email: string): Promise<RegisterResult> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: PASSWORD });
  expect(res.status).toBe(201);
  return {
    token: res.body.accessToken as string,
    id: res.body.user.id as string,
  };
}

async function cleanDomain(): Promise<void> {
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

async function insertTx(
  userId: string,
  data: {
    type: 'INCOME' | 'EXPENSE';
    amount: string;
    occurredAt?: Date;
    categoryId?: string | null;
    categoryUnknown?: boolean;
    deletedAt?: Date | null;
  },
): Promise<void> {
  await prisma.transaction.create({
    data: {
      userId,
      type: data.type,
      amount: data.amount,
      occurredAt: data.occurredAt ?? null,
      categoryId: data.categoryId ?? null,
      categoryUnknown: data.categoryUnknown ?? false,
      deletedAt: data.deletedAt ?? null,
    },
  });
}

function getOverview(token: string, query = '') {
  return request(app).get(`/analytics/overview${query}`).set(auth(token));
}

beforeAll(async () => {
  await prisma.refreshSession.deleteMany();
  await cleanDomain();
  await prisma.user.deleteMany();
  userA = await register('analytics-a@example.com');
  userB = await register('analytics-b@example.com');
  categories = await prisma.category.findMany({
    where: { isSystem: true },
    orderBy: { code: 'asc' },
    select: { id: true, name: true },
  });
  if (categories.length < 2) {
    throw new Error('La base de test doit contenir les catégories système.');
  }
});

beforeEach(async () => {
  await cleanDomain();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const expectValid = (body: unknown): AnalyticsOverviewResponse => {
  const parsed = analyticsOverviewResponseSchema.safeParse(body);
  expect(parsed.success).toBe(true);
  return parsed.success ? parsed.data : (body as AnalyticsOverviewResponse);
};

describe('accès', () => {
  it('refuse les requêtes non authentifiées (401)', async () => {
    const res = await request(app).get('/analytics/overview');
    expect(res.status).toBe(401);
  });

  it('est strictement read-only (aucune écriture en base)', async () => {
    const countsBefore = {
      transactions: await prisma.transaction.count(),
      adjustments: await prisma.accountAdjustment.count(),
    };
    const res = await getOverview(userA.token, '?today=2026-09-20');
    expect(res.status).toBe(200);
    expect(await prisma.transaction.count()).toBe(countsBefore.transactions);
    expect(await prisma.accountAdjustment.count()).toBe(countsBefore.adjustments);
  });
});

describe('fenêtre mensuelle', () => {
  it('renvoie 6 mois à zéro pour un compte vide (axe stable)', async () => {
    const res = await getOverview(userB.token, '?today=2026-09-20');
    expect(res.status).toBe(200);
    const body = expectValid(res.body);
    expect(body.currency).toBe('MGA');
    expect(body.currentMonth).toBe('2026-09');
    expect(body.monthlyCashflow).toHaveLength(6);
    expect(body.monthlyCashflow.map((p) => p.month)).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
    for (const point of body.monthlyCashflow) {
      expect(point.income).toBe('0');
      expect(point.expense).toBe('0');
    }
    expect(body.currentMonthExpenseCategories).toEqual([]);
  });

  it('agrège revenus et dépenses par mois sur la fenêtre', async () => {
    await insertTx(userA.id, {
      type: 'INCOME',
      amount: '100000',
      occurredAt: atNoon('2026-05-10'),
    });
    await insertTx(userA.id, {
      type: 'EXPENSE',
      amount: '30000',
      occurredAt: atNoon('2026-05-22'),
    });
    await insertTx(userA.id, {
      type: 'INCOME',
      amount: '50000',
      occurredAt: atNoon('2026-09-01'),
    });
    await insertTx(userA.id, {
      type: 'EXPENSE',
      amount: '12500.50',
      occurredAt: atNoon('2026-08-15'),
    });

    const res = await getOverview(userA.token, '?today=2026-09-20');
    expect(res.status).toBe(200);
    const body = expectValid(res.body);
    const byMonth = new Map(body.monthlyCashflow.map((p) => [p.month, p]));
    expect(byMonth.get('2026-05')).toEqual({
      month: '2026-05',
      income: '100000',
      expense: '30000',
    });
    expect(byMonth.get('2026-08')).toEqual({
      month: '2026-08',
      income: '0',
      expense: '12500.5',
    });
    expect(byMonth.get('2026-09')).toEqual({
      month: '2026-09',
      income: '50000',
      expense: '0',
    });
    expect(byMonth.get('2026-04')).toEqual({
      month: '2026-04',
      income: '0',
      expense: '0',
    });
  });

  it('respecte le paramètre months (fenêtre courte et limites)', async () => {
    await insertTx(userA.id, {
      type: 'INCOME',
      amount: '1000',
      occurredAt: atNoon('2026-07-05'),
    });
    const one = await getOverview(userA.token, '?today=2026-09-20&months=1');
    expect(one.status).toBe(200);
    expect(expectValid(one.body).monthlyCashflow).toEqual([
      { month: '2026-09', income: '0', expense: '0' },
    ]);

    const zero = await getOverview(userA.token, '?today=2026-09-20&months=0');
    expect(zero.status).toBe(400);
    const thirteen = await getOverview(
      userA.token,
      '?today=2026-09-20&months=13',
    );
    expect(thirteen.status).toBe(400);
    const badDate = await getOverview(userA.token, '?today=2026-13-01');
    expect(badDate.status).toBe(400);
  });

  it('exclut les lignes hors inclusion (soft-deleted, sans date, hors fenêtre)', async () => {
    await insertTx(userA.id, {
      type: 'INCOME',
      amount: '999999',
      occurredAt: atNoon('2026-06-10'),
      deletedAt: new Date('2026-09-01T08:00:00.000Z'),
    });
    await insertTx(userA.id, {
      type: 'EXPENSE',
      amount: '888888',
    });
    await insertTx(userA.id, {
      type: 'INCOME',
      amount: '777777',
      occurredAt: atNoon('2026-03-31'), // avant la fenêtre (début 2026-04).
    });

    const res = await getOverview(userA.token, '?today=2026-09-20');
    expect(res.status).toBe(200);
    const body = expectValid(res.body);
    const totalIncome = body.monthlyCashflow.reduce(
      (sum, p) => sum + Number(p.income),
      0,
    );
    const totalExpense = body.monthlyCashflow.reduce(
      (sum, p) => sum + Number(p.expense),
      0,
    );
    expect(totalIncome).toBe(0);
    expect(totalExpense).toBe(0);
  });
});

describe('dépenses du mois courant par catégorie', () => {
  it('ventile par catégorie (descendant), part calculée et inconnue distincte', async () => {
    const food = categories[0]!;
    const transport = categories[1]!;

    await insertTx(userA.id, {
      type: 'EXPENSE',
      amount: '12000',
      categoryId: food.id,
      occurredAt: atNoon('2026-09-02'),
    });
    await insertTx(userA.id, {
      type: 'EXPENSE',
      amount: '8000',
      categoryId: food.id,
      occurredAt: atNoon('2026-09-09'),
    });
    await insertTx(userA.id, {
      type: 'EXPENSE',
      amount: '5000',
      categoryId: transport.id,
      occurredAt: atNoon('2026-09-15'),
    });
    await insertTx(userA.id, {
      type: 'EXPENSE',
      amount: '3000',
      categoryUnknown: true,
      occurredAt: atNoon('2026-09-18'),
    });
    // Revenu du mois courant : jamais dans les dépenses.
    await insertTx(userA.id, {
      type: 'INCOME',
      amount: '90000',
      occurredAt: atNoon('2026-09-01'),
    });
    // Mois précédent : hors ventilation du mois courant.
    await insertTx(userA.id, {
      type: 'EXPENSE',
      amount: '4000',
      categoryId: transport.id,
      occurredAt: atNoon('2026-08-20'),
    });

    const res = await getOverview(userA.token, '?today=2026-09-20');
    expect(res.status).toBe(200);
    const body = expectValid(res.body);
    expect(body.currentMonthExpenseCategories).toHaveLength(3);
    expect(body.currentMonthExpenseCategories.map((c) => c.label)).toEqual([
      food.name,
      transport.name,
      'Sans catégorie',
    ]);
    const foodLine = body.currentMonthExpenseCategories[0]!;
    const transportLine = body.currentMonthExpenseCategories[1]!;
    const unknownLine = body.currentMonthExpenseCategories[2]!;
    expect(foodLine.categoryId).toBe(food.id);
    expect(foodLine.amount).toBe('20000');
    expect(foodLine.share).toBeCloseTo(20000 / 28000, 6);
    expect(transportLine.amount).toBe('5000');
    expect(transportLine.share).toBeCloseTo(5000 / 28000, 6);
    expect(unknownLine.categoryId).toBeNull();
    expect(unknownLine.amount).toBe('3000');
    expect(unknownLine.share).toBeCloseTo(3000 / 28000, 6);
  });

  it('renvoie une liste vide lorsqu’il n’y a aucune dépense ce mois-ci', async () => {
    await insertTx(userA.id, {
      type: 'INCOME',
      amount: '50000',
      occurredAt: atNoon('2026-09-01'),
    });
    const res = await getOverview(userA.token, '?today=2026-09-20');
    expect(res.status).toBe(200);
    expect(expectValid(res.body).currentMonthExpenseCategories).toEqual([]);
  });
});

describe('ownership', () => {
  it('isole strictement les données entre utilisateurs', async () => {
    await insertTx(userA.id, {
      type: 'EXPENSE',
      amount: '42000',
      occurredAt: atNoon('2026-09-05'),
    });
    const resB = await getOverview(userB.token, '?today=2026-09-20');
    expect(resB.status).toBe(200);
    const body = expectValid(resB.body);
    expect(body.currentMonthExpenseCategories).toEqual([]);
    expect(
      body.monthlyCashflow.reduce((sum, p) => sum + Number(p.expense), 0),
    ).toBe(0);
  });
});
