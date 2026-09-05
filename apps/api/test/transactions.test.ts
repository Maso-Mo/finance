import { beforeEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';

const PASSWORD = 'correct-horse-battery-staple';
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';

let tokenA = '';
let tokenB = '';
let cashAId = '';
let bankAId = '';
let cashBId = '';

async function register(email: string): Promise<string> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: PASSWORD });
  expect(res.status).toBe(201);
  return res.body.accessToken as string;
}

async function accountIdOf(token: string, type: string): Promise<string> {
  const res = await request(app)
    .get('/accounts')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  const account = res.body.accounts.find(
    (a: { type: string }) => a.type === type,
  );
  return (account as { id: string }).id;
}

async function createTransaction(
  token: string,
  accountId: string,
  body: Record<string, unknown>,
) {
  return request(app)
    .post(`/accounts/${accountId}/transactions`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

async function getLedger(token: string, accountId: string) {
  return request(app)
    .get(`/accounts/${accountId}/transactions`)
    .set('Authorization', `Bearer ${token}`);
}

beforeAll(async () => {
  await prisma.refreshSession.deleteMany();
  await prisma.user.deleteMany();

  tokenA = await register('tx-a@example.com');
  tokenB = await register('tx-b@example.com');
  cashAId = await accountIdOf(tokenA, 'CASH');
  bankAId = await accountIdOf(tokenA, 'BANK');
  cashBId = await accountIdOf(tokenB, 'CASH');
});

beforeEach(async () => {
  // Base isolée et déterministe : aucun mouvement, soldes de départ à zéro.
  await prisma.transaction.deleteMany();
  await prisma.account.updateMany({ data: { initialBalance: '0' } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function expectNoSecrets(body: unknown): void {
  expect(JSON.stringify(body)).not.toContain('passwordHash');
}

describe('GET /accounts/:accountId/transactions', () => {
  it('non authentifié → 401', async () => {
    const res = await request(app).get(`/accounts/${cashAId}/transactions`);
    expect(res.status).toBe(401);
  });

  it('compte inconnu → 404', async () => {
    const res = await getLedger(tokenA, UNKNOWN_UUID);
    expect(res.status).toBe(404);
    expectNoSecrets(res.body);
  });

  it('le compte d’un autre utilisateur est invisible → 404', async () => {
    const res = await getLedger(tokenA, cashBId);
    expect(res.status).toBe(404);
  });

  it('journal vide : aucun mouvement, solde dérivé = solde de départ', async () => {
    const res = await getLedger(tokenA, cashAId);
    expect(res.status).toBe(200);
    expect(res.body.account.initialBalance).toBe('0');
    expect(res.body.account.balance).toBe('0');
    expect(res.body.transactions).toEqual([]);
    expect(res.body.totals).toEqual({ incomes: '0', expenses: '0' });
    expectNoSecrets(res.body);
  });
});

describe('POST /accounts/:accountId/transactions', () => {
  it('crée une dépense : solde du compte et totaux mis à jour', async () => {
    const created = await createTransaction(tokenA, cashAId, {
      type: 'EXPENSE',
      amount: '15000',
      description: 'Courses',
      occurredAt: '2026-09-04',
    });
    expect(created.status).toBe(201);
    expect(created.body.transaction).toMatchObject({
      accountId: cashAId,
      type: 'EXPENSE',
      amount: '15000',
      description: 'Courses',
      occurredAt: '2026-09-04',
    });
    expect(created.body.transaction.id).toBeTruthy();
    expectNoSecrets(created.body);

    const ledger = await getLedger(tokenA, cashAId);
    expect(ledger.body.account.balance).toBe('-15000');
    expect(ledger.body.totals).toEqual({ incomes: '0', expenses: '15000' });
    expect(ledger.body.transactions).toHaveLength(1);
  });

  it('crée un revenu : solde positif et total des revenus', async () => {
    const created = await createTransaction(tokenA, bankAId, {
      type: 'INCOME',
      amount: '250000',
      description: 'Salaire',
      occurredAt: '2026-09-01',
    });
    expect(created.status).toBe(201);

    const ledger = await getLedger(tokenA, bankAId);
    expect(ledger.body.account.balance).toBe('250000');
    expect(ledger.body.totals).toEqual({ incomes: '250000', expenses: '0' });
  });

  it('sans description ni date : valeurs par défaut acceptées', async () => {
    const created = await createTransaction(tokenA, cashAId, {
      type: 'INCOME',
      amount: '1000',
    });
    expect(created.status).toBe(201);
    expect(created.body.transaction.description).toBeNull();
    expect(created.body.transaction.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('le dashboard reflète les soldes dérivés (total hors épargne)', async () => {
    await createTransaction(tokenA, cashAId, {
      type: 'EXPENSE',
      amount: '30000',
      description: 'Loyer partiel',
    });
    await createTransaction(tokenA, bankAId, {
      type: 'INCOME',
      amount: '500000',
      description: 'Virement reçu',
    });
    // Épargne : une grosse dépense n’influence pas le Total disponible.
    const savingsAId = await accountIdOf(tokenA, 'SAVINGS');
    await createTransaction(tokenA, savingsAId, {
      type: 'EXPENSE',
      amount: '999999',
      description: 'Retrait épargne',
    });

    const dash = await request(app)
      .get('/accounts')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(dash.status).toBe(200);
    expect(dash.body.totalAvailable).toBe('470000'); // 500000 − 30000

    const cash = dash.body.accounts.find(
      (a: { type: string }) => a.type === 'CASH',
    );
    const bank = dash.body.accounts.find(
      (a: { type: string }) => a.type === 'BANK',
    );
    const savings = dash.body.accounts.find(
      (a: { type: string }) => a.type === 'SAVINGS',
    );
    expect(cash.balance).toBe('-30000');
    expect(bank.balance).toBe('500000');
    expect(savings.balance).toBe('-999999'); // compté pour SON solde…
  });

  it('le total disponible tient compte du solde de départ + du journal', async () => {
    await request(app)
      .patch(`/accounts/${cashAId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ initialBalance: '100000' });
    await createTransaction(tokenA, cashAId, {
      type: 'EXPENSE',
      amount: '40000',
      description: 'Achat',
    });

    const ledger = await getLedger(tokenA, cashAId);
    expect(ledger.body.account.initialBalance).toBe('100000');
    expect(ledger.body.account.balance).toBe('60000');

    const dash = await request(app)
      .get('/accounts')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(dash.body.totalAvailable).toBe('60000');
  });

  it('invalide : montants interdits → 400', async () => {
    for (const amount of ['0', '0.00', '-15000', 'abc', '1.234', 'Infinity', '']) {
      const res = await createTransaction(tokenA, cashAId, {
        type: 'EXPENSE',
        amount,
      });
      expect(res.status, `amount=${JSON.stringify(amount)}`).toBe(400);
    }
  });

  it('invalide : type, description ou date invalides → 400', async () => {
    const cases: Record<string, unknown>[] = [
      { type: 'TRANSFER', amount: '100' },
      { type: 'EXPENSE', amount: '100', description: '   ' },
      { type: 'EXPENSE', amount: '100', description: 'x'.repeat(121) },
      { type: 'EXPENSE', amount: '100', occurredAt: '2026-13-40' },
      { type: 'EXPENSE', amount: '100', occurredAt: '2026-02-31' },
      { type: 'EXPENSE', amount: '100', occurredAt: '04/09/2026' },
    ];
    for (const body of cases) {
      const res = await createTransaction(tokenA, cashAId, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('on ne peut pas écrire sur le compte d’un autre utilisateur → 404', async () => {
    const res = await createTransaction(tokenA, cashBId, {
      type: 'INCOME',
      amount: '500',
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /accounts/:accountId/transactions/:transactionId', () => {
  it('supprime sa propre opération et recale le solde', async () => {
    const created = await createTransaction(tokenA, cashAId, {
      type: 'EXPENSE',
      amount: '5000',
      description: 'Transport',
      occurredAt: '2026-09-03',
    });
    const transactionId = created.body.transaction.id as string;

    const del = await request(app)
      .delete(`/accounts/${cashAId}/transactions/${transactionId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(del.status).toBe(204);

    const ledger = await getLedger(tokenA, cashAId);
    expect(ledger.body.transactions).toEqual([]);
    expect(ledger.body.account.balance).toBe('0');
    expect(ledger.body.totals).toEqual({ incomes: '0', expenses: '0' });
  });

  it('opération déjà supprimée ou inconnue → 404', async () => {
    const del = await request(app)
      .delete(`/accounts/${cashAId}/transactions/${UNKNOWN_UUID}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(del.status).toBe(404);
  });

  it('on ne peut pas supprimer l’opération d’un autre utilisateur → 404', async () => {
    const created = await createTransaction(tokenB, cashBId, {
      type: 'INCOME',
      amount: '7000',
    });
    const transactionId = created.body.transaction.id as string;

    const del = await request(app)
      .delete(`/accounts/${cashBId}/transactions/${transactionId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(del.status).toBe(404);

    // L'opération de B est toujours là.
    const ledgerB = await getLedger(tokenB, cashBId);
    expect(ledgerB.body.transactions).toHaveLength(1);
  });
});

describe('tri du journal', () => {
  it('liste triée de la date la plus récente à la plus ancienne', async () => {
    await createTransaction(tokenA, cashAId, {
      type: 'EXPENSE',
      amount: '100',
      description: 'Ancien',
      occurredAt: '2026-08-20',
    });
    await createTransaction(tokenA, cashAId, {
      type: 'INCOME',
      amount: '200',
      description: 'Récent',
      occurredAt: '2026-09-05',
    });
    await createTransaction(tokenA, cashAId, {
      type: 'EXPENSE',
      amount: '300',
      description: 'Moyen',
      occurredAt: '2026-09-01',
    });

    const ledger = await getLedger(tokenA, cashAId);
    const descriptions = ledger.body.transactions.map(
      (t: { description: string }) => t.description,
    );
    expect(descriptions).toEqual(['Récent', 'Moyen', 'Ancien']);
  });
});
