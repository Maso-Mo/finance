import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { seedSystemCategories } from '../src/categories/seed.js';
import type { CategoryPublic } from '@finance/shared-types';

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
let accountsB: AccountIds;
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

function postTx(token: string, body: Record<string, unknown>) {
  return request(app).post('/transactions').set('Authorization', `Bearer ${token}`).send(body);
}
function patchTx(token: string, id: string, body: Record<string, unknown>) {
  return request(app).patch(`/transactions/${id}`).set('Authorization', `Bearer ${token}`).send(body);
}
function delTx(token: string, id: string) {
  return request(app).delete(`/transactions/${id}`).set('Authorization', `Bearer ${token}`);
}
function getList(token: string, query = '') {
  return request(app).get(`/transactions${query}`).set('Authorization', `Bearer ${token}`);
}
async function getAccount(token: string, type: string) {
  const res = await request(app).get('/accounts').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return (res.body.accounts as { type: string; balance: string; initialBalance: string }[]).find(
    (a) => a.type === type,
  )!;
}

beforeAll(async () => {
  await prisma.transactionAccountAllocation.deleteMany();
  await prisma.accountAdjustment.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.user.deleteMany();
  await seedSystemCategories();

  tokenA = await register('tx-a@example.com');
  tokenB = await register('tx-b@example.com');
  accountsA = await idsOf(tokenA);
  accountsB = await idsOf(tokenB);
  categories = await loadCategories(tokenA);
});

beforeEach(async () => {
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

describe('GET /categories', () => {
  it('non authentifié → 401', async () => {
    const res = await request(app).get('/categories');
    expect(res.status).toBe(401);
  });

  it('expose uniquement les 10 catégories système', async () => {
    const res = await request(app).get('/categories').set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const list = res.body.categories as CategoryPublic[];
    const codes = list.map((c) => c.code).sort();
    expect(codes).toEqual(
      ['groceries', 'restaurant', 'transport', 'housing', 'internet', 'subscription', 'clothing', 'health', 'leisure', 'other'].sort(),
    );
    for (const c of list) {
      expect(c.isSystem).toBe(true);
    }
    expectNoSecrets(res.body);
  });
});

describe('POST /transactions — dépenses et revenus', () => {
  it('crée une dépense simple : solde et totaux mis à jour', async () => {
    const res = await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '30000',
      description: 'Courses',
      occurredAt: '2026-09-05',
      categoryId: categories.get('groceries')!.id,
      allocations: [{ accountId: accountsA.cash, amount: '30000' }],
    });
    expect(res.status).toBe(201);
    const tx = res.body.transaction as Record<string, unknown> & {
      amount: string;
      occurredAt: string;
      category: { name: string } | null;
      allocations: { accountType: string; amount: string }[];
    };
    expect(tx.amount).toBe('30000');
    expect(tx.occurredAt).toBe('2026-09-05');
    expect(tx.category?.name).toBe('Courses');
    expect(tx.allocations).toHaveLength(1);
    expect(tx.allocations[0]).toEqual({ accountId: accountsA.cash, accountType: 'CASH', amount: '30000' });
    expectNoSecrets(res.body);
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('-30000');
    const list = await getList(tokenA);
    expect(list.body.transactions).toHaveLength(1);
    expect(list.body.totals).toEqual({ incomes: '0', expenses: '30000' });
  });

  it('crée un revenu simple sur le compte de réception', async () => {
    const res = await postTx(tokenA, {
      type: 'INCOME',
      amount: '250000',
      description: 'Salaire',
      occurredAt: '2026-09-01',
      allocations: [{ accountId: accountsA.mvola, amount: '250000' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.transaction.category).toBeNull();
    expect((await getAccount(tokenA, 'MVOLA')).balance).toBe('250000');
    const list = await getList(tokenA);
    expect(list.body.totals).toEqual({ incomes: '250000', expenses: '0' });
  });

  it('multi-source : 600 000 ventilé MVola 400 000 + Cash 200 000 en UNE transaction', async () => {
    const res = await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '600000',
      description: 'Téléphone',
      occurredAt: '2026-09-04',
      categoryId: categories.get('other')!.id,
      allocations: [
        { accountId: accountsA.mvola, amount: '400000' },
        { accountId: accountsA.cash, amount: '200000' },
      ],
    });
    expect(res.status).toBe(201);
    const tx = res.body.transaction as { allocations: { accountId: string }[] };
    expect(tx.allocations).toHaveLength(2);
    const list = await getList(tokenA);
    expect(list.body.transactions).toHaveLength(1);
    expect(list.body.totals).toEqual({ incomes: '0', expenses: '600000' });
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('-200000');
    expect((await getAccount(tokenA, 'MVOLA')).balance).toBe('-400000');
  });

  it('somme des allocations incorrecte (550 000 / 600 000) → 400', async () => {
    const res = await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '600000',
      occurredAt: '2026-09-04',
      categoryId: categories.get('other')!.id,
      allocations: [
        { accountId: accountsA.mvola, amount: '400000' },
        { accountId: accountsA.cash, amount: '150000' },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('un compte qui ne nous appartient pas → 404 (aucune écriture)', async () => {
    const res = await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '1000',
      occurredAt: '2026-09-04',
      categoryId: categories.get('other')!.id,
      allocations: [{ accountId: accountsB.cash, amount: '1000' }],
    });
    expect(res.status).toBe(404);
  });

  it('un compte inconnu (UUID quelconque) → 404', async () => {
    const res = await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '1000',
      occurredAt: '2026-09-04',
      categoryId: categories.get('other')!.id,
      allocations: [{ accountId: UNKNOWN_UUID, amount: '1000' }],
    });
    expect(res.status).toBe(404);
  });

  it('allocation en double sur le même compte → 400', async () => {
    const res = await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '2000',
      occurredAt: '2026-09-04',
      categoryId: categories.get('other')!.id,
      allocations: [
        { accountId: accountsA.cash, amount: '1000' },
        { accountId: accountsA.cash, amount: '1000' },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('catégorie invalide / inexistante → 400', async () => {
    const res = await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '1000',
      occurredAt: '2026-09-04',
      categoryId: UNKNOWN_UUID,
      allocations: [{ accountId: accountsA.cash, amount: '1000' }],
    });
    expect(res.status).toBe(400);
  });
});

describe('date inconnue', () => {
  it('dateUnknown: true sans date → occurredAt null', async () => {
    const res = await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '5000',
      dateUnknown: true,
      categoryId: categories.get('other')!.id,
      allocations: [{ accountId: accountsA.cash, amount: '5000' }],
    });
    expect(res.status).toBe(201);
    expect((res.body.transaction as { occurredAt: string | null }).occurredAt).toBeNull();
  });

  it('ni date ni dateUnknown → 400 (on ne suppose jamais aujourd’hui)', async () => {
    const res = await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '5000',
      categoryId: categories.get('other')!.id,
      allocations: [{ accountId: accountsA.cash, amount: '5000' }],
    });
    expect(res.status).toBe(400);
  });

  it('date ET dateUnknown ensemble → 400', async () => {
    const res = await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '5000',
      occurredAt: '2026-09-05',
      dateUnknown: true,
      categoryId: categories.get('other')!.id,
      allocations: [{ accountId: accountsA.cash, amount: '5000' }],
    });
    expect(res.status).toBe(400);
  });
});

describe('compte(s) inconnu(s)', () => {
  it('accountUnknown: true sans allocation → 201, aucun solde impacté', async () => {
    const res = await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '12000',
      dateUnknown: true,
      accountUnknown: true,
      categoryId: categories.get('other')!.id,
    });
    expect(res.status).toBe(201);
    const tx = res.body.transaction as {
      accountUnknown: boolean;
      allocations: unknown[];
    };
    expect(tx.accountUnknown).toBe(true);
    expect(tx.allocations).toEqual([]);
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('0');
    expect((await getAccount(tokenA, 'MVOLA')).balance).toBe('0');
  });

  it('ni allocations ni accountUnknown → 400', async () => {
    const res = await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '12000',
      dateUnknown: true,
      categoryId: categories.get('other')!.id,
    });
    expect(res.status).toBe(400);
  });
});

describe('catégorie inconnue (EXPENSE)', () => {
  it('categoryUnknown: true sans catégorie → 201, catégorie null', async () => {
    const res = await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '8000',
      dateUnknown: true,
      categoryUnknown: true,
      accountUnknown: true,
    });
    expect(res.status).toBe(201);
    const tx = res.body.transaction as { categoryUnknown: boolean; category: unknown };
    expect(tx.categoryUnknown).toBe(true);
    expect(tx.category).toBeNull();
  });

  it('EXPENSE sans catégorie ni categoryUnknown → 400', async () => {
    const res = await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '8000',
      dateUnknown: true,
      accountUnknown: true,
    });
    expect(res.status).toBe(400);
  });

  it('un revenu ne peut pas porter de catégorie → 400', async () => {
    const res = await postTx(tokenA, {
      type: 'INCOME',
      amount: '8000',
      dateUnknown: true,
      categoryId: categories.get('other')!.id,
      accountUnknown: true,
    });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /transactions/:id — modification', () => {
  async function seedExpense() {
    const created = await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '100000',
      description: 'Ancienne',
      occurredAt: '2026-09-01',
      categoryId: categories.get('groceries')!.id,
      allocations: [{ accountId: accountsA.cash, amount: '100000' }],
    });
    expect(created.status).toBe(201);
    return (created.body.transaction as { id: string }).id;
  }

  it('remplace montant, date, catégorie, description et allocations', async () => {
    const id = await seedExpense();
    const patch = await patchTx(tokenA, id, {
      type: 'EXPENSE',
      amount: '100000',
      description: 'Nouvelle répartition',
      occurredAt: '2026-09-08',
      categoryId: categories.get('transport')!.id,
      allocations: [
        { accountId: accountsA.cash, amount: '60000' },
        { accountId: accountsA.mvola, amount: '40000' },
      ],
    });
    expect(patch.status).toBe(200);
    const tx = patch.body.transaction as {
      amount: string;
      occurredAt: string;
      description: string;
      category: { name: string } | null;
      allocations: { accountId: string; amount: string }[];
    };
    expect(tx.amount).toBe('100000');
    expect(tx.occurredAt).toBe('2026-09-08');
    expect(tx.description).toBe('Nouvelle répartition');
    expect(tx.category?.name).toBe('Transport');
    expect(tx.allocations).toHaveLength(2);

    // Anciennes allocations retirées, seules les nouvelles restent actives.
    const rows = await prisma.transactionAccountAllocation.findMany({ where: { transactionId: id } });
    expect(rows).toHaveLength(2);
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('-60000');
    expect((await getAccount(tokenA, 'MVOLA')).balance).toBe('-40000');
    const list = await getList(tokenA);
    expect(list.body.transactions).toHaveLength(1);
    expect(list.body.totals).toEqual({ incomes: '0', expenses: '100000' });
  });

  it('passe de compte connu à compte inconnu : impact retiré', async () => {
    const id = await seedExpense();
    const patch = await patchTx(tokenA, id, {
      type: 'EXPENSE',
      amount: '100000',
      dateUnknown: true,
      accountUnknown: true,
      categoryId: categories.get('groceries')!.id,
    });
    expect(patch.status).toBe(200);
    expect((patch.body.transaction as { accountUnknown: boolean }).accountUnknown).toBe(true);
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('0');
    expect((await prisma.transactionAccountAllocation.count({ where: { transactionId: id } }))).toBe(0);
  });

  it('passe de compte inconnu à compte connu : le solde se recalcule', async () => {
    const created = await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '25000',
      dateUnknown: true,
      accountUnknown: true,
      categoryId: categories.get('other')!.id,
    });
    const id = (created.body.transaction as { id: string }).id;
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('0');

    const patch = await patchTx(tokenA, id, {
      type: 'EXPENSE',
      amount: '25000',
      dateUnknown: true,
      categoryId: categories.get('other')!.id,
      allocations: [{ accountId: accountsA.cash, amount: '25000' }],
    });
    expect(patch.status).toBe(200);
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('-25000');
  });

  it('une transaction supprimée ne peut plus être modifiée → 409', async () => {
    const id = await seedExpense();
    await delTx(tokenA, id);
    const patch = await patchTx(tokenA, id, {
      type: 'EXPENSE',
      amount: '100000',
      occurredAt: '2026-09-08',
      categoryId: categories.get('other')!.id,
      allocations: [{ accountId: accountsA.cash, amount: '100000' }],
    });
    expect(patch.status).toBe(409);
  });

  it('la transaction d’un autre utilisateur est introuvable → 404', async () => {
    const created = await postTx(tokenB, {
      type: 'INCOME',
      amount: '7000',
      occurredAt: '2026-09-02',
      allocations: [{ accountId: accountsB.cash, amount: '7000' }],
    });
    const id = (created.body.transaction as { id: string }).id;
    const patch = await patchTx(tokenA, id, {
      type: 'INCOME',
      amount: '9999',
      occurredAt: '2026-09-02',
      allocations: [{ accountId: accountsA.cash, amount: '9999' }],
    });
    expect(patch.status).toBe(404);
  });
});

describe('DELETE /transactions/:id — suppression logique', () => {
  it('marque deletedAt, disparaît de l’historique et n’impacte plus les soldes', async () => {
    const created = await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '5000',
      description: 'Transport',
      occurredAt: '2026-09-03',
      categoryId: categories.get('transport')!.id,
      allocations: [{ accountId: accountsA.cash, amount: '5000' }],
    });
    const id = (created.body.transaction as { id: string }).id;
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('-5000');

    const del = await delTx(tokenA, id);
    expect(del.status).toBe(204);

    // La ligne existe toujours en base, avec deletedAt renseigné.
    const row = await prisma.transaction.findUnique({ where: { id } });
    expect(row).not.toBeNull();
    expect((row as { deletedAt: Date | null }).deletedAt).not.toBeNull();

    const list = await getList(tokenA);
    expect(list.body.transactions).toEqual([]);
    expect(list.body.totals).toEqual({ incomes: '0', expenses: '0' });
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('0');
  });

  it('transaction inconnue ou déjà supprimée → 404', async () => {
    const created = await postTx(tokenA, {
      type: 'INCOME',
      amount: '1000',
      occurredAt: '2026-09-03',
      allocations: [{ accountId: accountsA.cash, amount: '1000' }],
    });
    const id = (created.body.transaction as { id: string }).id;
    await delTx(tokenA, id);
    expect((await delTx(tokenA, id)).status).toBe(404);
    expect((await delTx(tokenA, UNKNOWN_UUID)).status).toBe(404);
  });

  it('on ne supprime pas la transaction d’un autre utilisateur → 404', async () => {
    const created = await postTx(tokenB, {
      type: 'INCOME',
      amount: '7000',
      occurredAt: '2026-09-03',
      allocations: [{ accountId: accountsB.cash, amount: '7000' }],
    });
    const id = (created.body.transaction as { id: string }).id;
    expect((await delTx(tokenA, id)).status).toBe(404);
    const list = await getList(tokenB);
    expect(list.body.transactions).toHaveLength(1);
  });
});

describe('saisie du solde cible (PATCH /accounts/:id)', () => {
  it('aucun mouvement → met à jour initialBalance directement', async () => {
    const res = await request(app)
      .patch(`/accounts/${accountsA.bank}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ targetBalance: '100000' });
    expect(res.status).toBe(200);
    expect(res.body.account.initialBalance).toBe('100000');
    expect(res.body.account.balance).toBe('100000');
    expect(
      await prisma.accountAdjustment.count({ where: { accountId: accountsA.bank } }),
    ).toBe(0);
  });

  it('au moins un mouvement → crée un AccountAdjustment, jamais une transaction', async () => {
    await postTx(tokenA, {
      type: 'INCOME',
      amount: '200000',
      occurredAt: '2026-09-03',
      allocations: [{ accountId: accountsA.mvola, amount: '200000' }],
    });

    const patch = await request(app)
      .patch(`/accounts/${accountsA.mvola}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ targetBalance: '180000' });
    expect(patch.status).toBe(200);
    expect(patch.body.account.balance).toBe('180000');
    const adjustments = await prisma.accountAdjustment.findMany({
      where: { accountId: accountsA.mvola },
    });
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]!.amount.toString()).toBe('-20000');

    // L’ajustement n’est NI une dépense NI un revenu.
    const list = await getList(tokenA);
    expect(list.body.transactions).toHaveLength(1);
    expect(list.body.totals).toEqual({ incomes: '200000', expenses: '0' });

    const patch2 = await request(app)
      .patch(`/accounts/${accountsA.mvola}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ targetBalance: '210000' });
    expect(patch2.status).toBe(200);
    expect(patch2.body.account.balance).toBe('210000');
    expect(
      await prisma.accountAdjustment.count({ where: { accountId: accountsA.mvola } }),
    ).toBe(2);
  });

  it('compte d’un autre utilisateur → 404', async () => {
    const res = await request(app)
      .patch(`/accounts/${accountsB.cash}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ targetBalance: '100' });
    expect(res.status).toBe(404);
  });
});

it('Total disponible : l’épargne (SAVINGS) est exclue', async () => {
  await postTx(tokenA, {
    type: 'INCOME',
    amount: '500000',
    occurredAt: '2026-09-03',
    allocations: [{ accountId: accountsA.savings, amount: '500000' }],
  });
  expect((await getAccount(tokenA, 'SAVINGS')).balance).toBe('500000');
  const dash = await request(app).get('/accounts').set('Authorization', `Bearer ${tokenA}`);
  expect(dash.body.totalAvailable).toBe('0');
});

describe('historique global', () => {
  it('ne montre que ses propres transactions', async () => {
    await postTx(tokenB, {
      type: 'INCOME',
      amount: '7000',
      occurredAt: '2026-09-03',
      allocations: [{ accountId: accountsB.cash, amount: '7000' }],
    });
    const listA = await getList(tokenA);
    expect(listA.status).toBe(200);
    expect(listA.body.transactions).toEqual([]);
    const listB = await getList(tokenB);
    expect(listB.body.transactions).toHaveLength(1);
    expectNoSecrets(listB.body);
  });

  it('tri stable : dates décroissantes, date inconnue en dernier', async () => {
    await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '100',
      description: 'Ancien',
      occurredAt: '2026-08-20',
      categoryId: categories.get('other')!.id,
      allocations: [{ accountId: accountsA.cash, amount: '100' }],
    });
    await postTx(tokenA, {
      type: 'INCOME',
      amount: '200',
      description: 'Récent',
      occurredAt: '2026-09-10',
      allocations: [{ accountId: accountsA.cash, amount: '200' }],
    });
    await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '300',
      description: 'Inconnue',
      dateUnknown: true,
      categoryId: categories.get('other')!.id,
      allocations: [{ accountId: accountsA.cash, amount: '300' }],
    });
    await postTx(tokenA, {
      type: 'EXPENSE',
      amount: '50',
      description: 'Moyen',
      occurredAt: '2026-09-01',
      categoryId: categories.get('other')!.id,
      allocations: [{ accountId: accountsA.cash, amount: '50' }],
    });
    const list = await getList(tokenA);
    const descriptions = (list.body.transactions as { description: string | null }[]).map(
      (t) => t.description,
    );
    expect(descriptions).toEqual(['Récent', 'Moyen', 'Ancien', 'Inconnue']);
  });

  it('pagination simple et hasMore', async () => {
    for (let i = 0; i < 25; i += 1) {
      await postTx(tokenA, {
        type: 'EXPENSE',
        amount: '100',
        dateUnknown: true,
        categoryId: categories.get('other')!.id,
        allocations: [{ accountId: accountsA.cash, amount: '100' }],
      });
    }
    const page1 = await getList(tokenA, '?page=1&limit=10');
    expect(page1.status).toBe(200);
    expect(page1.body.transactions).toHaveLength(10);
    expect(page1.body.hasMore).toBe(true);
    expect(page1.body.totals).toEqual({ incomes: '0', expenses: '2500' });
    const page3 = await getList(tokenA, '?page=3&limit=10');
    expect(page3.body.transactions).toHaveLength(5);
    expect(page3.body.hasMore).toBe(false);
    const bad = await getList(tokenA, '?limit=999');
    expect(bad.status).toBe(400);
  });
});
