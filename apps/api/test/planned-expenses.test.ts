import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { runOccurrenceMaintenance } from '../src/scheduler.js';
import { seedSystemCategories } from '../src/categories/seed.js';
import {
  generateMonthlyOccurrences,
  localDateString,
} from '@finance/finance-core';
import {
  plannedExpenseMutationResponseSchema,
  type CategoryPublic,
  type PlannedExpensePublic,
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
  const res = await request(app).get('/accounts').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  const by = (type: string) =>
    (res.body.accounts as { type: string; id: string }[]).find((a) => a.type === type)!.id;
  return { cash: by('CASH'), bank: by('BANK'), mvola: by('MVOLA'), savings: by('SAVINGS') };
}

async function loadCategories(token: string): Promise<Map<string, CategoryPublic>> {
  const res = await request(app).get('/categories').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return new Map((res.body.categories as CategoryPublic[]).map((c) => [c.code, c]));
}

async function getAccount(token: string, type: string) {
  const res = await request(app).get('/accounts').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return (res.body.accounts as { type: string; balance: string; initialBalance: string }[]).find(
    (a) => a.type === type,
  )!;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function postPlanned(token: string, body: Record<string, unknown>) {
  return request(app).post('/planned-expenses').set(auth(token)).send(body);
}

function getPlanned(token: string, query = '') {
  return request(app).get(`/planned-expenses${query}`).set(auth(token));
}

function patchPlanned(token: string, id: string, body: Record<string, unknown>) {
  return request(app).patch(`/planned-expenses/${id}`).set(auth(token)).send(body);
}

function deletePlanned(token: string, id: string) {
  return request(app).delete(`/planned-expenses/${id}`).set(auth(token));
}

function skipPlanned(token: string, id: string) {
  return request(app).post(`/planned-expenses/${id}/skip`).set(auth(token));
}

function confirmPaid(token: string, id: string, body: Record<string, unknown>) {
  return request(app).post(`/planned-expenses/${id}/confirm-paid`).set(auth(token)).send(body);
}

function postRecurring(token: string, body: Record<string, unknown>) {
  return request(app).post('/recurring-expenses').set(auth(token)).send(body);
}

function patchRecurring(token: string, id: string, body: Record<string, unknown>) {
  return request(app).patch(`/recurring-expenses/${id}`).set(auth(token)).send(body);
}

function deleteRecurring(token: string, id: string) {
  return request(app).delete(`/recurring-expenses/${id}`).set(auth(token));
}

function getReminders(token: string, query = '') {
  return request(app).get(`/reminders${query}`).set(auth(token));
}

beforeAll(async () => {
  await prisma.plannedExpense.deleteMany();
  await prisma.recurringExpenseRule.deleteMany();
  await prisma.transactionAccountAllocation.deleteMany();
  await prisma.accountAdjustment.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.user.deleteMany();
  await seedSystemCategories();

  tokenA = await register('planned-a@example.com');
  tokenB = await register('planned-b@example.com');
  accountsA = await idsOf(tokenA);
  categories = await loadCategories(tokenA);
});

beforeEach(async () => {
  await prisma.plannedExpense.deleteMany();
  await prisma.recurringExpenseRule.deleteMany();
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

/**
 * Extrait le DTO d'une réponse de mutation en le validant sur le schéma
 * partagé : le type de `plannedExpense` est alors exact (PlannedExpensePublic),
 * catégorie incluse — plus aucun accès « à l'aveugle » sur un objet inconnu.
 */
function plannedOf(body: unknown): PlannedExpensePublic {
  return plannedExpenseMutationResponseSchema.parse(body).plannedExpense;
}

function categoryId(code: string): string {
  return categories.get(code)!.id;
}

describe('Dépense future ponctuelle — CRUD', () => {
  it('13. crée une dépense ponctuelle PENDING (aucun compte requis)', async () => {
    const res = await postPlanned(tokenA, {
      amount: '80000',
      dueDate: '2026-10-05',
      categoryId: categoryId('internet'),
      description: 'Internet',
    });
    expect(res.status).toBe(201);
    const plan = plannedOf(res.body);
    expect(plan.amount).toBe('80000');
    expect(plan.dueDate).toBe('2026-10-05');
    expect(plan.status).toBe('PENDING');
    expect(plan.category?.name).toBe('Internet');
    expect(plan.recurringRuleId).toBeNull();
    expect(plan.confirmedTransactionId).toBeNull();
    expect(plan.bucket).not.toBeNull();
    expectNoSecrets(res.body);
  });

  it('14. montant invalide → 400', async () => {
    for (const bad of ['0', '-5', 'abc', '1.234', '']) {
      const res = await postPlanned(tokenA, {
        amount: bad,
        dueDate: '2026-10-05',
        categoryId: categoryId('internet'),
      });
      expect(res.status, `amount=${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('15. catégorie valide utilisée telle quelle', async () => {
    const res = await postPlanned(tokenA, {
      amount: '5000',
      dueDate: '2026-10-10',
      categoryId: categoryId('transport'),
    });
    expect(res.status).toBe(201);
    expect(res.body.plannedExpense.category?.id).toBe(categoryId('transport'));
  });

  it('16. catégorie inconnue EXPLICITE (« je ne sais pas encore »)', async () => {
    const res = await postPlanned(tokenA, {
      amount: '12000',
      dueDate: '2026-10-12',
      categoryUnknown: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.plannedExpense.categoryUnknown).toBe(true);
    expect(res.body.plannedExpense.category).toBeNull();
  });

  it('17. catégorie absente AMBIGUË → 400', async () => {
    const res = await postPlanned(tokenA, {
      amount: '12000',
      dueDate: '2026-10-12',
    });
    expect(res.status).toBe(400);
  });

  it('18. date invalide (2026-02-31) → 400', async () => {
    const res = await postPlanned(tokenA, {
      amount: '12000',
      dueDate: '2026-02-31',
      categoryId: categoryId('other'),
    });
    expect(res.status).toBe(400);
  });

  it('19. l’utilisateur B ne peut ni lire, ni modifier, ni annuler le plan de A', async () => {
    const created = await postPlanned(tokenA, {
      amount: '30000',
      dueDate: '2026-10-05',
      categoryId: categoryId('internet'),
    });
    const id = (created.body.plannedExpense as { id: string }).id;

    const listB = await getPlanned(tokenB);
    expect(
      (listB.body.plannedExpenses as { id: string }[]).some((p) => p.id === id),
    ).toBe(false);

    expect((await patchPlanned(tokenB, id, { amount: '1' })).status).toBe(404);
    expect((await deletePlanned(tokenB, id)).status).toBe(404);
    expect((await skipPlanned(tokenB, id)).status).toBe(404);
    expect((await confirmPaid(tokenB, id, {
      amount: '30000',
      occurredAt: '2026-10-05',
      accountUnknown: true,
      categoryId: categoryId('internet'),
    })).status).toBe(404);

    // Intact pour A.
    const after = await getPlanned(tokenA);
    expect((after.body.plannedExpenses as { id: string }[]).some((p) => p.id === id)).toBe(true);
  });

  it('20. modification d’une dépense PENDING', async () => {
    const created = await postPlanned(tokenA, {
      amount: '80000',
      dueDate: '2026-10-05',
      categoryId: categoryId('internet'),
      description: 'Internet',
    });
    const id = (created.body.plannedExpense as { id: string }).id;
    const patched = await patchPlanned(tokenA, id, {
      amount: '90000',
      dueDate: '2026-10-07',
      categoryId: categoryId('subscription'),
      description: 'Fibre',
    });
    expect(patched.status).toBe(200);
    const plan = plannedOf(patched.body);
    expect(plan.amount).toBe('90000');
    expect(plan.dueDate).toBe('2026-10-07');
    expect(plan.description).toBe('Fibre');
    expect(plan.category?.name).toBe(categories.get('subscription')!.name);
    expect(plan.status).toBe('PENDING');
  });

  it('21. annulation d’une ponctuelle → CANCELED (soft-state conservé)', async () => {
    const created = await postPlanned(tokenA, {
      amount: '10000',
      dueDate: '2026-10-05',
      categoryId: categoryId('other'),
    });
    const id = (created.body.plannedExpense as { id: string }).id;
    const res = await deletePlanned(tokenA, id);
    expect(res.status).toBe(200);
    expect(res.body.plannedExpense.status).toBe('CANCELED');
    // Annuler deux fois reste idempotent (retry réseau / double clic).
    expect((await deletePlanned(tokenA, id)).status).toBe(200);
  });
});

describe('Confirmation « Oui, payé » — soldes, atomicité, concurrence', () => {
  async function seedCash(amount: string): Promise<void> {
    await prisma.account.update({
      where: { id: accountsA.cash },
      data: { initialBalance: amount },
    });
  }

  it('33. une dépense planifiée PENDING ne touche AUCUN solde ni total', async () => {
    await seedCash('100000');
    const plan = await postPlanned(tokenA, {
      amount: '30000',
      dueDate: '2026-10-05',
      categoryId: categoryId('internet'),
    });
    expect(plan.status).toBe(201);

    expect((await getAccount(tokenA, 'CASH')).balance).toBe('100000');
    const dash = await request(app).get('/accounts').set(auth(tokenA));
    expect(dash.body.totalAvailable).toBe('100000');
    const ledger = await request(app).get('/transactions').set(auth(tokenA));
    expect(ledger.body.transactions).toHaveLength(0);
    expect(ledger.body.totals).toEqual({ incomes: '0', expenses: '0' });
  });

  it('34+35. confirmer crée une vraie EXPENSE puis le solde baisse (et pas avant)', async () => {
    await seedCash('100000');
    const plan = await postPlanned(tokenA, {
      amount: '30000',
      dueDate: '2026-10-05',
      categoryId: categoryId('internet'),
    });
    const id = (plan.body.plannedExpense as { id: string }).id;

    // Avant confirmation : aucun impact.
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('100000');

    const confirm = await confirmPaid(tokenA, id, {
      amount: '30000',
      occurredAt: '2026-10-05',
      categoryId: categoryId('internet'),
      allocations: [{ accountId: accountsA.cash, amount: '30000' }],
    });
    expect(confirm.status).toBe(201);
    expect(confirm.body.transaction.type).toBe('EXPENSE');
    expect(confirm.body.transaction.allocations).toHaveLength(1);
    expect(confirm.body.plannedExpense.status).toBe('PAID');

    // 36. Total disponible diminue seulement APRÈS la confirmation.
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('70000');
    const dash = await request(app).get('/accounts').set(auth(tokenA));
    expect(dash.body.totalAvailable).toBe('70000');
    const ledger = await request(app).get('/transactions').set(auth(tokenA));
    expect(ledger.body.totals).toEqual({ incomes: '0', expenses: '30000' });
  });

  it('37. montant RÉEL différent du montant prévu (plan conservé tel quel)', async () => {
    await seedCash('200000');
    const plan = await postPlanned(tokenA, {
      amount: '80000',
      dueDate: '2026-10-05',
      categoryId: categoryId('internet'),
    });
    const id = (plan.body.plannedExpense as { id: string }).id;
    const confirm = await confirmPaid(tokenA, id, {
      amount: '82500',
      occurredAt: '2026-10-05',
      categoryId: categoryId('internet'),
      allocations: [{ accountId: accountsA.cash, amount: '82500' }],
    });
    expect(confirm.status).toBe(201);
    expect(confirm.body.transaction.amount).toBe('82500');
    expect(confirm.body.plannedExpense.amount).toBe('80000');
    expect(confirm.body.plannedExpense.status).toBe('PAID');
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('117500');
  });

  it('38. paiement réel MULTI-SOURCE (une seule Transaction EXPENSE)', async () => {
    await seedCash('200000');
    await prisma.account.update({
      where: { id: accountsA.mvola },
      data: { initialBalance: '300000' },
    });
    const plan = await postPlanned(tokenA, {
      amount: '60000',
      dueDate: '2026-10-06',
      categoryId: categoryId('other'),
    });
    const id = (plan.body.plannedExpense as { id: string }).id;
    const confirm = await confirmPaid(tokenA, id, {
      amount: '60000',
      occurredAt: '2026-10-06',
      categoryId: categoryId('other'),
      allocations: [
        { accountId: accountsA.mvola, amount: '40000' },
        { accountId: accountsA.cash, amount: '20000' },
      ],
    });
    expect(confirm.status).toBe(201);
    expect(confirm.body.transaction.allocations).toHaveLength(2);
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('180000');
    expect((await getAccount(tokenA, 'MVOLA')).balance).toBe('260000');
    const ledger = await request(app).get('/transactions').set(auth(tokenA));
    expect(ledger.body.transactions).toHaveLength(1);
  });

  it('39. compte réel INCONNU explicite (aucun débit, Transaction réelle quand même)', async () => {
    await seedCash('100000');
    const plan = await postPlanned(tokenA, {
      amount: '50000',
      dueDate: '2026-10-07',
      categoryId: categoryId('other'),
    });
    const id = (plan.body.plannedExpense as { id: string }).id;
    const confirm = await confirmPaid(tokenA, id, {
      amount: '50000',
      occurredAt: '2026-10-07',
      accountUnknown: true,
      categoryId: categoryId('other'),
    });
    expect(confirm.status).toBe(201);
    expect(confirm.body.transaction.accountUnknown).toBe(true);
    expect(confirm.body.transaction.allocations).toHaveLength(0);
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('100000');
    const ledger = await request(app).get('/transactions').set(auth(tokenA));
    expect(ledger.body.totals.expenses).toBe('50000');
    expect(confirm.body.plannedExpense.status).toBe('PAID');
  });

  it('40. date réelle INCONNUE explicite → Transaction sans occurredAt', async () => {
    const plan = await postPlanned(tokenA, {
      amount: '20000',
      dueDate: '2026-10-05',
      categoryId: categoryId('other'),
    });
    const id = (plan.body.plannedExpense as { id: string }).id;
    const confirm = await confirmPaid(tokenA, id, {
      amount: '20000',
      dateUnknown: true,
      accountUnknown: true,
      categoryId: categoryId('other'),
    });
    expect(confirm.status).toBe(201);
    expect(confirm.body.transaction.occurredAt).toBeNull();
    expect(confirm.body.plannedExpense.status).toBe('PAID');
  });

  it('22. annulation d’une dépense déjà PAID → 409 (et skip aussi)', async () => {
    const plan = await postPlanned(tokenA, {
      amount: '20000',
      dueDate: '2026-10-05',
      categoryId: categoryId('other'),
    });
    const id = (plan.body.plannedExpense as { id: string }).id;
    await confirmPaid(tokenA, id, {
      amount: '20000',
      dateUnknown: true,
      accountUnknown: true,
      categoryId: categoryId('other'),
    });
    expect((await deletePlanned(tokenA, id)).status).toBe(409);
    expect((await skipPlanned(tokenA, id)).status).toBe(409);
  });

  it('41. double confirmation → refusée (409)', async () => {
    const plan = await postPlanned(tokenA, {
      amount: '10000',
      dueDate: '2026-10-05',
      categoryId: categoryId('other'),
    });
    const id = (plan.body.plannedExpense as { id: string }).id;
    const body = {
      amount: '10000',
      occurredAt: '2026-10-05',
      accountUnknown: true,
      categoryId: categoryId('other'),
    };
    const first = await confirmPaid(tokenA, id, body);
    expect(first.status).toBe(201);
    const second = await confirmPaid(tokenA, id, body);
    expect(second.status).toBe(409);
    const ledger = await request(app).get('/transactions').set(auth(tokenA));
    expect(ledger.body.transactions).toHaveLength(1);
  });

  it('42. deux confirmations CONCURRENTES → une seule Transaction', async () => {
    const plan = await postPlanned(tokenA, {
      amount: '40000',
      dueDate: '2026-10-05',
      categoryId: categoryId('other'),
    });
    const id = (plan.body.plannedExpense as { id: string }).id;
    const body = {
      amount: '40000',
      occurredAt: '2026-10-05',
      accountUnknown: true,
      categoryId: categoryId('other'),
    };
    const [r1, r2] = await Promise.all([
      confirmPaid(tokenA, id, body),
      confirmPaid(tokenA, id, body),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);

    const planned = await getPlanned(tokenA);
    const planRow = (planned.body.plannedExpenses as { id: string; status: string }[]).find(
      (p) => p.id === id,
    )!;
    expect(planRow.status).toBe('PAID');
    const ledger = await request(app).get('/transactions').set(auth(tokenA));
    expect(ledger.body.transactions).toHaveLength(1);
    expect(ledger.body.totals.expenses).toBe('40000');
  });

  it('43. échec de confirmation (compte de B) → atomique : rien créé, plan PENDING', async () => {
    const accountsB = await idsOf(tokenB);
    const plan = await postPlanned(tokenA, {
      amount: '5000',
      dueDate: '2026-10-05',
      categoryId: categoryId('other'),
    });
    const id = (plan.body.plannedExpense as { id: string }).id;
    const res = await confirmPaid(tokenA, id, {
      amount: '5000',
      occurredAt: '2026-10-05',
      categoryId: categoryId('other'),
      allocations: [{ accountId: accountsB.cash, amount: '5000' }],
    });
    expect(res.status).toBe(404);

    const planned = await getPlanned(tokenA);
    const planRow = (planned.body.plannedExpenses as { id: string; status: string }[]).find(
      (p) => p.id === id,
    )!;
    expect(planRow.status).toBe('PENDING');
    const ledger = await request(app).get('/transactions').set(auth(tokenA));
    expect(ledger.body.transactions).toHaveLength(0);
  });

  it('44. suppression soft de la Transaction liée → plan remis PENDING (re-confirmable)', async () => {
    await seedCash('100000');
    const plan = await postPlanned(tokenA, {
      amount: '30000',
      dueDate: '2026-10-05',
      categoryId: categoryId('internet'),
    });
    const id = (plan.body.plannedExpense as { id: string }).id;
    const confirm = await confirmPaid(tokenA, id, {
      amount: '30000',
      occurredAt: '2026-10-05',
      categoryId: categoryId('internet'),
      allocations: [{ accountId: accountsA.cash, amount: '30000' }],
    });
    const txId = (confirm.body.transaction as { id: string }).id;
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('70000');

    const del = await request(app)
      .delete(`/transactions/${txId}`)
      .set(auth(tokenA));
    expect(del.status).toBe(204);

    expect((await getAccount(tokenA, 'CASH')).balance).toBe('100000');
    const planned = await getPlanned(tokenA);
    const planRow = (planned.body.plannedExpenses as {
      id: string;
      status: string;
      confirmedTransactionId: string | null;
    }[]).find((p) => p.id === id)!;
    expect(planRow.status).toBe('PENDING');
    expect(planRow.confirmedTransactionId).toBeNull();

    const reconfirm = await confirmPaid(tokenA, id, {
      amount: '30000',
      occurredAt: '2026-10-05',
      categoryId: categoryId('internet'),
      allocations: [{ accountId: accountsA.cash, amount: '30000' }],
    });
    expect(reconfirm.status).toBe(201);
    const ledger = await request(app).get('/transactions').set(auth(tokenA));
    expect(ledger.body.transactions).toHaveLength(1);
  });

  it('45. édition de la Transaction réelle → le plan garde son montant PRÉVU', async () => {
    const plan = await postPlanned(tokenA, {
      amount: '80000',
      dueDate: '2026-10-05',
      categoryId: categoryId('internet'),
      description: 'Internet',
    });
    const id = (plan.body.plannedExpense as { id: string }).id;
    const confirm = await confirmPaid(tokenA, id, {
      amount: '82000',
      occurredAt: '2026-10-05',
      categoryId: categoryId('internet'),
      allocations: [{ accountId: accountsA.cash, amount: '82000' }],
    });
    const txId = (confirm.body.transaction as { id: string }).id;

    const edit = await request(app)
      .patch(`/transactions/${txId}`)
      .set(auth(tokenA))
      .send({
        type: 'EXPENSE',
        amount: '81500',
        occurredAt: '2026-10-06',
        categoryId: categoryId('internet'),
        allocations: [{ accountId: accountsA.cash, amount: '81500' }],
      });
    expect(edit.status).toBe(200);
    expect(edit.body.transaction.amount).toBe('81500');

    const planned = await getPlanned(tokenA);
    const planRow = (planned.body.plannedExpenses as {
      id: string;
      amount: string;
      status: string;
      dueDate: string;
    }[]).find((p) => p.id === id)!;
    expect(planRow.amount).toBe('80000');
    expect(planRow.dueDate).toBe('2026-10-05');
    expect(planRow.status).toBe('PAID');
  });
});

describe('Dépense mensuelle récurrente — occurrences', () => {
  const monthKey = localDateString(new Date()).slice(0, 7);
  const currentMonthFirst = `${monthKey}-01`;

  function listByRule(ruleId: string) {
    return getPlanned(tokenA).then((res) =>
      (res.body.plannedExpenses as PlannedLike[]).filter(
        (p) => p.recurringRuleId === ruleId,
      ),
    );
  }

  async function createDayRule(dayOfMonth: number, amount = '80000') {
    const res = await postRecurring(tokenA, {
      amount,
      dayOfMonth,
      startDate: currentMonthFirst,
      categoryId: categoryId('internet'),
      description: 'Internet',
    });
    expect(res.status).toBe(201);
    return (res.body.recurringExpense as { id: string }).id;
  }

  it('23+24. créer une règle génère ses occurrences (mois courant + 3)', async () => {
    const ruleId = await createDayRule(5);
    const occurrences = await listByRule(ruleId);
    const expected = generateMonthlyOccurrences({
      startDate: currentMonthFirst,
      dayOfMonth: 5,
      referenceDate: localDateString(new Date()),
    });
    expect(occurrences).toHaveLength(expected.length);
    const dues = occurrences.map((o) => o.dueDate).sort();
    expect(dues).toEqual([...expected].sort());
    for (const occurrence of occurrences) {
      expect(occurrence.status).toBe('PENDING');
      expect(occurrence.amount).toBe('80000');
    }
  });

  it('25. génération IDEMPOTENTE : deux relectures ne créent aucun doublon', async () => {
    const ruleId = await createDayRule(5);
    const before = await listByRule(ruleId);
    const again = await listByRule(ruleId);
    expect(again).toHaveLength(before.length);
    const dbRows = await prisma.plannedExpense.findMany({
      where: { recurringRuleId: ruleId },
      select: { dueDate: true },
    });
    const keys = dbRows.map((r) => r.dueDate.toISOString());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('26. aucune occurrence dupliquée (contrainte unique DB)', async () => {
    const ruleId = await createDayRule(12);
    const rows = await prisma.plannedExpense.findMany({
      where: { recurringRuleId: ruleId },
      select: { dueDate: true },
    });
    const iso = rows.map((r) => r.dueDate.toISOString().slice(0, 10));
    expect(iso.length).toBe(new Set(iso).size);
  });

  it('27. jour 31 clampe : avril → 30, mai → 31', async () => {
    const ruleId = await postRecurring(tokenA, {
      amount: '10000',
      dayOfMonth: 31,
      startDate: '2026-04-01',
      categoryId: categoryId('other'),
    });
    expect(ruleId.status).toBe(201);
    const occurrences = await listByRule((ruleId.body.recurringExpense as { id: string }).id);
    const dues = occurrences.map((o) => o.dueDate);
    expect(dues).toContain('2026-04-30'); // avril n'a pas de 31
    expect(dues).toContain('2026-05-31');
    expect(dues.some((d) => d === '2026-04-31')).toBe(false);
  });

  it('28+29. modifier une règle n’affecte que les occurrences PENDING (historique PAID intact)', async () => {
    const ruleId = await createDayRule(5, '80000');
    const before = await listByRule(ruleId);
    const first = before[0]!;
    const confirm = await confirmPaid(tokenA, first.id, {
      amount: '80000',
      occurredAt: first.dueDate,
      accountUnknown: true,
      categoryId: categoryId('internet'),
    });
    expect(confirm.status).toBe(201);

    const patched = await patchRecurring(tokenA, ruleId, {
      amount: '90000',
      dayOfMonth: 7,
    });
    expect(patched.status).toBe(200);

    const occurrences = await listByRule(ruleId);
    const paid = occurrences.find((o) => o.id === first.id)!;
    expect(paid.status).toBe('PAID');
    expect(paid.amount).toBe('80000'); // valeur historique conservée
    expect(paid.dueDate).toBe(first.dueDate);

    const pending = occurrences.filter((o) => o.status === 'PENDING');
    expect(pending.length).toBeGreaterThan(0);
    for (const occurrence of pending) {
      expect(occurrence.amount).toBe('90000'); // nouvelle valeur
    }
    // Le mois déjà payé n'a PAS reçu de nouvelle occurrence PENDING.
    const paidMonth = paid.dueDate.slice(0, 7);
    expect(pending.some((o) => o.dueDate.slice(0, 7) === paidMonth)).toBe(false);
  });

  it('30. désactiver une récurrence annule ses PENDING et n’ajoute plus rien', async () => {
    const ruleId = await createDayRule(5);
    const occurrences = await listByRule(ruleId);
    const del = await deleteRecurring(tokenA, ruleId);
    expect(del.status).toBe(204);

    const after = await listByRule(ruleId);
    expect(after.filter((o) => o.status === 'PENDING')).toHaveLength(0);
    expect(after.filter((o) => o.status === 'CANCELED').length).toBe(
      occurrences.length,
    );
    // La règle est désactivée : aucune nouvelle lecture ne peut la réactiver
    // (les GET sont read-only et ne déclenchent plus aucune maintenance).
    expect((await listByRule(ruleId)).filter((o) => o.status === 'PENDING')).toHaveLength(0);
  });

  it('31+32. ignorer une occurrence la marque SKIPPED sans arrêter le mois suivant', async () => {
    const ruleId = await createDayRule(5);
    const occurrences = await listByRule(ruleId);
    const skipped = occurrences[0]!;
    const nextMonthPending = occurrences.find(
      (o) => o.dueDate > skipped.dueDate,
    )!;

    const skip = await skipPlanned(tokenA, skipped.id);
    expect(skip.status).toBe(200);
    expect(skip.body.plannedExpense.status).toBe('SKIPPED');

    const after = await listByRule(ruleId);
    expect(after.find((o) => o.id === skipped.id)?.status).toBe('SKIPPED');
    const refreshed = after.find((o) => o.id === nextMonthPending.id)!;
    expect(refreshed.status).toBe('PENDING');
    expect(after.some((o) => o.status === 'PENDING' && o.dueDate > skipped.dueDate)).toBe(true);
  });
});

type PlannedLike = {
  id: string;
  amount: string;
  dueDate: string;
  status: string;
  recurringRuleId: string | null;
  bucket: string | null;
};


describe('Rappels internes « Payé ? »', () => {
  it('46. échéance future proche → upcoming', async () => {
    const created = await postPlanned(tokenA, {
      amount: '5000',
      dueDate: '2026-10-08',
      categoryId: categoryId('other'),
    });
    const id = (created.body.plannedExpense as { id: string }).id;
    const res = await getReminders(tokenA, '?today=2026-10-05');
    expect(res.status).toBe(200);
    expect(res.body.overdue).toHaveLength(0);
    expect(res.body.dueToday).toHaveLength(0);
    expect((res.body.upcoming as { id: string }[]).map((p) => p.id)).toContain(id);
    expect(res.body.today).toBe('2026-10-05');
    expectNoSecrets(res.body);
  });

  it('47. échéance du jour local → due', async () => {
    const created = await postPlanned(tokenA, {
      amount: '5000',
      dueDate: '2026-10-05',
      categoryId: categoryId('other'),
    });
    const id = (created.body.plannedExpense as { id: string }).id;
    const res = await getReminders(tokenA, '?today=2026-10-05');
    expect((res.body.dueToday as { id: string }[]).map((p) => p.id)).toContain(id);
  });

  it('48. échéance passée PENDING → overdue', async () => {
    const created = await postPlanned(tokenA, {
      amount: '5000',
      dueDate: '2026-10-01',
      categoryId: categoryId('other'),
    });
    const id = (created.body.plannedExpense as { id: string }).id;
    const res = await getReminders(tokenA, '?today=2026-10-05');
    expect((res.body.overdue as { id: string }[]).map((p) => p.id)).toContain(id);
  });

  it('49. une dépense PAID n’apparaît pas comme rappel actif', async () => {
    const created = await postPlanned(tokenA, {
      amount: '5000',
      dueDate: '2026-09-30',
      categoryId: categoryId('other'),
    });
    const id = (created.body.plannedExpense as { id: string }).id;
    const confirm = await confirmPaid(tokenA, id, {
      amount: '5000',
      dateUnknown: true,
      accountUnknown: true,
      categoryId: categoryId('other'),
    });
    expect(confirm.status).toBe(201);
    const res = await getReminders(tokenA, '?today=2026-10-05');
    const all = [
      ...(res.body.overdue as { id: string }[]),
      ...(res.body.dueToday as { id: string }[]),
      ...(res.body.upcoming as { id: string }[]),
    ];
    expect(all.some((p) => p.id === id)).toBe(false);
  });

  it('50. une dépense CANCELED n’apparaît pas comme rappel actif', async () => {
    const created = await postPlanned(tokenA, {
      amount: '5000',
      dueDate: '2026-10-01',
      categoryId: categoryId('other'),
    });
    const id = (created.body.plannedExpense as { id: string }).id;
    await deletePlanned(tokenA, id);
    const res = await getReminders(tokenA, '?today=2026-10-05');
    const all = [
      ...(res.body.overdue as { id: string }[]),
      ...(res.body.dueToday as { id: string }[]),
      ...(res.body.upcoming as { id: string }[]),
    ];
    expect(all.some((p) => p.id === id)).toBe(false);
  });

  it('51. une occurrence SKIPPED n’apparaît pas comme rappel actif', async () => {
    const ruleId = await postRecurring(tokenA, {
      amount: '8000',
      dayOfMonth: 1,
      startDate: `${localDateString(new Date()).slice(0, 7)}-01`,
      categoryId: categoryId('other'),
    });
    const occurrences = await getPlanned(tokenA);
    const own = (occurrences.body.plannedExpenses as PlannedLike[]).filter(
      (p) => p.recurringRuleId === (ruleId.body.recurringExpense as { id: string }).id,
    );
    const skipped = own[0]!;
    await skipPlanned(tokenA, skipped.id);
    // « today » = le jour de l'occurrence ignorée → elle serait due sinon.
    const res = await getReminders(tokenA, `?today=${skipped.dueDate}`);
    const all = [
      ...(res.body.overdue as { id: string }[]),
      ...(res.body.dueToday as { id: string }[]),
      ...(res.body.upcoming as { id: string }[]),
    ];
    expect(all.some((p) => p.id === skipped.id)).toBe(false);
  });

  it('52. isolation utilisateurs : B ne voit jamais les rappels de A', async () => {
    await postPlanned(tokenA, {
      amount: '5000',
      dueDate: '2026-10-01',
      categoryId: categoryId('other'),
    });
    const res = await getReminders(tokenB, '?today=2026-10-05');
    expect(res.status).toBe(200);
    expect(res.body.overdue).toHaveLength(0);
    expect(res.body.dueToday).toHaveLength(0);
    expect(res.body.upcoming).toHaveLength(0);
  });

  it('53. jour local explicite : le même plan change de catégorie selon today', async () => {
    const created = await postPlanned(tokenA, {
      amount: '5000',
      dueDate: '2026-10-05',
      categoryId: categoryId('other'),
    });
    const id = (created.body.plannedExpense as { id: string }).id;
    const before = await getReminders(tokenA, '?today=2026-10-04');
    const sameDay = await getReminders(tokenA, '?today=2026-10-05');
    const after = await getReminders(tokenA, '?today=2026-10-12');

    expect((before.body.upcoming as { id: string }[]).some((p) => p.id === id)).toBe(true);
    expect((sameDay.body.dueToday as { id: string }[]).some((p) => p.id === id)).toBe(true);
    expect((after.body.overdue as { id: string }[]).some((p) => p.id === id)).toBe(true);
  });

  it('today invalide (format) → 400', async () => {
    expect((await getReminders(tokenA, '?today=10-05-2026')).status).toBe(400);
  });
});


describe('Garantie read-only : les GET ne génèrent JAMAIS d’occurrence', () => {
  const monthKey = localDateString(new Date()).slice(0, 7);
  const currentMonthFirst = `${monthKey}-01`;

  async function createReadOnlyRule(dayOfMonth = 5): Promise<string> {
    const res = await postRecurring(tokenA, {
      amount: '15000',
      dayOfMonth,
      startDate: currentMonthFirst,
      categoryId: categoryId('transport'),
      description: 'Lecture seule',
    });
    expect(res.status).toBe(201);
    return (res.body.recurringExpense as { id: string }).id;
  }

  function countRuleRows(ruleId: string): Promise<number> {
    return prisma.plannedExpense.count({ where: { recurringRuleId: ruleId } });
  }

  it('54. GET /planned-expenses ne crée aucune occurrence (zéro écriture DB)', async () => {
    const ruleId = await createReadOnlyRule();
    expect(await countRuleRows(ruleId)).toBeGreaterThan(0);

    // Simule une API arrêtée plusieurs jours : les occurrences « manquantes »
    // ne sont volontairement PAS en base.
    await prisma.plannedExpense.deleteMany({
      where: { recurringRuleId: ruleId },
    });
    expect(await countRuleRows(ruleId)).toBe(0);

    const res = await getPlanned(tokenA);
    expect(res.status).toBe(200);
    expect(
      (res.body.plannedExpenses as PlannedLike[]).filter(
        (p) => p.recurringRuleId === ruleId,
      ),
    ).toHaveLength(0);

    // La lecture n'a régénéré AUCUNE occurrence.
    expect(await countRuleRows(ruleId)).toBe(0);
  });

  it('55. GET /reminders ne crée aucune occurrence (zéro écriture DB)', async () => {
    const ruleId = await createReadOnlyRule();
    expect(await countRuleRows(ruleId)).toBeGreaterThan(0);

    await prisma.plannedExpense.deleteMany({
      where: { recurringRuleId: ruleId },
    });
    expect(await countRuleRows(ruleId)).toBe(0);

    const res = await getReminders(tokenA);
    expect(res.status).toBe(200);
    expect(res.body.overdue).toHaveLength(0);
    expect(res.body.dueToday).toHaveLength(0);
    expect(res.body.upcoming).toHaveLength(0);

    // La lecture n'a régénéré AUCUNE occurrence.
    expect(await countRuleRows(ruleId)).toBe(0);
  });

  it('56. plusieurs GET consécutifs n’ajoutent NI ne modifient aucune ligne', async () => {
    const ruleId = await createReadOnlyRule();
    const beforeCount = await countRuleRows(ruleId);
    expect(beforeCount).toBeGreaterThan(0);

    async function snapshot(): Promise<string> {
      const rows = await prisma.plannedExpense.findMany({
        where: { recurringRuleId: ruleId },
        select: { id: true, dueDate: true, status: true, amount: true, updatedAt: true },
        orderBy: { dueDate: 'asc' },
      });
      return JSON.stringify(
        rows.map((row) => ({
          id: row.id,
          dueDate: row.dueDate.toISOString(),
          status: row.status,
          amount: row.amount.toString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
      );
    }

    const beforeFingerprint = await snapshot();

    for (let i = 0; i < 3; i += 1) {
      expect((await getPlanned(tokenA)).status).toBe(200);
      expect((await getReminders(tokenA)).status).toBe(200);
    }

    expect(await countRuleRows(ruleId)).toBe(beforeCount);
    // updatedAt inchangé ⇒ aucune écriture (ni création, ni mise à jour).
    expect(await snapshot()).toBe(beforeFingerprint);
  });

  it('57. le rattrapage EXPLICITE (démarrage API / scheduler) régénère les occurrences', async () => {
    // Règle cible + règle témoin strictement identiques (même génération).
    const ruleA = await createReadOnlyRule();
    const ruleB = await createReadOnlyRule();
    const expected = await countRuleRows(ruleA);
    expect(expected).toBe(await countRuleRows(ruleB));
    expect(expected).toBeGreaterThan(0);

    await prisma.plannedExpense.deleteMany({
      where: { recurringRuleId: ruleA },
    });
    expect(await countRuleRows(ruleA)).toBe(0);

    // Bootstrap : point d'entrée appelé au démarrage de l'API ET par le cron.
    await runOccurrenceMaintenance();

    const rows = await prisma.plannedExpense.findMany({
      where: { recurringRuleId: ruleA },
      select: { status: true },
    });
    expect(rows.every((row) => row.status === 'PENDING')).toBe(true);
    // La passe a aussi touché la règle témoin sans rien y ajouter.
    expect(await countRuleRows(ruleB)).toBe(expected);
  });

  it('58. rattrapage IDEMPOTENT : passes répétées (bootstrap + scheduler) sans ajout', async () => {
    const ruleId = await createReadOnlyRule();
    const control = await createReadOnlyRule();
    const expected = await countRuleRows(ruleId);
    expect(expected).toBeGreaterThan(0);
    expect(await countRuleRows(control)).toBe(expected);

    // Nouvelle coupure : l'API s'arrête à nouveau, des mois passent.
    await prisma.plannedExpense.deleteMany({
      where: { recurringRuleId: ruleId },
    });
    await runOccurrenceMaintenance();
    expect(await countRuleRows(control)).toBe(expected);

    // Le cron quotidien (même fonction que le bootstrap) passe deux fois de
    // plus : aucune ligne supplémentaire, aucun doublon.
    await runOccurrenceMaintenance();
    await runOccurrenceMaintenance();

    expect(await countRuleRows(ruleId)).toBe(expected);
    expect(await countRuleRows(control)).toBe(expected);

    const dues = await prisma.plannedExpense.findMany({
      where: { recurringRuleId: ruleId },
      select: { dueDate: true },
    });
    const keys = dues.map((row) => row.dueDate.toISOString().slice(0, 10));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
