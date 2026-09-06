import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';

/**
 * TRANSFERTS INTERNES RÉELS (étape 9) — API.
 *
 * ⚠ INVARIANT ABSOLU : un transfert n'est NI une Transaction EXPENSE sur la
 * source NI une Transaction INCOME sur la destination. Créer/modifier/supprimer
 * un Transfer ne touche JAMAIS la table des transactions (testé ici), ni les
 * budgets (`spent`), ni le `spendingForecast`, ni les PlannedExpense /
 * ExpectedIncome. Seuls les soldes courants dérivés en tiennent compte.
 *
 * Règle financière V1 : source −(amount + fee), destination +amount, fee
 * toujours prélevé EN PLUS sur la source.
 */

const PASSWORD = 'correct-horse-battery-staple';
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';

type AccountIds = {
  cash: string;
  bank: string;
  mvola: string;
  orange: string;
  airtel: string;
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
    orange: by('ORANGE_MONEY'),
    airtel: by('AIRTEL_MONEY'),
    savings: by('SAVINGS'),
  };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function postTransfer(token: string, body: Record<string, unknown>) {
  return request(app).post('/transfers').set(auth(token)).send(body);
}
function patchTransfer(token: string, id: string, body: Record<string, unknown>) {
  return request(app).patch(`/transfers/${id}`).set(auth(token)).send(body);
}
function delTransfer(token: string, id: string) {
  return request(app).delete(`/transfers/${id}`).set(auth(token));
}
function getTransfers(token: string, query = '') {
  return request(app).get(`/transfers${query}`).set(auth(token));
}
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
  const res = await request(app).get('/accounts').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body as {
    currency: string;
    totalAvailable: string;
  };
}
/** Solde connu visé via l'API (aucun mouvement → initialBalance). */
async function fund(token: string, accountId: string, amount: string) {
  const res = await request(app)
    .patch(`/accounts/${accountId}`)
    .set(auth(token))
    .send({ targetBalance: amount });
  expect(res.status).toBe(200);
}
async function getForecast(token: string, query = '') {
  const res = await request(app)
    .get(`/forecast${query}`)
    .set(auth(token));
  expect(res.status).toBe(200);
  return res.body as {
    availableToday: string;
    monthEndAvailableForecast: string;
  };
}
async function getBudgetView(token: string, query = '') {
  const res = await request(app)
    .get(`/budgets${query}`)
    .set(auth(token));
  expect(res.status).toBe(200);
  return res.body as { spent: string; spendingForecast: string };
}


function baseTransfer(overrides: Record<string, unknown> = {}) {
  return {
    sourceAccountId: accountsA.mvola,
    destinationAccountId: accountsA.cash,
    amount: '100000',
    feeAmount: '0',
    occurredAt: '2026-09-06',
    ...overrides,
  };
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
  await prisma.accountTransfer.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.user.deleteMany();

  tokenA = await register('transfer-a@example.com');
  tokenB = await register('transfer-b@example.com');
  accountsA = await idsOf(tokenA);
  accountsB = await idsOf(tokenB);
});

beforeEach(async () => {
  await prisma.debtSettlement.deleteMany();
  await prisma.debt.deleteMany();
  await prisma.transactionAccountAllocation.deleteMany();
  await prisma.accountAdjustment.deleteMany();
  await prisma.accountTransfer.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.plannedExpense.deleteMany();
  await prisma.expectedIncome.deleteMany();
  await prisma.monthlyBudget.deleteMany();
  await prisma.account.updateMany({ data: { initialBalance: '0' } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Contrat & création', () => {
  it('GET /transfers sans authentification → 401', async () => {
    const res = await request(app).get('/transfers');
    expect(res.status).toBe(401);
  });

  it('crée un transfert simple (source −amount, destination +amount)', async () => {
    await fund(tokenA, accountsA.mvola, '500000');
    await fund(tokenA, accountsA.cash, '100000');
    const res = await postTransfer(tokenA, baseTransfer());
    expect(res.status).toBe(201);
    expect(res.body.transfer.amount).toBe('100000');
    expect(res.body.transfer.feeAmount).toBe('0');
    expect(res.body.transfer.source.type).toBe('MVOLA');
    expect(res.body.transfer.destination.type).toBe('CASH');
    expect(res.body.transfer.occurredAt).toBe('2026-09-06');
    expect(res.body.transfer.dateUnknown).toBe(false);
    expect((await getAccount(tokenA, 'MVOLA')).balance).toBe('400000');
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('200000');
  });

  it('crée un transfert avec frais (fee prélevé EN PLUS sur la source)', async () => {
    await fund(tokenA, accountsA.mvola, '500000');
    const res = await postTransfer(
      tokenA,
      baseTransfer({ feeAmount: '2500' }),
    );
    expect(res.status).toBe(201);
    expect(res.body.transfer.feeAmount).toBe('2500');
    expect((await getAccount(tokenA, 'MVOLA')).balance).toBe('397500');
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('100000');
  });

  it('date inconnue explicite → occurredAt null, dateUnknown true', async () => {
    const res = await postTransfer(
      tokenA,
      baseTransfer({ occurredAt: undefined, dateUnknown: true }),
    );
    expect(res.status).toBe(201);
    expect(res.body.transfer.occurredAt).toBeNull();
    expect(res.body.transfer.dateUnknown).toBe(true);
  });

  it('refuse les montants invalides (0, négatif, NaN, fee négatif)', async () => {
    expect((await postTransfer(tokenA, baseTransfer({ amount: '0' }))).status).toBe(400);
    expect((await postTransfer(tokenA, baseTransfer({ amount: '-100' }))).status).toBe(400);
    expect((await postTransfer(tokenA, baseTransfer({ amount: 'abc' }))).status).toBe(400);
    expect((await postTransfer(tokenA, baseTransfer({ feeAmount: '-1' }))).status).toBe(400);
    expect((await postTransfer(tokenA, baseTransfer({ feeAmount: '1.234' }))).status).toBe(400);
  });

  it('refuse source = destination', async () => {
    const res = await postTransfer(
      tokenA,
      baseTransfer({ destinationAccountId: accountsA.mvola }),
    );
    expect(res.status).toBe(400);
  });

  it('refuse une source appartenant à un autre utilisateur → 404', async () => {
    const res = await postTransfer(
      tokenA,
      baseTransfer({ sourceAccountId: accountsB.cash }),
    );
    expect(res.status).toBe(404);
  });

  it('refuse une destination appartenant à un autre utilisateur → 404', async () => {
    const res = await postTransfer(
      tokenA,
      baseTransfer({ destinationAccountId: accountsB.cash }),
    );
    expect(res.status).toBe(404);
  });

  it('refuse une date absente ambiguë (ni occurredAt ni dateUnknown)', async () => {
    const res = await postTransfer(
      tokenA,
      baseTransfer({ occurredAt: undefined }),
    );
    expect(res.status).toBe(400);
  });

  it('refuse occurredAt ET dateUnknown simultanés', async () => {
    const res = await postTransfer(
      tokenA,
      baseTransfer({ occurredAt: '2026-09-06', dateUnknown: true }),
    );
    expect(res.status).toBe(400);
  });

  it('refuse une date calendrier invalide', async () => {
    const res = await postTransfer(
      tokenA,
      baseTransfer({ occurredAt: '2026-02-31' }),
    );
    expect(res.status).toBe(400);
  });
});

describe('Historique', () => {
  it('liste uniquement ses propres transferts', async () => {
    await postTransfer(tokenA, baseTransfer());
    await postTransfer(tokenB, {
      sourceAccountId: accountsB.cash,
      destinationAccountId: accountsB.bank,
      amount: '5000',
      occurredAt: '2026-09-05',
    });
    const listA = await getTransfers(tokenA);
    expect(listA.status).toBe(200);
    expect(listA.body.transfers).toHaveLength(1);
    const listB = await getTransfers(tokenB);
    expect(listB.body.transfers).toHaveLength(1);
  });

  it('tri stable : date récente d’abord, date inconnue en dernier', async () => {
    await postTransfer(tokenA, baseTransfer({ occurredAt: '2026-08-01' }));
    await postTransfer(
      tokenA,
      baseTransfer({
        sourceAccountId: accountsA.cash,
        destinationAccountId: accountsA.bank,
        amount: '200',
        occurredAt: undefined,
        dateUnknown: true,
      }),
    );
    await postTransfer(tokenA, baseTransfer({ amount: '300', occurredAt: '2026-09-10' }));
    const list = await getTransfers(tokenA);
    const amounts = (list.body.transfers as { amount: string }[]).map(
      (t) => t.amount,
    );
    expect(amounts).toEqual(['300', '100000', '200']);
  });

  it('pagination simple et limite maximale raisonnable', async () => {
    for (let i = 0; i < 25; i += 1) {
      await postTransfer(
        tokenA,
        baseTransfer({
          sourceAccountId: accountsA.cash,
          destinationAccountId: accountsA.bank,
          amount: '100',
          occurredAt: undefined,
          dateUnknown: true,
        }),
      );
    }
    const page1 = await getTransfers(tokenA, '?page=1&limit=10');
    expect(page1.status).toBe(200);
    expect(page1.body.transfers).toHaveLength(10);
    expect(page1.body.hasMore).toBe(true);
    const page3 = await getTransfers(tokenA, '?page=3&limit=10');
    expect(page3.body.transfers).toHaveLength(5);
    expect(page3.body.hasMore).toBe(false);
    expect((await getTransfers(tokenA, '?limit=999')).status).toBe(400);
  });


describe('Modification (PATCH) et suppression logique', () => {
  async function create(overrides: Record<string, unknown> = {}) {
    const res = await postTransfer(tokenA, baseTransfer(overrides));
    expect(res.status).toBe(201);
    return res.body.transfer as { id: string };
  }

  it('PATCH amount : les soldes sont recalculés atomiquement', async () => {
    await fund(tokenA, accountsA.mvola, '500000');
    const created = await create();
    const patch = await patchTransfer(tokenA, created.id, {
      ...baseTransfer({ amount: '250000' }),
    });
    expect(patch.status).toBe(200);
    expect(patch.body.transfer.amount).toBe('250000');
    expect((await getAccount(tokenA, 'MVOLA')).balance).toBe('250000');
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('250000');
  });

  it('PATCH fee : le débit source reflète immédiatement le nouveau fee', async () => {
    await fund(tokenA, accountsA.mvola, '500000');
    const created = await create();
    const patch = await patchTransfer(tokenA, created.id, {
      ...baseTransfer({ feeAmount: '2500' }),
    });
    expect(patch.status).toBe(200);
    expect(patch.body.transfer.feeAmount).toBe('2500');
    expect((await getAccount(tokenA, 'MVOLA')).balance).toBe('397500');
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('100000');
  });

  it('PATCH source/destination : l’ancien transfert est remplacé', async () => {
    await fund(tokenA, accountsA.mvola, '500000');
    await fund(tokenA, accountsA.cash, '300000');
    const created = await create();
    const patch = await patchTransfer(tokenA, created.id, {
      sourceAccountId: accountsA.cash,
      destinationAccountId: accountsA.mvola,
      amount: '40000',
      occurredAt: '2026-09-08',
    });
    expect(patch.status).toBe(200);
    expect(patch.body.transfer.source.type).toBe('CASH');
    expect(patch.body.transfer.destination.type).toBe('MVOLA');
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('260000');
    expect((await getAccount(tokenA, 'MVOLA')).balance).toBe('540000');
  });

  it('PATCH ne peut pas viser un compte d’un autre utilisateur', async () => {
    const created = await create();
    const res = await patchTransfer(tokenA, created.id, {
      ...baseTransfer({ destinationAccountId: accountsB.cash }),
    });
    expect(res.status).toBe(404);
  });

  it('DELETE soft-delete : disparaît de l’historique, soldes restaurés', async () => {
    await fund(tokenA, accountsA.mvola, '500000');
    const created = await create();
    const del = await delTransfer(tokenA, created.id);
    expect(del.status).toBe(204);
    const list = await getTransfers(tokenA);
    expect(list.body.transfers).toHaveLength(0);
    expect((await getAccount(tokenA, 'MVOLA')).balance).toBe('500000');
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('0');
  });

  it('un transfert supprimé n’est plus modifiable (409)', async () => {
    const created = await create();
    await delTransfer(tokenA, created.id);
    const patch = await patchTransfer(tokenA, created.id, {
      ...baseTransfer(),
    });
    expect(patch.status).toBe(409);
    const delAgain = await delTransfer(tokenA, created.id);
    expect(delAgain.status).toBe(404);
  });

  it('PATCH/DELETE d’un transfert d’un autre utilisateur → 404', async () => {
    const created = await create();
    const patchB = await patchTransfer(tokenB, created.id, {
      ...baseTransfer(),
    });
    expect(patchB.status).toBe(404);
    const delB = await delTransfer(tokenB, created.id);
    expect(delB.status).toBe(404);
  });
});

  it('GET /transfers est strictement read-only (aucune écriture)', async () => {
    await fund(tokenA, accountsA.mvola, '100000');
    const before = await getAccount(tokenA, 'MVOLA');
    await getTransfers(tokenA);
    await getTransfers(tokenA, '?page=1&limit=50');
    const after = await getAccount(tokenA, 'MVOLA');
    expect(after.balance).toBe(before.balance);
  });
});


describe('Soldes et Total disponible', () => {
  it('CAS A — MVola → Cash sans frais : Total disponible inchangé', async () => {
    await fund(tokenA, accountsA.mvola, '500000');
    await fund(tokenA, accountsA.cash, '100000');
    const before = await getDashboard(tokenA);
    const res = await postTransfer(
      tokenA,
      baseTransfer({ feeAmount: '0' }),
    );
    expect(res.status).toBe(201);
    const after = await getDashboard(tokenA);
    expect((await getAccount(tokenA, 'MVOLA')).balance).toBe('400000');
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('200000');
    expect(before.totalAvailable).toBe('600000');
    expect(after.totalAvailable).toBe('600000');
  });

  it('CAS B — MVola → Cash avec 2 500 de frais : Total −2 500 seulement', async () => {
    await fund(tokenA, accountsA.mvola, '500000');
    await fund(tokenA, accountsA.cash, '100000');
    const before = await getDashboard(tokenA);
    const res = await postTransfer(
      tokenA,
      baseTransfer({ feeAmount: '2500' }),
    );
    expect(res.status).toBe(201);
    const after = await getDashboard(tokenA);
    expect((await getAccount(tokenA, 'MVOLA')).balance).toBe('397500');
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('200000');
    expect(before.totalAvailable).toBe('600000');
    expect(after.totalAvailable).toBe('597500');
  });

  it('CAS C — Cash → Épargne : le Total disponible diminue du principal', async () => {
    await fund(tokenA, accountsA.cash, '500000');
    await fund(tokenA, accountsA.savings, '100000');
    const before = await getDashboard(tokenA);
    const res = await postTransfer(
      tokenA,
      baseTransfer({
        sourceAccountId: accountsA.cash,
        destinationAccountId: accountsA.savings,
        feeAmount: '0',
      }),
    );
    expect(res.status).toBe(201);
    const after = await getDashboard(tokenA);
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('400000');
    expect((await getAccount(tokenA, 'SAVINGS')).balance).toBe('200000');
    expect(before.totalAvailable).toBe('500000');
    expect(after.totalAvailable).toBe('400000');
  });

  it('CAS D — Épargne → Cash : le Total disponible augmente du principal', async () => {
    await fund(tokenA, accountsA.savings, '300000');
    await fund(tokenA, accountsA.cash, '100000');
    const before = await getDashboard(tokenA);
    const res = await postTransfer(
      tokenA,
      baseTransfer({
        sourceAccountId: accountsA.savings,
        destinationAccountId: accountsA.cash,
        feeAmount: '2500',
      }),
    );
    expect(res.status).toBe(201);
    const after = await getDashboard(tokenA);
    expect((await getAccount(tokenA, 'SAVINGS')).balance).toBe('197500');
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('200000');
    expect(before.totalAvailable).toBe('100000');
    expect(after.totalAvailable).toBe('200000');
  });

  it('soft-delete d’un transfert vers l’Épargne restaure le Total disponible', async () => {
    await fund(tokenA, accountsA.cash, '500000');
    const created = (
      await postTransfer(
        tokenA,
        baseTransfer({
          sourceAccountId: accountsA.cash,
          destinationAccountId: accountsA.savings,
        }),
      )
    ).body.transfer as { id: string };
    expect((await getDashboard(tokenA)).totalAvailable).toBe('400000');
    await delTransfer(tokenA, created.id);
    expect((await getDashboard(tokenA)).totalAvailable).toBe('500000');
  });

  it('modification d’un transfert vers l’Épargne recalcule le Total disponible', async () => {
    await fund(tokenA, accountsA.cash, '500000');
    const created = (
      await postTransfer(
        tokenA,
        baseTransfer({
          sourceAccountId: accountsA.cash,
          destinationAccountId: accountsA.savings,
          amount: '100000',
        }),
      )
    ).body.transfer as { id: string };
    const patch = await patchTransfer(tokenA, created.id, {
      ...baseTransfer({
        sourceAccountId: accountsA.cash,
        destinationAccountId: accountsA.savings,
        amount: '150000',
      }),
    });
    expect(patch.status).toBe(200);
    expect((await getDashboard(tokenA)).totalAvailable).toBe('350000');
  });

  it('aucun champ balance mutable ajouté au contrat des comptes', async () => {
    const res = await request(app)
      .get('/accounts')
      .set(auth(tokenA));
    const account = (res.body.accounts as Record<string, unknown>[])[0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(account).sort()).toEqual([
      'balance',
      'currency',
      'id',
      'initialBalance',
      'type',
    ]);
  });
});


describe('Anti-pollution du journal (aucune Transaction EXPENSE/INCOME)', () => {
  it('POST/PATCH/DELETE d’un Transfer ne change JAMAIS le nombre de Transactions', async () => {
    await fund(tokenA, accountsA.mvola, '500000');
    const before = await prisma.transaction.count();
    const created = (
      await postTransfer(tokenA, baseTransfer({ feeAmount: '2500' }))
    ).body.transfer as { id: string };
    expect(await prisma.transaction.count()).toBe(before);

    await patchTransfer(tokenA, created.id, {
      ...baseTransfer({ amount: '75000', feeAmount: '1000' }),
    });
    expect(await prisma.transaction.count()).toBe(before);

    await delTransfer(tokenA, created.id);
    expect(await prisma.transaction.count()).toBe(before);
  });

  it('un Transfer ne crée jamais de catégorie « frais de transfert »', async () => {
    const before = await prisma.category.count();
    await postTransfer(tokenA, baseTransfer({ feeAmount: '2500' }));
    expect(await prisma.category.count()).toBe(before);
  });
});

describe('Budgets — un Transfer n’impacte ni spent ni spendingForecast', () => {
  it('création, modification et suppression d’un Transfer laissent spent et spendingForecast identiques', async () => {
    const budgetQuery = '?month=2026-09&today=2026-09-20';
    const before = await getBudgetView(tokenA, budgetQuery);
    const created = (
      await postTransfer(tokenA, baseTransfer({ feeAmount: '2500' }))
    ).body.transfer as { id: string };

    const afterCreate = await getBudgetView(tokenA, budgetQuery);
    expect(afterCreate.spent).toBe(before.spent);
    expect(afterCreate.spendingForecast).toBe(before.spendingForecast);

    await patchTransfer(tokenA, created.id, {
      ...baseTransfer({ amount: '50000' }),
    });
    const afterPatch = await getBudgetView(tokenA, budgetQuery);
    expect(afterPatch.spent).toBe(before.spent);
    expect(afterPatch.spendingForecast).toBe(before.spendingForecast);

    await delTransfer(tokenA, created.id);
    const afterDelete = await getBudgetView(tokenA, budgetQuery);
    expect(afterDelete.spent).toBe(before.spent);
    expect(afterDelete.spendingForecast).toBe(before.spendingForecast);
  });
});
describe('Prévision financière — impact uniquement via availableToday', () => {
  const FORECAST = '?today=2026-09-20';

  it('disponible → disponible sans frais : forecast inchangé', async () => {
    await fund(tokenA, accountsA.mvola, '500000');
    const before = await getForecast(tokenA, FORECAST);
    await postTransfer(tokenA, baseTransfer({ feeAmount: '0' }));
    const after = await getForecast(tokenA, FORECAST);
    expect(after.availableToday).toBe(before.availableToday);
    expect(after.monthEndAvailableForecast).toBe(before.monthEndAvailableForecast);
  });

  it('disponible → disponible avec frais : forecast −fee', async () => {
    await fund(tokenA, accountsA.mvola, '500000');
    await fund(tokenA, accountsA.cash, '100000');
    const before = await getForecast(tokenA, FORECAST);
    expect(before.availableToday).toBe('600000');
    await postTransfer(tokenA, baseTransfer({ feeAmount: '2500' }));
    const after = await getForecast(tokenA, FORECAST);
    expect(after.availableToday).toBe('597500');
    // Aucun PlannedExpense/ExpectedIncome : forecast = availableToday.
    expect(after.monthEndAvailableForecast).toBe('597500');
  });

  it('disponible → Épargne : forecast diminue selon le nouveau availableToday', async () => {
    await fund(tokenA, accountsA.cash, '500000');
    await postTransfer(
      tokenA,
      baseTransfer({
        sourceAccountId: accountsA.cash,
        destinationAccountId: accountsA.savings,
        feeAmount: '2500',
      }),
    );
    const after = await getForecast(tokenA, FORECAST);
    expect(after.availableToday).toBe('397500');
  });

  it('Épargne → disponible : forecast augmente selon le nouveau availableToday', async () => {
    await fund(tokenA, accountsA.savings, '300000');
    await fund(tokenA, accountsA.cash, '100000');
    await postTransfer(
      tokenA,
      baseTransfer({
        sourceAccountId: accountsA.savings,
        destinationAccountId: accountsA.cash,
        feeAmount: '2500',
      }),
    );
    const after = await getForecast(tokenA, FORECAST);
    expect(after.availableToday).toBe('200000');
  });

  it('aucune PlannedExpense ni ExpectedIncome modifiée par POST/PATCH/DELETE', async () => {
    const plannedBefore = await prisma.plannedExpense.count();
    const incomeBefore = await prisma.expectedIncome.count();
    const created = (
      await postTransfer(tokenA, baseTransfer({ feeAmount: '2500' }))
    ).body.transfer as { id: string };
    await patchTransfer(tokenA, created.id, { ...baseTransfer({ amount: '50' }) });
    await delTransfer(tokenA, created.id);
    expect(await prisma.plannedExpense.count()).toBe(plannedBefore);
    expect(await prisma.expectedIncome.count()).toBe(incomeBefore);
  });
});

describe('Correction de solde (AccountAdjustment) et transferts', () => {
  it('compte SANS mouvement → targetBalance peut modifier initialBalance', async () => {
    const res = await request(app)
      .patch(`/accounts/${accountsA.cash}`)
      .set(auth(tokenA))
      .send({ targetBalance: '100000' });
    expect(res.status).toBe(200);
    const account = await getAccount(tokenA, 'CASH');
    expect(account.initialBalance).toBe('100000');
    expect(await prisma.accountAdjustment.count()).toBe(0);
  });

  it('après un Transfer actif → targetBalance crée un AccountAdjustment (initialBalance intact)', async () => {
    // Cash 100 000 (initial) puis Transfer sortant 20 000 → solde 80 000.
    await fund(tokenA, accountsA.cash, '100000');
    await postTransfer(
      tokenA,
      baseTransfer({
        sourceAccountId: accountsA.cash,
        destinationAccountId: accountsA.mvola,
        amount: '20000',
      }),
    );
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('80000');

    // « Le solde réel de Cash est 90 000 ».
    const res = await request(app)
      .patch(`/accounts/${accountsA.cash}`)
      .set(auth(tokenA))
      .send({ targetBalance: '90000' });
    expect(res.status).toBe(200);

    const account = await getAccount(tokenA, 'CASH');
    // initialBalance ne change PLUS (mouvement = transfert actif).
    expect(account.initialBalance).toBe('100000');
    // Le solde courant atteint exactement la cible demandée.
    expect(account.balance).toBe('90000');
    expect(await prisma.accountAdjustment.count()).toBe(1);
  });
});
