import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { seedSystemCategories } from '../src/categories/seed.js';
import {
  monthlyBudgetMutationResponseSchema,
  monthlyBudgetsResponseSchema,
  type CategoryBudgetLine,
  type CategoryPublic,
  type MonthlyBudgetPublic,
  type MonthlyBudgetsResponse,
} from '@finance/shared-types';

const PASSWORD = 'correct-horse-battery-staple';
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';

type AccountIds = {
  cash: string;
  bank: string;
  mvola: string;
  savings: string;
};

let tokenA = '';
let tokenB = '';
let accountsA: AccountIds;
let categories = new Map<string, CategoryPublic>();

async function register(email: string): Promise<string> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: PASSWORD });
  expect(res.status).toBe(201);
  return res.body.accessToken as string;
}

async function idsOf(token: string): Promise<AccountIds> {
  const res = await request(app)
    .get('/accounts')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  const by = (type: string) =>
    (res.body.accounts as { type: string; id: string }[]).find(
      (a) => a.type === type,
    )!.id;
  return {
    cash: by('CASH'),
    bank: by('BANK'),
    mvola: by('MVOLA'),
    savings: by('SAVINGS'),
  };
}

async function loadCategories(
  token: string,
): Promise<Map<string, CategoryPublic>> {
  const res = await request(app)
    .get('/categories')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return new Map(
    (res.body.categories as CategoryPublic[]).map((c) => [c.code, c]),
  );
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function getBudgets(token: string, query = '') {
  return request(app).get(`/budgets${query}`).set(auth(token));
}

function postBudget(token: string, body: Record<string, unknown>) {
  return request(app).post('/budgets').set(auth(token)).send(body);
}

function patchBudget(token: string, id: string, body: Record<string, unknown>) {
  return request(app).patch(`/budgets/${id}`).set(auth(token)).send(body);
}

function deleteBudget(token: string, id: string) {
  return request(app).delete(`/budgets/${id}`).set(auth(token));
}

function postTx(token: string, body: Record<string, unknown>) {
  return request(app)
    .post('/transactions')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

function delTx(token: string, id: string) {
  return request(app)
    .delete(`/transactions/${id}`)
    .set('Authorization', `Bearer ${token}`);
}

function patchTx(token: string, id: string, body: Record<string, unknown>) {
  return request(app)
    .patch(`/transactions/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

async function getDashboard(token: string) {
  const res = await request(app).get('/accounts').set(auth(token));
  expect(res.status).toBe(200);
  return res.body as {
    currency: string;
    totalAvailable: string;
    accounts: { type: string; balance: string }[];
  };
}

function categoryId(code: string): string {
  return categories.get(code)!.id;
}

function budgetOf(body: unknown): MonthlyBudgetPublic {
  return monthlyBudgetMutationResponseSchema.parse(body).budget;
}

function overviewOf(body: unknown): MonthlyBudgetsResponse {
  return monthlyBudgetsResponseSchema.parse(body);
}

/** Ligne d'un budget catégorie attendue (le test échoue si absente). */
function firstCategoryLine(overview: MonthlyBudgetsResponse): CategoryBudgetLine {
  const line = overview.categoryBudgets[0];
  if (!line) {
    throw new Error('Expected a category budget line in the response.');
  }
  return line;
}

async function expenseOn(
  token: string,
  options: { amount: string; categoryId?: string; occurredAt: string },
) {
  const res = await postTx(token, {
    type: 'EXPENSE',
    amount: options.amount,
    occurredAt: options.occurredAt,
    categoryId: options.categoryId,
    allocations: [{ accountId: accountsA.cash, amount: options.amount }],
  });
  expect(res.status).toBe(201);
  return res.body.transaction as { id: string };
}

beforeAll(async () => {
  await prisma.monthlyBudget.deleteMany();
  await prisma.expectedIncome.deleteMany();
  await prisma.plannedExpense.deleteMany();
  await prisma.recurringExpenseRule.deleteMany();
  await prisma.debtSettlement.deleteMany();
  await prisma.debt.deleteMany();
  await prisma.transactionAccountAllocation.deleteMany();
  await prisma.accountAdjustment.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.accountTransfer.deleteMany();
  await prisma.user.deleteMany();
  await seedSystemCategories();

  tokenA = await register('budget-a@example.com');
  tokenB = await register('budget-b@example.com');
  accountsA = await idsOf(tokenA);
  categories = await loadCategories(tokenA);
});

beforeEach(async () => {
  await prisma.monthlyBudget.deleteMany();
  await prisma.expectedIncome.deleteMany();
  await prisma.plannedExpense.deleteMany();
  await prisma.recurringExpenseRule.deleteMany();
  await prisma.debtSettlement.deleteMany();
  await prisma.debt.deleteMany();
  await prisma.transactionAccountAllocation.deleteMany();
  await prisma.accountAdjustment.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.account.updateMany({ data: { initialBalance: '0' } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function expectNoSecrets(body: unknown): void {
  expect(JSON.stringify(body)).not.toContain('passwordHash');
}

describe('Sécurité & validation', () => {
  it('non authentifié → 401 (GET et mutations)', async () => {
    expect((await request(app).get('/budgets?month=2026-09')).status).toBe(401);
    expect(
      (await request(app).post('/budgets').send({ month: '2026-09', amount: '1000' }))
        .status,
    ).toBe(401);
  });

  it('GET sans month → 400 ; month invalide → 400', async () => {
    expect((await getBudgets(tokenA)).status).toBe(400);
    expect((await getBudgets(tokenA, '?month=2026-13')).status).toBe(400);
    expect((await getBudgets(tokenA, '?month=202609')).status).toBe(400);
  });

  it('POST : montant 0 / négatif / invalide → 400', async () => {
    expect((await postBudget(tokenA, { month: '2026-09', amount: '0' })).status).toBe(400);
    expect((await postBudget(tokenA, { month: '2026-09', amount: '-500' })).status).toBe(400);
    expect((await postBudget(tokenA, { month: '2026-09', amount: 'abc' })).status).toBe(400);
    expect((await postBudget(tokenA, { month: '2026-13', amount: '1000' })).status).toBe(400);
  });

  it('POST : catégorie non système / non UUID → 400', async () => {
    const badCategory = await postBudget(tokenA, {
      month: '2026-09',
      amount: '1000',
      categoryId: UNKNOWN_UUID,
    });
    expect(badCategory.status).toBe(400);
    const notUuid = await postBudget(tokenA, {
      month: '2026-09',
      amount: '1000',
      categoryId: 'not-a-uuid',
    });
    expect(notUuid.status).toBe(400);
  });

  it('PATCH : montant invalide refusé ; id inexistant → 404', async () => {
    const created = budgetOf((await postBudget(tokenA, { month: '2026-09', amount: '1000' })).body);
    expect((await patchBudget(tokenA, created.id, { amount: '-1' })).status).toBe(400);
    expect((await patchBudget(tokenA, created.id, { amount: '0' })).status).toBe(400);
    expect((await patchBudget(tokenA, UNKNOWN_UUID, { amount: '500' })).status).toBe(404);
  });
});

describe('Budget GLOBAL — CRUD, unicité, ownership', () => {
  it('crée un budget global du mois (catégorie null, devise utilisateur)', async () => {
    const res = await postBudget(tokenA, { month: '2026-09', amount: '1000000' });
    expect(res.status).toBe(201);
    const budget = budgetOf(res.body);
    expect(budget.month).toBe('2026-09');
    expect(budget.amount).toBe('1000000');
    expect(budget.currency).toBe('MGA');
    expect(budget.category).toBeNull();
    expectNoSecrets(res.body);
  });

  it('impossible d’avoir DEUX budgets globaux pour le même mois', async () => {
    const first = await postBudget(tokenA, { month: '2026-09', amount: '1000000' });
    expect(first.status).toBe(201);
    const dup = await postBudget(tokenA, { month: '2026-09', amount: '900000' });
    expect(dup.status).toBe(409);
  });

  it('un budget par mois différent est autorisé', async () => {
    expect((await postBudget(tokenA, { month: '2026-09', amount: '1000000' })).status).toBe(201);
    expect((await postBudget(tokenA, { month: '2026-10', amount: '800000' })).status).toBe(201);
  });

  it('PATCH modifie le montant ; DELETE supprime', async () => {
    const created = budgetOf((await postBudget(tokenA, { month: '2026-09', amount: '1000000' })).body);
    const patched = budgetOf((await patchBudget(tokenA, created.id, { amount: '1200000' })).body);
    expect(patched.amount).toBe('1200000');
    expect(patched.month).toBe('2026-09');
    const overview = overviewOf((await getBudgets(tokenA, '?month=2026-09')).body);
    expect(overview.globalBudget?.amount).toBe('1200000');
    expect((await deleteBudget(tokenA, created.id)).status).toBe(204);
    const afterDelete = overviewOf((await getBudgets(tokenA, '?month=2026-09')).body);
    expect(afterDelete.globalBudget).toBeNull();
  });

  it('ownership : A ne peut ni voir, ni modifier, ni supprimer les budgets de B', async () => {
    const createdB = budgetOf((await postBudget(tokenB, { month: '2026-09', amount: '1000000' })).body);
    const overviewA = overviewOf((await getBudgets(tokenA, '?month=2026-09')).body);
    expect(overviewA.globalBudget).toBeNull();
    expect(overviewA.categoryBudgets).toEqual([]);
    expect((await patchBudget(tokenA, createdB.id, { amount: '10' })).status).toBe(404);
    expect((await deleteBudget(tokenA, createdB.id)).status).toBe(404);
  });
});

describe('Budget par catégorie + montant dépensé DÉRIVÉ du journal', () => {
  it('scénario complet : dépensé 150 000 → VERT (budget 200 000)', async () => {
    const created = budgetOf(
      (
        await postBudget(tokenA, {
          month: '2026-09',
          amount: '200000',
          categoryId: categoryId('restaurant'),
        })
      ).body,
    );
    expect(created.category?.name).toBe('Restaurant');
    await expenseOn(tokenA, {
      amount: '150000',
      categoryId: categoryId('restaurant'),
      occurredAt: '2026-09-05',
    });

    const overview = overviewOf(
      (await getBudgets(tokenA, '?month=2026-09&today=2026-09-10')).body,
    );
    expect(overview.spent).toBe('150000');
    const line = firstCategoryLine(overview);
    expect(line.id).toBe(created.id);
    expect(line.amount).toBe('200000');
    expect(line.spent).toBe('150000');
    expect(line.remaining).toBe('50000');
    expect(line.status).toBe('VERT');
  });

  it('une dépense supplémentaire dépasse le budget → DÉPASSÉ (restant négatif)', async () => {
    await postBudget(tokenA, {
      month: '2026-09',
      amount: '200000',
      categoryId: categoryId('restaurant'),
    });
    await expenseOn(tokenA, {
      amount: '150000',
      categoryId: categoryId('restaurant'),
      occurredAt: '2026-09-05',
    });
    const second = await expenseOn(tokenA, {
      amount: '80000',
      categoryId: categoryId('restaurant'),
      occurredAt: '2026-09-12',
    });
    const overview = overviewOf(
      (await getBudgets(tokenA, '?month=2026-09&today=2026-09-20')).body,
    );
    const line = firstCategoryLine(overview);
    expect(line.spent).toBe('230000');
    expect(line.remaining).toBe('-30000');
    expect(line.status).toBe('DEPASSE');
    expect(overview.globalBudget).toBeNull();

    // Suppression LOGIQUE de la Transaction → le calcul redevient VERT.
    expect((await delTx(tokenA, second.id)).status).toBe(204);
    const afterDelete = overviewOf(
      (await getBudgets(tokenA, '?month=2026-09&today=2026-09-20')).body,
    );
    expect(firstCategoryLine(afterDelete).spent).toBe('150000');
    expect(firstCategoryLine(afterDelete).status).toBe('VERT');
  });

  it('changement de catégorie d’une Transaction → recalcul immédiat', async () => {
    await postBudget(tokenA, {
      month: '2026-09',
      amount: '200000',
      categoryId: categoryId('restaurant'),
    });
    const tx = await expenseOn(tokenA, {
      amount: '150000',
      categoryId: categoryId('restaurant'),
      occurredAt: '2026-09-05',
    });
    const patched = await patchTx(tokenA, tx.id, {
      type: 'EXPENSE',
      amount: '150000',
      occurredAt: '2026-09-05',
      categoryId: categoryId('transport'),
      allocations: [{ accountId: accountsA.cash, amount: '150000' }],
    });
    expect(patched.status).toBe(200);
    const overview = overviewOf(
      (await getBudgets(tokenA, '?month=2026-09&today=2026-09-10')).body,
    );
    expect(firstCategoryLine(overview).spent).toBe('0');
    expect(overview.spent).toBe('150000'); // le total du mois reste identique.
  });

  it('modification du montant / déplacement vers un autre mois → recalcul', async () => {
    await postBudget(tokenA, {
      month: '2026-09',
      amount: '200000',
      categoryId: categoryId('restaurant'),
    });
    const tx = await expenseOn(tokenA, {
      amount: '150000',
      categoryId: categoryId('restaurant'),
      occurredAt: '2026-09-05',
    });
    const patched = await patchTx(tokenA, tx.id, {
      type: 'EXPENSE',
      amount: '250000',
      occurredAt: '2026-09-05',
      categoryId: categoryId('restaurant'),
      allocations: [{ accountId: accountsA.cash, amount: '250000' }],
    });
    expect(patched.status).toBe(200);
    let overview = overviewOf((await getBudgets(tokenA, '?month=2026-09')).body);
    expect(firstCategoryLine(overview).spent).toBe('250000');
    expect(firstCategoryLine(overview).status).toBe('DEPASSE');
    const moved = await patchTx(tokenA, tx.id, {
      type: 'EXPENSE',
      amount: '250000',
      occurredAt: '2026-10-05',
      categoryId: categoryId('restaurant'),
      allocations: [{ accountId: accountsA.cash, amount: '250000' }],
    });
    expect(moved.status).toBe(200);
    overview = overviewOf((await getBudgets(tokenA, '?month=2026-09')).body);
    expect(overview.spent).toBe('0');
    const october = overviewOf((await getBudgets(tokenA, '?month=2026-10')).body);
    expect(october.spent).toBe('250000');
  });
});

describe('Budgets catégorie — cas limites du journal', () => {
  it('les revenus INCOME ne comptent jamais comme dépense', async () => {
    await postBudget(tokenA, {
      month: '2026-09',
      amount: '100000',
      categoryId: categoryId('restaurant'),
    });
    const incomeRes = await postTx(tokenA, {
      type: 'INCOME',
      amount: '5000000',
      occurredAt: '2026-09-08',
      allocations: [{ accountId: accountsA.cash, amount: '5000000' }],
    });
    expect(incomeRes.status).toBe(201);
    const overview = overviewOf((await getBudgets(tokenA, '?month=2026-09')).body);
    expect(overview.spent).toBe('0');
    expect(firstCategoryLine(overview).status).toBe('VERT');
  });

  it('dépense de catégorie INCONNUE : comptée dans le global, dans aucun budget catégorie', async () => {
    await postBudget(tokenA, { month: '2026-09', amount: '500000' });
    await postBudget(tokenA, {
      month: '2026-09',
      amount: '200000',
      categoryId: categoryId('restaurant'),
    });
    const res = await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '40000',
      occurredAt: '2026-09-03',
      categoryUnknown: true,
      allocations: [{ accountId: accountsA.cash, amount: '40000' }],
    });
    expect(res.status).toBe(201);
    const overview = overviewOf((await getBudgets(tokenA, '?month=2026-09')).body);
    expect(overview.spent).toBe('40000');
    expect(firstCategoryLine(overview).spent).toBe('0');
    expect(overview.globalBudget?.remaining).toBe('460000');
  });

  it('plusieurs budgets catégorie indépendants + unicité par (mois, catégorie)', async () => {
    expect(
      (await postBudget(tokenA, { month: '2026-09', amount: '1000000' })).status,
    ).toBe(201);
    expect(
      (
        await postBudget(tokenA, {
          month: '2026-09',
          amount: '200000',
          categoryId: categoryId('restaurant'),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await postBudget(tokenA, {
          month: '2026-09',
          amount: '150000',
          categoryId: categoryId('transport'),
        })
      ).status,
    ).toBe(201);
    const dup = await postBudget(tokenA, {
      month: '2026-09',
      amount: '90000',
      categoryId: categoryId('transport'),
    });
    expect(dup.status).toBe(409);
    // Même catégorie, mois différent → autorisé.
    expect(
      (
        await postBudget(tokenA, {
          month: '2026-10',
          amount: '150000',
          categoryId: categoryId('transport'),
        })
      ).status,
    ).toBe(201);
    const overview = overviewOf((await getBudgets(tokenA, '?month=2026-09')).body);
    expect(overview.categoryBudgets).toHaveLength(2);
  });

  it('isolation utilisateurs : B ne voit jamais les budgets de A', async () => {
    await postBudget(tokenA, { month: '2026-09', amount: '1000000' });
    await postBudget(tokenA, {
      month: '2026-09',
      amount: '200000',
      categoryId: categoryId('restaurant'),
    });
    const overviewB = overviewOf((await getBudgets(tokenB, '?month=2026-09')).body);
    expect(overviewB.spent).toBe('0');
    expect(overviewB.globalBudget).toBeNull();
    expect(overviewB.categoryBudgets).toEqual([]);
  });
});

describe('Prévision de fin de mois (today injecté)', () => {
  it('mois COURANT : moyenne quotidienne × jours du mois, déterministe', async () => {
    await postBudget(tokenA, { month: '2026-09', amount: '1000000' });
    await expenseOn(tokenA, {
      amount: '300000',
      categoryId: categoryId('restaurant'),
      occurredAt: '2026-09-10',
    });
    const day10 = overviewOf(
      (await getBudgets(tokenA, '?month=2026-09&today=2026-09-10')).body,
    );
    expect(day10.spent).toBe('300000');
    expect(day10.spendingForecast).toBe('900000'); // 300 000 / 10 × 30.
    expect(day10.globalBudget?.spendingForecast).toBe('900000');
    const day15 = overviewOf(
      (await getBudgets(tokenA, '?month=2026-09&today=2026-09-15')).body,
    );
    expect(day15.spendingForecast).toBe('600000'); // 300 000 / 15 × 30.
  });

  it('mois PASSÉ : la prévision vaut le total réel final', async () => {
    await expenseOn(tokenA, {
      amount: '120000',
      categoryId: categoryId('restaurant'),
      occurredAt: '2026-08-15',
    });
    const past = overviewOf(
      (await getBudgets(tokenA, '?month=2026-08&today=2026-09-10')).body,
    );
    expect(past.spent).toBe('120000');
    expect(past.spendingForecast).toBe('120000');
  });

  it('mois FUTUR : aucune dépense inventée (prévision 0)', async () => {
    await expenseOn(tokenA, {
      amount: '120000',
      categoryId: categoryId('restaurant'),
      occurredAt: '2026-08-15',
    });
    const future = overviewOf(
      (await getBudgets(tokenA, '?month=2026-11&today=2026-09-10')).body,
    );
    expect(future.spent).toBe('0');
    expect(future.spendingForecast).toBe('0');
  });

  it('today invalide → 400 (read-only, aucune donnée modifiée)', async () => {
    expect((await getBudgets(tokenA, '?month=2026-09&today=2026-13-01')).status).toBe(400);
  });
});

describe('Aucune modification du ledger par les budgets (non-régression)', () => {
  it('créer/modifier/supprimer des budgets ne touche ni comptes ni transactions', async () => {
    await expenseOn(tokenA, {
      amount: '50000',
      categoryId: categoryId('restaurant'),
      occurredAt: '2026-09-05',
    });
    const before = await getDashboard(tokenA);
    const txBefore = await request(app)
      .get('/transactions')
      .set(auth(tokenA));

    const created = budgetOf(
      (await postBudget(tokenA, { month: '2026-09', amount: '1000000' })).body,
    );
    await postBudget(tokenA, {
      month: '2026-09',
      amount: '200000',
      categoryId: categoryId('restaurant'),
    });
    await patchBudget(tokenA, created.id, { amount: '1200000' });
    expect((await deleteBudget(tokenA, created.id)).status).toBe(204);

    const after = await getDashboard(tokenA);
    const txAfter = await request(app)
      .get('/transactions')
      .set(auth(tokenA));
    expect(after.totalAvailable).toBe(before.totalAvailable);
    expect(after.accounts.map((a) => a.balance)).toEqual(
      before.accounts.map((a) => a.balance),
    );
    expect(txAfter.body.transactions).toHaveLength(txBefore.body.transactions.length);
  });

  it('le GET analytique est STRICTEMENT read-only (aucun budget créé)', async () => {
    const beforeCount = await prisma.monthlyBudget.count();
    for (let i = 0; i < 3; i += 1) {
      const res = await getBudgets(tokenA, '?month=2026-09&today=2026-09-10');
      expect(res.status).toBe(200);
    }
    const afterCount = await prisma.monthlyBudget.count();
    expect(afterCount).toBe(beforeCount);
  });

  it('les budgets n’affectent pas les ExpectedIncome PENDING', async () => {
    const incomeRes = await request(app)
      .post('/expected-incomes')
      .set(auth(tokenA))
      .send({ amount: '500000', certainty: 'CONFIRMED', expectedDate: '2026-09-15' });
    expect(incomeRes.status).toBe(201);
    const budgetRes = await postBudget(tokenA, { month: '2026-09', amount: '1000000' });
    expect(budgetRes.status).toBe(201);
    const incomes = await request(app)
      .get('/expected-incomes')
      .set(auth(tokenA));
    expect(incomes.body.expectedIncomes).toHaveLength(1);
    expect(incomes.body.expectedIncomes[0].status).toBe('PENDING');
    const dashboard = await getDashboard(tokenA);
    expect(dashboard.totalAvailable).toBe('0');
  });
});

describe('Devise & concurrence', () => {
  it('la devise du budget est celle de l’utilisateur au moment de la création', async () => {
    const prefs = await request(app)
      .patch('/me/preferences')
      .set(auth(tokenA))
      .send({ currency: 'EUR' });
    expect(prefs.status).toBe(204);
    const created = budgetOf(
      (await postBudget(tokenA, { month: '2026-09', amount: '1500.50' })).body,
    );
    expect(created.currency).toBe('EUR');
    // Conventions projet : sérialisation Decimal → chaîne sans zéros finaux.
    expect(created.amount).toBe('1500.5');
    // Retour à MGA pour les autres tests.
    await request(app)
      .patch('/me/preferences')
      .set(auth(tokenA))
      .send({ currency: 'MGA' });
  });

  it('concurrence : deux créations simultanées → exactement UN budget créé', async () => {
    const [first, second] = await Promise.all([
      postBudget(tokenA, {
        month: '2026-09',
        amount: '200000',
        categoryId: categoryId('restaurant'),
      }),
      postBudget(tokenA, {
        month: '2026-09',
        amount: '180000',
        categoryId: categoryId('restaurant'),
      }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
    const overview = overviewOf((await getBudgets(tokenA, '?month=2026-09')).body);
    expect(overview.categoryBudgets).toHaveLength(1);
  });
});
