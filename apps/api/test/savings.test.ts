import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { seedSystemCategories } from '../src/categories/seed.js';

/**
 * PLANS D'ÉPARGNE MENSUELS + CONTRIBUTIONS (étape 10) — API.
 * ⚠ Un plan d'épargne n'est JAMAIS de l'argent : il ne touche aucun solde.
 * Une contribution = AccountTransfer RÉEL vers SAVINGS lié ATOMIQUEMENT au
 * plan (jamais une Transaction EXPENSE/INCOME). La cible PERCENTAGE est
 * dérivée des revenus réellement reçus du mois.
 */

const PASSWORD = 'correct-horse-battery-staple';
const MONTH = '2026-09';
const OTHER_MONTH = '2026-08';

type AccountIds = {
  cash: string;
  bank: string;
  mvola: string;
  savings: string;
};

let tokenA = '';
let tokenB = '';
let accountsA: AccountIds;
let accountsB: AccountIds;

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

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const getSavings = (token: string, month = MONTH) =>
  request(app).get(`/savings-plans?month=${month}`).set(auth(token));
const postPlan = (token: string, body: Record<string, unknown>) =>
  request(app).post('/savings-plans').set(auth(token)).send(body);
const patchPlan = (token: string, id: string, body: Record<string, unknown>) =>
  request(app).patch(`/savings-plans/${id}`).set(auth(token)).send(body);
const deletePlan = (token: string, id: string) =>
  request(app).delete(`/savings-plans/${id}`).set(auth(token));
const postContribution = (
  token: string,
  planId: string,
  body: Record<string, unknown>,
) =>
  request(app)
    .post(`/savings-plans/${planId}/contributions`)
    .set(auth(token))
    .send(body);
const postTx = (token: string, body: Record<string, unknown>) =>
  request(app).post('/transactions').set(auth(token)).send(body);
const delTx = (token: string, id: string) =>
  request(app).delete(`/transactions/${id}`).set(auth(token));
const patchTransfer = (
  token: string,
  id: string,
  body: Record<string, unknown>,
) => request(app).patch(`/transfers/${id}`).set(auth(token)).send(body);
const delTransfer = (token: string, id: string) =>
  request(app).delete(`/transfers/${id}`).set(auth(token));
const postTransfer = (token: string, body: Record<string, unknown>) =>
  request(app).post('/transfers').set(auth(token)).send(body);

async function getAccount(token: string, type: string) {
  const res = await request(app)
    .get('/accounts')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return (
    res.body.accounts as {
      type: string;
      id: string;
      balance: string;
      initialBalance: string;
    }[]
  ).find((a) => a.type === type)!;
}

async function getDashboard(token: string) {
  const res = await request(app).get('/accounts').set(auth(token));
  expect(res.status).toBe(200);
  return res.body as { currency: string; totalAvailable: string };
}

/** Solde connu visé via l'API (aucun mouvement → initialBalance). */
async function fund(token: string, accountId: string, amount: string) {
  const res = await request(app)
    .patch(`/accounts/${accountId}`)
    .set(auth(token))
    .send({ targetBalance: amount });
  expect(res.status).toBe(200);
}

async function incomeOn(
  token: string,
  options: {
    amount: string;
    occurredAt?: string;
    dateUnknown?: boolean;
    accountId: string;
  },
) {
  const res = await postTx(token, {
    type: 'INCOME',
    amount: options.amount,
    occurredAt: options.occurredAt,
    dateUnknown: options.dateUnknown ?? false,
    allocations: [{ accountId: options.accountId, amount: options.amount }],
  });
  expect(res.status).toBe(201);
  return res.body.transaction as { id: string };
}

const fixedPlan = (overrides: Record<string, unknown> = {}) => ({
  month: MONTH,
  mode: 'FIXED',
  fixedAmount: '100000',
  ...overrides,
});
const percentPlan = (overrides: Record<string, unknown> = {}) => ({
  month: MONTH,
  mode: 'PERCENTAGE',
  percentage: '20',
  ...overrides,
});

beforeAll(async () => {
  await prisma.savingsContribution.deleteMany();
  await prisma.monthlySavingsPlan.deleteMany();
  await prisma.accountTransfer.deleteMany();
  await prisma.transactionAccountAllocation.deleteMany();
  await prisma.accountAdjustment.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.expectedIncome.deleteMany();
  await prisma.plannedExpense.deleteMany();
  await prisma.recurringExpenseRule.deleteMany();
  await prisma.user.deleteMany();
  await seedSystemCategories();

  tokenA = await register('savings-a@example.com');
  tokenB = await register('savings-b@example.com');
  accountsA = await idsOf(tokenA);
  accountsB = await idsOf(tokenB);
});

beforeEach(async () => {
  await prisma.savingsContribution.deleteMany();
  await prisma.monthlySavingsPlan.deleteMany();
  await prisma.accountTransfer.deleteMany();
  await prisma.transactionAccountAllocation.deleteMany();
  await prisma.accountAdjustment.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.expectedIncome.deleteMany();
  await prisma.plannedExpense.deleteMany();
  await prisma.recurringExpenseRule.deleteMany();
});

describe('savings plans — CRUD et validations', () => {
  it('1. GET sans authentification → 401', async () => {
    const res = await request(app).get('/savings-plans?month=2026-09');
    expect(res.status).toBe(401);
  });

  it('2. création FIXED → 201 avec cible fixée', async () => {
    const res = await postPlan(tokenA, fixedPlan());
    expect(res.status).toBe(201);
    expect(res.body.plan.month).toBe(MONTH);
    expect(res.body.plan.mode).toBe('FIXED');
    expect(res.body.plan.fixedAmount).toBe('100000');
    expect(res.body.plan.percentage).toBeNull();
  });

  it('3. création PERCENTAGE → 201', async () => {
    const res = await postPlan(tokenA, percentPlan());
    expect(res.status).toBe(201);
    expect(res.body.plan.mode).toBe('PERCENTAGE');
    expect(res.body.plan.percentage).toBe('20');
    expect(res.body.plan.fixedAmount).toBeNull();
  });

  it('4. doublon même mois refusé (409)', async () => {
    await postPlan(tokenA, fixedPlan());
    const res = await postPlan(tokenA, fixedPlan({ fixedAmount: '50000' }));
    expect(res.status).toBe(409);
  });

  it('5. création concurrente du même mois → une seule réussite', async () => {
    const [a, b] = await Promise.all([
      postPlan(tokenA, fixedPlan()),
      postPlan(tokenA, fixedPlan({ fixedAmount: '99999' })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
  });

  it('6. fixedAmount 0 ou négatif refusé (400)', async () => {
    expect((await postPlan(tokenA, fixedPlan({ fixedAmount: '0' }))).status).toBe(400);
    expect((await postPlan(tokenA, fixedPlan({ fixedAmount: '-5' }))).status).toBe(400);
  });

  it('7. percentage 0 ou > 100 refusé (400)', async () => {
    expect((await postPlan(tokenA, percentPlan({ percentage: '0' }))).status).toBe(400);
    expect((await postPlan(tokenA, percentPlan({ percentage: '101' }))).status).toBe(400);
  });

  it('8. payload incohérents (FIXED + percentage / PERCENTAGE + fixedAmount) → 400', async () => {
    const mixed1 = await postPlan(tokenA, { month: MONTH, mode: 'FIXED', fixedAmount: '1000', percentage: '10' });
    expect(mixed1.status).toBe(400);
    const mixed2 = await postPlan(tokenA, { month: MONTH, mode: 'PERCENTAGE', fixedAmount: '1000', percentage: '10' });
    expect(mixed2.status).toBe(400);
    expect((await postPlan(tokenA, fixedPlan({ month: '09-2026' }))).status).toBe(400);
  });

  it('9. vue GET du mois avec plan FIXED : cible/contribution dérivées', async () => {
    const created = await postPlan(tokenA, fixedPlan());
    expect(created.status).toBe(201);
    const res = await getSavings(tokenA);
    expect(res.status).toBe(200);
    expect(res.body.month).toBe(MONTH);
    expect(res.body.savingsAccount.balance).toBeDefined();
    expect(res.body.plan.id).toBe(created.body.plan.id);
    expect(res.body.target).toBe('100000');
    expect(res.body.contributed).toBe('0');
    expect(res.body.remaining).toBe('100000');
    expect(res.body.progress).toBe('IN_PROGRESS');
    expect(res.body.contributions).toEqual([]);
  });

  it('10. isolation : B ne voit pas le plan de A et ne peut ni le modifier ni le supprimer', async () => {
    const created = await postPlan(tokenA, fixedPlan());
    const viewB = await getSavings(tokenB);
    expect(viewB.status).toBe(200);
    expect(viewB.body.plan).toBeNull();

    const patchB = await patchPlan(tokenB, created.body.plan.id, fixedPlan({ fixedAmount: '1' }));
    expect(patchB.status).toBe(404);
    const delB = await deletePlan(tokenB, created.body.plan.id);
    expect(delB.status).toBe(404);
  });

  it('11. modification FIXED → la cible change, aucun Transfer n’est créé', async () => {
    const created = await postPlan(tokenA, fixedPlan());
    const before = await prisma.accountTransfer.count();
    const res = await patchPlan(tokenA, created.body.plan.id, fixedPlan({ fixedAmount: '60000' }));
    expect(res.status).toBe(200);
    expect(res.body.plan.fixedAmount).toBe('60000');
    expect(await prisma.accountTransfer.count()).toBe(before);

    const view = await getSavings(tokenA);
    expect(view.body.target).toBe('60000');
    expect(view.body.contributed).toBe('0');
  });

  it('12. modification : changer le mois est refusé (400)', async () => {
    const created = await postPlan(tokenA, fixedPlan());
    const res = await patchPlan(tokenA, created.body.plan.id, fixedPlan({ month: OTHER_MONTH }));
    expect(res.status).toBe(400);
  });

  it('13. suppression logique : plan absent de la vue, aucun Transfer supprimé', async () => {
    const created = await postPlan(tokenA, fixedPlan());
    const del = await deletePlan(tokenA, created.body.plan.id);
    expect(del.status).toBe(204);
    const view = await getSavings(tokenA);
    expect(view.body.plan).toBeNull();
    const delAgain = await deletePlan(tokenA, created.body.plan.id);
    expect(delAgain.status).toBe(404);
  });

  it('14. un plan supprimé ne peut plus être modifié (409)', async () => {
    const created = await postPlan(tokenA, fixedPlan());
    await deletePlan(tokenA, created.body.plan.id);
    const res = await patchPlan(tokenA, created.body.plan.id, fixedPlan({ fixedAmount: '1' }));
    expect(res.status).toBe(409);
  });

  it('15. plan seul → AUCUN impact sur les soldes ni le Total disponible', async () => {
    await fund(tokenA, accountsA.cash, '200000');
    const before = await getDashboard(tokenA);
    await postPlan(tokenA, fixedPlan({ fixedAmount: '500000' }));
    const after = await getDashboard(tokenA);
    expect(after.totalAvailable).toBe(before.totalAvailable);
    expect(await getAccount(tokenA, 'SAVINGS')).toMatchObject({ balance: '0' });
  });
});

describe('savings plans — cible PERCENTAGE (revenus réellement reçus)', () => {
  it('16. 20 % de 500 000 → cible 100 000', async () => {
    await fund(tokenA, accountsA.cash, '200000');
    await incomeOn(tokenA, { amount: '500000', occurredAt: '2026-09-10', accountId: accountsA.cash });
    await postPlan(tokenA, percentPlan());
    const view = await getSavings(tokenA);
    expect(view.body.eligibleIncome).toBe('500000');
    expect(view.body.target).toBe('100000');
    expect(view.body.progress).toBe('IN_PROGRESS');
  });

  it('17. plusieurs revenus additionnés (800 000 → 160 000)', async () => {
    await fund(tokenA, accountsA.cash, '200000');
    await incomeOn(tokenA, { amount: '500000', occurredAt: '2026-09-05', accountId: accountsA.cash });
    await incomeOn(tokenA, { amount: '300000', occurredAt: '2026-09-12', accountId: accountsA.cash });
    await postPlan(tokenA, percentPlan());
    const view = await getSavings(tokenA);
    expect(view.body.eligibleIncome).toBe('800000');
    expect(view.body.target).toBe('160000');
  });

  it('18. aucun revenu → cible 0 et statut NO_INCOME_YET', async () => {
    await postPlan(tokenA, percentPlan());
    const view = await getSavings(tokenA);
    expect(view.body.eligibleIncome).toBe('0');
    expect(view.body.target).toBe('0');
    expect(view.body.progress).toBe('NO_INCOME_YET');
  });

  it('19. revenus d’un autre mois exclus ; date inconnue exclue', async () => {
    await fund(tokenA, accountsA.cash, '200000');
    await incomeOn(tokenA, { amount: '900000', occurredAt: '2026-08-31', accountId: accountsA.cash });
    await incomeOn(tokenA, { amount: '700000', dateUnknown: true, accountId: accountsA.cash });
    await postPlan(tokenA, percentPlan());
    const view = await getSavings(tokenA);
    expect(view.body.eligibleIncome).toBe('0');
    expect(view.body.target).toBe('0');
  });

  it('20. revenu soft-deleted exclu ; EXPENSE exclue', async () => {
    await fund(tokenA, accountsA.cash, '200000');
    const inc = await incomeOn(tokenA, { amount: '500000', occurredAt: '2026-09-10', accountId: accountsA.cash });
    const expense = await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '50000',
      occurredAt: '2026-09-11',
      categoryUnknown: true,
      allocations: [{ accountId: accountsA.cash, amount: '50000' }],
    });
    expect(expense.status).toBe(201);
    await postPlan(tokenA, percentPlan());
    let view = await getSavings(tokenA);
    expect(view.body.eligibleIncome).toBe('500000');
    expect(view.body.target).toBe('100000');

    await delTx(tokenA, inc.id);
    view = await getSavings(tokenA);
    expect(view.body.eligibleIncome).toBe('0');
    expect(view.body.target).toBe('0');
  });

  it('21. la cible PERCENTAGE se recalcule après modification du revenu réel', async () => {
    await fund(tokenA, accountsA.cash, '200000');
    const inc = await incomeOn(tokenA, { amount: '500000', occurredAt: '2026-09-10', accountId: accountsA.cash });
    await postPlan(tokenA, percentPlan());
    let view = await getSavings(tokenA);
    expect(view.body.target).toBe('100000');

    const updated = await request(app)
      .patch(`/transactions/${inc.id}`)
      .set(auth(tokenA))
      .send({
        type: 'INCOME',
        amount: '1000000',
        occurredAt: '2026-09-10',
        allocations: [{ accountId: accountsA.cash, amount: '1000000' }],
      });
    expect(updated.status).toBe(200);
    view = await getSavings(tokenA);
    expect(view.body.eligibleIncome).toBe('1000000');
    expect(view.body.target).toBe('200000');
  });

  it('22. ExpectedIncome CONFIRMED PENDING n’entre jamais dans la cible', async () => {
    await fund(tokenA, accountsA.cash, '200000');
    const exp = await request(app)
      .post('/expected-incomes')
      .set(auth(tokenA))
      .send({ amount: '5000000', certainty: 'CONFIRMED', expectedDate: '2026-09-15' });
    expect(exp.status).toBe(201);
    await postPlan(tokenA, percentPlan());
    const view = await getSavings(tokenA);
    expect(view.body.eligibleIncome).toBe('0');
    expect(view.body.target).toBe('0');
  });
});

describe('contributions — AccountTransfer réel vers SAVINGS', () => {
  it('23. contribution 40k (frais 1k) : Cash −41k, Épargne +40k, contributed 40k', async () => {
    await fund(tokenA, accountsA.cash, '200000');
    const plan = await postPlan(tokenA, fixedPlan());
    const beforeTx = await prisma.transaction.count();

    const res = await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsA.cash,
      amount: '40000',
      feeAmount: '1000',
      occurredAt: '2026-09-06',
    });
    expect(res.status).toBe(201);
    expect(res.body.contribution.transfer.amount).toBe('40000');
    expect(res.body.contribution.transfer.destination.type).toBe('SAVINGS');

    expect((await getAccount(tokenA, 'CASH')).balance).toBe('159000');
    expect((await getAccount(tokenA, 'SAVINGS')).balance).toBe('40000');

    const view = await getSavings(tokenA);
    expect(view.body.contributed).toBe('40000');
    expect(view.body.remaining).toBe('60000');
    expect(view.body.progress).toBe('IN_PROGRESS');
    expect(view.body.contributions).toHaveLength(1);
    // Les frais ne sont PAS comptés dans la contribution au plan.
    expect(view.body.contributions[0].transfer.feeAmount).toBe('1000');

    // Aucune Transaction EXPENSE/INCOME créée.
    expect(await prisma.transaction.count()).toBe(beforeTx);
  });

  it('24. plusieurs contributions partielles → 100k, puis dépassement autorisé', async () => {
    await fund(tokenA, accountsA.cash, '500000');
    const plan = await postPlan(tokenA, fixedPlan());
    const c1 = await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsA.cash, amount: '40000', occurredAt: '2026-09-06',
    });
    expect(c1.status).toBe(201);
    const c2 = await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsA.cash, amount: '60000', occurredAt: '2026-09-15',
    });
    expect(c2.status).toBe(201);

    let view = await getSavings(tokenA);
    expect(view.body.contributed).toBe('100000');
    expect(view.body.remaining).toBe('0');
    expect(view.body.progress).toBe('REACHED');
    expect(view.body.contributions).toHaveLength(2);

    // Dépassement de l'objectif : autorisé, remaining devient négatif.
    const c3 = await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsA.cash, amount: '30000', occurredAt: '2026-09-20',
    });
    expect(c3.status).toBe(201);
    view = await getSavings(tokenA);
    expect(view.body.contributed).toBe('130000');
    expect(view.body.remaining).toBe('-30000');
    expect(view.body.progress).toBe('REACHED');
  });

  it('25. contribution sans frais → Total disponible −montant (Cash → Épargne)', async () => {
    await fund(tokenA, accountsA.cash, '500000');
    const before = await getDashboard(tokenA);
    const plan = await postPlan(tokenA, fixedPlan());
    const res = await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsA.cash, amount: '100000', occurredAt: '2026-09-06',
    });
    expect(res.status).toBe(201);
    const after = await getDashboard(tokenA);
    expect(Number(after.totalAvailable) - Number(before.totalAvailable)).toBe(-100000);
  });

  it('26. compte source d’un autre utilisateur refusé (404 générique)', async () => {
    const plan = await postPlan(tokenA, fixedPlan());
    const res = await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsB.cash, amount: '10000', occurredAt: '2026-09-06',
    });
    expect(res.status).toBe(404);
  });

  it('27. source = Épargne refusée (400) ; plan d’un autre utilisateur refusé (404)', async () => {
    const plan = await postPlan(tokenA, fixedPlan());
    const res = await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsA.savings, amount: '10000', occurredAt: '2026-09-06',
    });
    expect(res.status).toBe(400);

    const planB = await postPlan(tokenB, fixedPlan());
    const res2 = await postContribution(tokenA, planB.body.plan.id, {
      sourceAccountId: accountsA.cash, amount: '10000', occurredAt: '2026-09-06',
    });
    expect(res2.status).toBe(404);
  });

  it('28. contribution vers un plan supprimé refusée', async () => {
    const plan = await postPlan(tokenA, fixedPlan());
    await deletePlan(tokenA, plan.body.plan.id);
    const res = await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsA.cash, amount: '10000', occurredAt: '2026-09-06',
    });
    expect(res.status).toBe(404);
  });

  it('29. montant invalide / date ambiguë refusés', async () => {
    const plan = await postPlan(tokenA, fixedPlan());
    expect((await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsA.cash, amount: '0', occurredAt: '2026-09-06',
    })).status).toBe(400);
    expect((await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsA.cash, amount: '1000',
    })).status).toBe(400);
    expect((await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsA.cash, amount: '1000', occurredAt: '2026-09-06', dateUnknown: true,
    })).status).toBe(400);
  });

  it('30. date réellement inconnue acceptée (dateUnknown)', async () => {
    await fund(tokenA, accountsA.cash, '200000');
    const plan = await postPlan(tokenA, fixedPlan());
    const res = await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsA.cash, amount: '25000', dateUnknown: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.contribution.transfer.occurredAt).toBeNull();
    expect(res.body.contribution.transfer.dateUnknown).toBe(true);
    expect((await getAccount(tokenA, 'SAVINGS')).balance).toBe('25000');
  });

  it('31. un Transfer vers Épargne fait hors plan : solde augmente mais contributed inchangé', async () => {
    await fund(tokenA, accountsA.cash, '300000');
    const plan = await postPlan(tokenA, fixedPlan());
    // Contribution liée 40k
    await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsA.cash, amount: '40000', occurredAt: '2026-09-06',
    });
    // Transfer direct hors plan 100k vers Épargne (page transferts)
    const t = await postTransfer(tokenA, {
      sourceAccountId: accountsA.bank, destinationAccountId: accountsA.savings,
      amount: '100000', feeAmount: '0', occurredAt: '2026-09-10',
    });
    expect(t.status).toBe(201);

    const view = await getSavings(tokenA);
    expect(view.body.contributed).toBe('40000');
    expect(view.body.contributions).toHaveLength(1);
    expect((await getAccount(tokenA, 'SAVINGS')).balance).toBe('140000');
  });
});

describe('modification / suppression d’un Transfer lié à un plan', () => {
  it('32. PATCH du montant d’une contribution recalcule la progression', async () => {
    await fund(tokenA, accountsA.cash, '500000');
    const plan = await postPlan(tokenA, fixedPlan());
    const c = await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsA.cash, amount: '40000', feeAmount: '1000', occurredAt: '2026-09-06',
    });
    const transferId = c.body.contribution.transfer.id;

    const res = await patchTransfer(tokenA, transferId, {
      sourceAccountId: accountsA.cash, destinationAccountId: accountsA.savings,
      amount: '60000', feeAmount: '1000', occurredAt: '2026-09-06',
    });
    expect(res.status).toBe(200);
    const view = await getSavings(tokenA);
    expect(view.body.contributed).toBe('60000');
    expect(view.body.remaining).toBe('40000');
    expect((await getAccount(tokenA, 'SAVINGS')).balance).toBe('60000');
  });

  it('33. changer la destination d’un transfert lié → 409 (verrou SAVINGS)', async () => {
    const plan = await postPlan(tokenA, fixedPlan());
    const c = await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsA.cash, amount: '40000', occurredAt: '2026-09-06',
    });
    const transferId = c.body.contribution.transfer.id;
    const res = await patchTransfer(tokenA, transferId, {
      sourceAccountId: accountsA.cash, destinationAccountId: accountsA.bank,
      amount: '40000', feeAmount: '0', occurredAt: '2026-09-06',
    });
    expect(res.status).toBe(409);
  });

  it('34. changer la source est autorisé si ownership valide (même destination)', async () => {
    await fund(tokenA, accountsA.cash, '100000');
    const plan = await postPlan(tokenA, fixedPlan());
    const c = await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsA.cash, amount: '40000', occurredAt: '2026-09-06',
    });
    const transferId = c.body.contribution.transfer.id;
    const res = await patchTransfer(tokenA, transferId, {
      sourceAccountId: accountsA.mvola, destinationAccountId: accountsA.savings,
      amount: '40000', feeAmount: '0', occurredAt: '2026-09-06',
    });
    expect(res.status).toBe(200);
    expect(res.body.transfer.source.type).toBe('MVOLA');
    const view = await getSavings(tokenA);
    expect(view.body.contributed).toBe('40000');
  });

  it('35. soft-delete du Transfer lié → contributed diminue, solde Épargne restauré, plan intact', async () => {
    await fund(tokenA, accountsA.cash, '300000');
    const plan = await postPlan(tokenA, fixedPlan());
    const c1 = await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsA.cash, amount: '40000', occurredAt: '2026-09-06',
    });
    const c2 = await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsA.cash, amount: '60000', occurredAt: '2026-09-10',
    });
    expect((await getAccount(tokenA, 'SAVINGS')).balance).toBe('100000');

    await delTransfer(tokenA, c1.body.contribution.transfer.id);
    const view = await getSavings(tokenA);
    expect(view.body.contributed).toBe('60000');
    expect(view.body.contributions).toHaveLength(1);
    expect(view.body.plan.id).toBe(plan.body.plan.id);
    expect((await getAccount(tokenA, 'SAVINGS')).balance).toBe('60000');
    void c2;
  });

  it('36. ExpectedIncome RECEIVED compte UNIQUEMENT via sa vraie Transaction INCOME', async () => {
    await fund(tokenA, accountsA.cash, '300000');
    // Revenu reçu via le flux normal : crée une vraie Transaction INCOME.
    const exp = await request(app)
      .post('/expected-incomes')
      .set(auth(tokenA))
      .send({ amount: '500000', certainty: 'CONFIRMED', expectedDate: '2026-09-15' });
    expect(exp.status).toBe(201);
    const confirm = await request(app)
      .post(`/expected-incomes/${exp.body.expectedIncome.id}/confirm-received`)
      .set(auth(tokenA))
      .send({
        amount: '500000',
        occurredAt: '2026-09-16',
        allocations: [{ accountId: accountsA.cash, amount: '500000' }],
      });
    expect(confirm.status).toBe(201);

    await postPlan(tokenA, percentPlan());
    const view = await getSavings(tokenA);
    expect(view.body.eligibleIncome).toBe('500000');
    expect(view.body.target).toBe('100000');
  });

  it('37. GET strictement read-only : aucune écriture, updatedAt stable', async () => {
    const plan = await postPlan(tokenA, fixedPlan());
    const beforeTransfers = await prisma.accountTransfer.count();
    const beforeContrib = await prisma.savingsContribution.count();
    const beforePlan = await prisma.monthlySavingsPlan.findFirstOrThrow({ where: { id: plan.body.plan.id } });

    for (let i = 0; i < 3; i++) {
      await getSavings(tokenA);
    }

    const afterPlan = await prisma.monthlySavingsPlan.findFirstOrThrow({ where: { id: plan.body.plan.id } });
    expect(afterPlan.updatedAt.getTime()).toBe(beforePlan.updatedAt.getTime());
    expect(await prisma.accountTransfer.count()).toBe(beforeTransfers);
    expect(await prisma.savingsContribution.count()).toBe(beforeContrib);
  });
});

describe('épargne vs budgets / forecast (absence de pollution)', () => {
  async function getForecast(token: string) {
    const res = await request(app)
      .get('/forecast?today=2026-09-20')
      .set(auth(token));
    expect(res.status).toBe(200);
    return res.body as {
      availableToday: string;
      monthEndAvailableForecast: string;
    };
  }

  it('38. un transfert vers Épargne n’est jamais une dépense : spent et budgets inchangés', async () => {
    await fund(tokenA, accountsA.cash, '500000');
    // Budget global 1 000 000 pour septembre (aucune dépense réelle).
    const budget = await request(app)
      .post('/budgets')
      .set(auth(tokenA))
      .send({ month: MONTH, amount: '1000000' });
    expect(budget.status).toBe(201);

    const plan = await postPlan(tokenA, fixedPlan());
    await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsA.cash, amount: '100000', feeAmount: '2000', occurredAt: '2026-09-06',
    });

    const budgets = await request(app)
      .get(`/budgets?month=${MONTH}&today=2026-09-20`)
      .set(auth(tokenA));
    expect(budgets.status).toBe(200);
    expect(budgets.body.spent).toBe('0');
    expect(budgets.body.spendingForecast).toBe('0');
    expect(budgets.body.globalBudget.status).toBe('VERT');
  });

  it('39. le forecast financier ne change QUE via availableToday (disponible → Épargne)', async () => {
    await fund(tokenA, accountsA.cash, '300000');
    const before = await getForecast(tokenA);
    const plan = await postPlan(tokenA, fixedPlan());
    const res = await postContribution(tokenA, plan.body.plan.id, {
      sourceAccountId: accountsA.cash, amount: '100000', feeAmount: '2500', occurredAt: '2026-09-06',
    });
    expect(res.status).toBe(201);
    const after = await getForecast(tokenA);
    expect(Number(after.availableToday) - Number(before.availableToday)).toBe(-102500);
    expect(Number(after.monthEndAvailableForecast) - Number(before.monthEndAvailableForecast)).toBe(-102500);
  });

  it('40. un plan seul ne modifie jamais le forecast', async () => {
    const before = await getForecast(tokenA);
    await postPlan(tokenA, fixedPlan({ fixedAmount: '999999' }));
    const after = await getForecast(tokenA);
    expect(after.availableToday).toBe(before.availableToday);
    expect(after.monthEndAvailableForecast).toBe(before.monthEndAvailableForecast);
  });
});
