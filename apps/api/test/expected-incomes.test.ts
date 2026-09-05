import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import {
  expectedIncomeMutationResponseSchema,
  expectedIncomesResponseSchema,
  type ExpectedIncomePublic,
} from '@finance/shared-types';

const PASSWORD = 'correct-horse-battery-staple';

type AccountIds = {
  cash: string;
  bank: string;
  mvola: string;
  savings: string;
};

let tokenA = '';
let tokenB = '';
let accountsA: AccountIds;

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

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function getAccount(token: string, type: string) {
  const res = await request(app).get('/accounts').set(auth(token));
  expect(res.status).toBe(200);
  return (
    res.body.accounts as {
      type: string;
      balance: string;
      initialBalance: string;
    }[]
  ).find((a) => a.type === type)!;
}

function getIncomes(token: string, query = '') {
  return request(app).get(`/expected-incomes${query}`).set(auth(token));
}

function postIncome(token: string, body: Record<string, unknown>) {
  return request(app).post('/expected-incomes').set(auth(token)).send(body);
}

function patchIncome(token: string, id: string, body: Record<string, unknown>) {
  return request(app).patch(`/expected-incomes/${id}`).set(auth(token)).send(body);
}

function deleteIncome(token: string, id: string) {
  return request(app).delete(`/expected-incomes/${id}`).set(auth(token));
}

function confirmReceived(token: string, id: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/expected-incomes/${id}/confirm-received`)
    .set(auth(token))
    .send(body);
}

function getIncomeReminders(token: string, query = '') {
  return request(app).get(`/income-reminders${query}`).set(auth(token));
}

beforeAll(async () => {
  await prisma.expectedIncome.deleteMany();
  await prisma.plannedExpense.deleteMany();
  await prisma.recurringExpenseRule.deleteMany();
  await prisma.transactionAccountAllocation.deleteMany();
  await prisma.accountAdjustment.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.user.deleteMany();

  tokenA = await register('income-a@example.com');
  tokenB = await register('income-b@example.com');
  accountsA = await idsOf(tokenA);
});

beforeEach(async () => {
  await prisma.expectedIncome.deleteMany();
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

/** Valide une réponse de mutation sur le schéma partagé → type exact. */
function incomeOf(body: unknown): ExpectedIncomePublic {
  return expectedIncomeMutationResponseSchema.parse(body).expectedIncome;
}

function lastOf(body: unknown): ExpectedIncomePublic[] {
  return expectedIncomesResponseSchema.parse(body).expectedIncomes;
}

async function seedCash(amount: string): Promise<void> {
  await prisma.account.update({
    where: { id: accountsA.cash },
    data: { initialBalance: amount },
  });
}
describe('CRUD des revenus futurs', () => {
  it('12. crée un revenu CONFIRMED à date EXACTE (PENDING, aucun impact)', async () => {
    const res = await postIncome(tokenA, {
      amount: '500000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
      description: 'Salaire',
    });
    expect(res.status).toBe(201);
    const item = incomeOf(res.body);
    expect(item.amount).toBe('500000');
    expect(item.certainty).toBe('CONFIRMED');
    expect(item.status).toBe('PENDING');
    expect(item.expectedDate).toBe('2026-10-05');
    expect(item.windowStart).toBeNull();
    expect(item.windowEnd).toBeNull();
    expect(item.receivedTransactionId).toBeNull();
    expect(item.receivedTransaction).toBeNull();
    expect(item.currency).toBe('MGA');
    expectNoSecrets(res.body);
  });

  it('13. crée un revenu UNCERTAIN à date EXACTE', async () => {
    const res = await postIncome(tokenA, {
      amount: '150000',
      certainty: 'UNCERTAIN',
      expectedDate: '2026-10-20',
      description: 'Bonus éventuel',
    });
    expect(res.status).toBe(201);
    const item = incomeOf(res.body);
    expect(item.certainty).toBe('UNCERTAIN');
    expect(item.status).toBe('PENDING');
    expect(item.expectedDate).toBe('2026-10-20');
  });

  it('14. crée un revenu CONFIRMED en PLAGE (start/end stockés tels quels)', async () => {
    const res = await postIncome(tokenA, {
      amount: '300000',
      certainty: 'CONFIRMED',
      windowStart: '2026-10-20',
      windowEnd: '2026-10-27',
      description: 'Paiement client',
    });
    expect(res.status).toBe(201);
    const item = incomeOf(res.body);
    expect(item.expectedDate).toBeNull();
    expect(item.windowStart).toBe('2026-10-20');
    expect(item.windowEnd).toBe('2026-10-27');
    expect(item.status).toBe('PENDING');
    // Aucune date « inventée » dans la plage.
    expect(item.expectedDate).toBeNull();
  });

  it('15. crée un revenu UNCERTAIN en PLAGE', async () => {
    const res = await postIncome(tokenA, {
      amount: '80000',
      certainty: 'UNCERTAIN',
      windowStart: '2026-10-01',
      windowEnd: '2026-10-15',
      description: 'Vente éventuelle',
    });
    expect(res.status).toBe(201);
    const item = incomeOf(res.body);
    expect(item.certainty).toBe('UNCERTAIN');
    expect(item.windowStart).toBe('2026-10-01');
    expect(item.windowEnd).toBe('2026-10-15');
  });

  it('16. montant invalide → 400', async () => {
    for (const bad of ['0', '-5', 'abc', '1.234', '']) {
      const res = await postIncome(tokenA, {
        amount: bad,
        certainty: 'CONFIRMED',
        expectedDate: '2026-10-05',
      });
      expect(res.status, `amount=${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('17. date exacte invalide (2026-02-31) → 400', async () => {
    const res = await postIncome(tokenA, {
      amount: '10000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-02-31',
    });
    expect(res.status).toBe(400);
  });

  it('18. plage invalide (start > end ou incomplète) → 400', async () => {
    expect(
      (
        await postIncome(tokenA, {
          amount: '10000',
          certainty: 'CONFIRMED',
          windowStart: '2026-10-27',
          windowEnd: '2026-10-20',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await postIncome(tokenA, {
          amount: '10000',
          certainty: 'CONFIRMED',
          windowStart: '2026-10-20',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await postIncome(tokenA, {
          amount: '10000',
          certainty: 'CONFIRMED',
          windowEnd: '2026-10-27',
        })
      ).status,
    ).toBe(400);
  });

  it('19. date exacte + plage SIMULTANÉES → 400', async () => {
    const res = await postIncome(tokenA, {
      amount: '10000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-23',
      windowStart: '2026-10-20',
      windowEnd: '2026-10-27',
    });
    expect(res.status).toBe(400);
  });

  it('20. AUCUNE indication temporelle → 400 (V1)', async () => {
    const res = await postIncome(tokenA, {
      amount: '10000',
      certainty: 'CONFIRMED',
    });
    expect(res.status).toBe(400);
  });

  it('21. utilisateur B ne lit pas les revenus de A (ni ne les modifie)', async () => {
    const created = await postIncome(tokenA, {
      amount: '500000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
    });
    const id = (created.body.expectedIncome as { id: string }).id;

    const listB = await getIncomes(tokenB, '?today=2026-10-20');
    expect(listB.status).toBe(200);
    expect(
      (listB.body.expectedIncomes as { id: string }[]).some((i) => i.id === id),
    ).toBe(false);

    expect(
      (
        await patchIncome(tokenB, id, {
          amount: '1',
          certainty: 'UNCERTAIN',
          expectedDate: '2026-10-05',
        })
      ).status,
    ).toBe(404);
    expect((await deleteIncome(tokenB, id)).status).toBe(404);
    expect(
      (
        await confirmReceived(tokenB, id, {
          amount: '1',
          occurredAt: '2026-10-05',
          accountUnknown: true,
        })
      ).status,
    ).toBe(404);

    // Intact pour A.
    const after = await getIncomes(tokenA);
    expect(
      (after.body.expectedIncomes as { id: string }[]).some((i) => i.id === id),
    ).toBe(true);
  });
  it('22. modification d’un revenu PENDING (montant, certitude, forme temporelle)', async () => {
    const created = await postIncome(tokenA, {
      amount: '500000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
      description: 'Salaire',
    });
    const id = (created.body.expectedIncome as { id: string }).id;

    // Bascule date exacte → plage, certitude changée.
    const patched = await patchIncome(tokenA, id, {
      amount: '520000',
      certainty: 'UNCERTAIN',
      windowStart: '2026-10-04',
      windowEnd: '2026-10-08',
      description: 'Salaire + bonus ?',
    });
    expect(patched.status).toBe(200);
    const item = incomeOf(patched.body);
    expect(item.amount).toBe('520000');
    expect(item.certainty).toBe('UNCERTAIN');
    expect(item.expectedDate).toBeNull();
    expect(item.windowStart).toBe('2026-10-04');
    expect(item.windowEnd).toBe('2026-10-08');
    expect(item.description).toBe('Salaire + bonus ?');
    expect(item.status).toBe('PENDING');
  });

  it('23. annulation d’un PENDING → CANCELED (idempotent au retry)', async () => {
    const created = await postIncome(tokenA, {
      amount: '100000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
    });
    const id = (created.body.expectedIncome as { id: string }).id;

    const res = await deleteIncome(tokenA, id);
    expect(res.status).toBe(200);
    expect(res.body.expectedIncome.status).toBe('CANCELED');
    // Double clic / retry réseau : toujours cohérent.
    const again = await deleteIncome(tokenA, id);
    expect(again.status).toBe(200);
    expect(again.body.expectedIncome.status).toBe('CANCELED');
  });

  it('24. annulation d’un revenu déjà RECEIVED → refusée (409)', async () => {
    const created = await postIncome(tokenA, {
      amount: '500000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
    });
    const id = (created.body.expectedIncome as { id: string }).id;
    const confirm = await confirmReceived(tokenA, id, {
      amount: '500000',
      occurredAt: '2026-10-05',
      accountUnknown: true,
    });
    expect(confirm.status).toBe(201);

    expect((await deleteIncome(tokenA, id)).status).toBe(409);
    expect(
      (
        await patchIncome(tokenA, id, {
          amount: '1',
          certainty: 'CONFIRMED',
          expectedDate: '2026-10-05',
        })
      ).status,
    ).toBe(409);
  });
});
describe('Confirmation « Oui, je l’ai reçu » — soldes, atomicité, concurrence', () => {
  it('25. un revenu futur PENDING ne touche AUCUN solde ni total', async () => {
    await seedCash('100000');
    const plan = await postIncome(tokenA, {
      amount: '500000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
    });
    expect(plan.status).toBe(201);
    const dash = await request(app).get('/accounts').set(auth(tokenA));
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('100000');
    expect(dash.body.totalAvailable).toBe('100000');
    const ledger = await request(app).get('/transactions').set(auth(tokenA));
    expect(ledger.body.transactions).toHaveLength(0);
    expect(ledger.body.totals).toEqual({ incomes: '0', expenses: '0' });
  });

  it('26+27. confirmer crée une Transaction INCOME puis le solde augmente', async () => {
    await seedCash('100000');
    const income = await postIncome(tokenA, {
      amount: '500000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
      description: 'Salaire',
    });
    const id = (income.body.expectedIncome as { id: string }).id;

    // Avant confirmation : aucun impact.
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('100000');

    const confirm = await confirmReceived(tokenA, id, {
      amount: '500000',
      occurredAt: '2026-10-05',
      allocations: [{ accountId: accountsA.cash, amount: '500000' }],
    });
    expect(confirm.status).toBe(201);
    expect(confirm.body.transaction.type).toBe('INCOME');
    expect(confirm.body.transaction.amount).toBe('500000');
    expect(confirm.body.transaction.occurredAt).toBe('2026-10-05');
    expect(confirm.body.transaction.allocations).toHaveLength(1);
    expect(confirm.body.expectedIncome.status).toBe('RECEIVED');
    expect(confirm.body.expectedIncome.receivedTransactionId).toBe(
      confirm.body.transaction.id,
    );

    // Le solde n'augmente qu'APRÈS la confirmation explicite.
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('600000');
    const dash = await request(app).get('/accounts').set(auth(tokenA));
    expect(dash.body.totalAvailable).toBe('600000');
    const ledger = await request(app).get('/transactions').set(auth(tokenA));
    expect(ledger.body.totals).toEqual({ incomes: '500000', expenses: '0' });
  });

  it('28. montant RÉEL différent de l’attendu (l’attendu est conservé)', async () => {
    await seedCash('100000');
    const income = await postIncome(tokenA, {
      amount: '500000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
    });
    const id = (income.body.expectedIncome as { id: string }).id;
    const confirm = await confirmReceived(tokenA, id, {
      amount: '480000',
      occurredAt: '2026-10-05',
      allocations: [{ accountId: accountsA.cash, amount: '480000' }],
    });
    expect(confirm.status).toBe(201);
    expect(confirm.body.transaction.amount).toBe('480000');
    // L'ExpectedIncome garde son montant ATTENDU.
    expect(confirm.body.expectedIncome.amount).toBe('500000');
    expect(confirm.body.expectedIncome.status).toBe('RECEIVED');
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('580000');
  });

  it('29. date RÉELLE différente de la date attendue', async () => {
    const income = await postIncome(tokenA, {
      amount: '200000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
    });
    const id = (income.body.expectedIncome as { id: string }).id;
    const confirm = await confirmReceived(tokenA, id, {
      amount: '200000',
      occurredAt: '2026-10-07',
      accountUnknown: true,
    });
    expect(confirm.status).toBe(201);
    expect(confirm.body.transaction.occurredAt).toBe('2026-10-07');
    const item = incomeOf(confirm.body);
    expect(item.expectedDate).toBe('2026-10-05'); // attendu conservé
  });

  it('30. date réelle INCONNUE explicite → Transaction sans occurredAt', async () => {
    const income = await postIncome(tokenA, {
      amount: '100000',
      certainty: 'UNCERTAIN',
      windowStart: '2026-10-20',
      windowEnd: '2026-10-27',
    });
    const id = (income.body.expectedIncome as { id: string }).id;
    const confirm = await confirmReceived(tokenA, id, {
      amount: '100000',
      dateUnknown: true,
      accountUnknown: true,
    });
    expect(confirm.status).toBe(201);
    expect(confirm.body.transaction.occurredAt).toBeNull();
    expect(confirm.body.transaction.accountUnknown).toBe(true);
    expect(confirm.body.expectedIncome.status).toBe('RECEIVED');
  });
  it('31. allocation SIMPLE sur un compte', async () => {
    await seedCash('50000');
    const income = await postIncome(tokenA, {
      amount: '300000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
    });
    const id = (income.body.expectedIncome as { id: string }).id;
    const confirm = await confirmReceived(tokenA, id, {
      amount: '300000',
      occurredAt: '2026-10-05',
      allocations: [{ accountId: accountsA.bank, amount: '300000' }],
    });
    expect(confirm.status).toBe(201);
    expect((await getAccount(tokenA, 'BANK')).balance).toBe('300000');
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('50000');
  });

  it('32. allocation MULTI-comptes → UNE seule Transaction INCOME', async () => {
    await seedCash('0');
    await prisma.account.update({
      where: { id: accountsA.mvola },
      data: { initialBalance: '1000' },
    });
    const income = await postIncome(tokenA, {
      amount: '500000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
    });
    const id = (income.body.expectedIncome as { id: string }).id;
    const confirm = await confirmReceived(tokenA, id, {
      amount: '500000',
      occurredAt: '2026-10-05',
      allocations: [
        { accountId: accountsA.bank, amount: '300000' },
        { accountId: accountsA.mvola, amount: '200000' },
      ],
    });
    expect(confirm.status).toBe(201);
    expect(confirm.body.transaction.allocations).toHaveLength(2);
    expect((await getAccount(tokenA, 'BANK')).balance).toBe('300000');
    expect((await getAccount(tokenA, 'MVOLA')).balance).toBe('201000');
    const ledger = await request(app).get('/transactions').set(auth(tokenA));
    expect(ledger.body.transactions).toHaveLength(1);
    expect(ledger.body.totals.incomes).toBe('500000');
  });

  it('33. compte RÉEL INCONNU explicite (Transaction réelle, aucun solde précis)', async () => {
    await seedCash('100000');
    const income = await postIncome(tokenA, {
      amount: '400000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-06',
    });
    const id = (income.body.expectedIncome as { id: string }).id;
    const confirm = await confirmReceived(tokenA, id, {
      amount: '400000',
      occurredAt: '2026-10-06',
      accountUnknown: true,
    });
    expect(confirm.status).toBe(201);
    expect(confirm.body.transaction.accountUnknown).toBe(true);
    expect(confirm.body.transaction.allocations).toHaveLength(0);
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('100000');
    const ledger = await request(app).get('/transactions').set(auth(tokenA));
    expect(ledger.body.totals.incomes).toBe('400000');
    expect(confirm.body.expectedIncome.status).toBe('RECEIVED');
  });

  it('34. double confirmation → refusée (409), une seule Transaction', async () => {
    const income = await postIncome(tokenA, {
      amount: '100000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
    });
    const id = (income.body.expectedIncome as { id: string }).id;
    const body = {
      amount: '100000',
      occurredAt: '2026-10-05',
      accountUnknown: true,
    };
    const first = await confirmReceived(tokenA, id, body);
    expect(first.status).toBe(201);
    const second = await confirmReceived(tokenA, id, body);
    expect(second.status).toBe(409);
    const ledger = await request(app).get('/transactions').set(auth(tokenA));
    expect(ledger.body.transactions).toHaveLength(1);
  });

  it('35. deux confirmations CONCURRENTES → une seule Transaction', async () => {
    const income = await postIncome(tokenA, {
      amount: '40000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
    });
    const id = (income.body.expectedIncome as { id: string }).id;
    const body = {
      amount: '40000',
      occurredAt: '2026-10-05',
      accountUnknown: true,
    };
    const [r1, r2] = await Promise.all([
      confirmReceived(tokenA, id, body),
      confirmReceived(tokenA, id, body),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);

    const list = await getIncomes(tokenA);
    const row = (list.body.expectedIncomes as { id: string; status: string }[]).find(
      (i) => i.id === id,
    )!;
    expect(row.status).toBe('RECEIVED');
    const ledger = await request(app).get('/transactions').set(auth(tokenA));
    expect(ledger.body.transactions).toHaveLength(1);
    expect(ledger.body.totals.incomes).toBe('40000');
  });

  it('36. échec de confirmation (compte de B) → ATOMIQUE : rien créé, PENDING', async () => {
    const accountsB = await idsOf(tokenB);
    const income = await postIncome(tokenA, {
      amount: '5000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
    });
    const id = (income.body.expectedIncome as { id: string }).id;
    const res = await confirmReceived(tokenA, id, {
      amount: '5000',
      occurredAt: '2026-10-05',
      allocations: [{ accountId: accountsB.cash, amount: '5000' }],
    });
    expect(res.status).toBe(404);

    const list = await getIncomes(tokenA);
    const row = (list.body.expectedIncomes as {
      id: string;
      status: string;
      receivedTransactionId: string | null;
    }[]).find((i) => i.id === id)!;
    expect(row.status).toBe('PENDING');
    expect(row.receivedTransactionId).toBeNull();
    const ledger = await request(app).get('/transactions').set(auth(tokenA));
    expect(ledger.body.transactions).toHaveLength(0);
  });
  it('37. suppression soft de la Transaction liée → revenu remis PENDING (re-confirmable)', async () => {
    await seedCash('100000');
    const income = await postIncome(tokenA, {
      amount: '30000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
    });
    const id = (income.body.expectedIncome as { id: string }).id;
    const confirm = await confirmReceived(tokenA, id, {
      amount: '30000',
      occurredAt: '2026-10-05',
      allocations: [{ accountId: accountsA.cash, amount: '30000' }],
    });
    const txId = (confirm.body.transaction as { id: string }).id;
    expect((await getAccount(tokenA, 'CASH')).balance).toBe('130000');

    const del = await request(app)
      .delete(`/transactions/${txId}`)
      .set(auth(tokenA));
    expect(del.status).toBe(204);

    expect((await getAccount(tokenA, 'CASH')).balance).toBe('100000');
    const list = await getIncomes(tokenA);
    const row = (list.body.expectedIncomes as {
      id: string;
      status: string;
      receivedTransactionId: string | null;
    }[]).find((i) => i.id === id)!;
    expect(row.status).toBe('PENDING');
    expect(row.receivedTransactionId).toBeNull();

    const reconfirm = await confirmReceived(tokenA, id, {
      amount: '30000',
      occurredAt: '2026-10-05',
      allocations: [{ accountId: accountsA.cash, amount: '30000' }],
    });
    expect(reconfirm.status).toBe(201);
    const ledger = await request(app).get('/transactions').set(auth(tokenA));
    expect(ledger.body.transactions).toHaveLength(1);
    expect(ledger.body.totals.incomes).toBe('30000');
  });

  it('38. édition de la Transaction réelle → le revenu attendu garde son montant PRÉVU', async () => {
    const income = await postIncome(tokenA, {
      amount: '500000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
    });
    const id = (income.body.expectedIncome as { id: string }).id;
    const confirm = await confirmReceived(tokenA, id, {
      amount: '480000',
      occurredAt: '2026-10-05',
      allocations: [{ accountId: accountsA.cash, amount: '480000' }],
    });
    const txId = (confirm.body.transaction as { id: string }).id;

    // Correction ultérieure du réel : 480 000 → 490 000.
    const edit = await request(app)
      .patch(`/transactions/${txId}`)
      .set(auth(tokenA))
      .send({
        type: 'INCOME',
        amount: '490000',
        occurredAt: '2026-10-06',
        allocations: [{ accountId: accountsA.cash, amount: '490000' }],
      });
    expect(edit.status).toBe(200);
    expect(edit.body.transaction.amount).toBe('490000');

    const list = await getIncomes(tokenA);
    const row = (list.body.expectedIncomes as {
      id: string;
      amount: string;
      status: string;
      expectedDate: string | null;
      receivedTransaction: { amount: string } | null;
    }[]).find((i) => i.id === id)!;
    // L'attendu ne bouge jamais quand le réel est corrigé.
    expect(row.amount).toBe('500000');
    expect(row.expectedDate).toBe('2026-10-05');
    expect(row.status).toBe('RECEIVED');
    expect(row.receivedTransaction?.amount).toBe('490000');
  });
});
describe('Rappels internes « Reçu ? »', () => {
  it('39. date exacte future → upcoming', async () => {
    const created = await postIncome(tokenA, {
      amount: '500000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-08',
    });
    const id = (created.body.expectedIncome as { id: string }).id;
    const res = await getIncomeReminders(tokenA, '?today=2026-10-05');
    expect(res.status).toBe(200);
    expect((res.body.upcoming as { id: string }[]).map((i) => i.id)).toContain(id);
    expect(res.body.today).toBe('2026-10-05');
    expectNoSecrets(res.body);
  });

  it('40. date exacte du jour local → dueToday', async () => {
    const created = await postIncome(tokenA, {
      amount: '500000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
    });
    const id = (created.body.expectedIncome as { id: string }).id;
    const res = await getIncomeReminders(tokenA, '?today=2026-10-05');
    expect(
      (res.body.dueToday as { id: string }[]).map((i) => i.id),
    ).toContain(id);
  });

  it('41. date exacte passée PENDING → overdue (aucune modification auto)', async () => {
    const created = await postIncome(tokenA, {
      amount: '500000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-01',
    });
    const id = (created.body.expectedIncome as { id: string }).id;
    const res = await getIncomeReminders(tokenA, '?today=2026-10-05');
    expect((res.body.overdue as { id: string }[]).map((i) => i.id)).toContain(id);
    // Le revenu reste PENDING : le système n'invente pas ce qui s'est passé.
    const list = await getIncomes(tokenA);
    const row = (list.body.expectedIncomes as { id: string; status: string }[]).find(
      (i) => i.id === id,
    )!;
    expect(row.status).toBe('PENDING');
  });

  it('42. plage avant windowStart → upcoming', async () => {
    const created = await postIncome(tokenA, {
      amount: '300000',
      certainty: 'CONFIRMED',
      windowStart: '2026-10-20',
      windowEnd: '2026-10-27',
    });
    const id = (created.body.expectedIncome as { id: string }).id;
    const res = await getIncomeReminders(tokenA, '?today=2026-10-10');
    expect((res.body.upcoming as { id: string }[]).map((i) => i.id)).toContain(id);
    expect(res.body.inWindow).toHaveLength(0);
  });
  it('43. plage ACTIVE (20 → 27 inclus) → inWindow, chaque jour consultable', async () => {
    const created = await postIncome(tokenA, {
      amount: '300000',
      certainty: 'UNCERTAIN',
      windowStart: '2026-10-20',
      windowEnd: '2026-10-27',
    });
    const id = (created.body.expectedIncome as { id: string }).id;
    for (const day of ['2026-10-20', '2026-10-23', '2026-10-27']) {
      const res = await getIncomeReminders(tokenA, `?today=${day}`);
      expect((res.body.inWindow as { id: string }[]).map((i) => i.id)).toContain(id);
    }
    // Toujours PENDING (aucune écriture en lecture).
    const list = await getIncomes(tokenA);
    const row = (list.body.expectedIncomes as { id: string; status: string }[]).find(
      (i) => i.id === id,
    )!;
    expect(row.status).toBe('PENDING');
  });

  it('44. plage après windowEnd → overdue', async () => {
    const created = await postIncome(tokenA, {
      amount: '300000',
      certainty: 'CONFIRMED',
      windowStart: '2026-10-20',
      windowEnd: '2026-10-27',
    });
    const id = (created.body.expectedIncome as { id: string }).id;
    const res = await getIncomeReminders(tokenA, '?today=2026-10-28');
    expect((res.body.overdue as { id: string }[]).map((i) => i.id)).toContain(id);
  });

  it('45. un revenu RECEIVED n’apparaît pas comme rappel actif', async () => {
    const created = await postIncome(tokenA, {
      amount: '50000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
    });
    const id = (created.body.expectedIncome as { id: string }).id;
    await confirmReceived(tokenA, id, {
      amount: '50000',
      occurredAt: '2026-10-05',
      accountUnknown: true,
    });
    const res = await getIncomeReminders(tokenA, '?today=2026-10-05');
    const all = [
      ...(res.body.overdue as { id: string }[]),
      ...(res.body.dueToday as { id: string }[]),
      ...(res.body.inWindow as { id: string }[]),
      ...(res.body.upcoming as { id: string }[]),
    ];
    expect(all.some((i) => i.id === id)).toBe(false);
  });

  it('46. un revenu CANCELED n’apparaît pas comme rappel actif', async () => {
    const created = await postIncome(tokenA, {
      amount: '50000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
    });
    const id = (created.body.expectedIncome as { id: string }).id;
    await deleteIncome(tokenA, id);
    const res = await getIncomeReminders(tokenA, '?today=2026-10-05');
    const all = [
      ...(res.body.overdue as { id: string }[]),
      ...(res.body.dueToday as { id: string }[]),
      ...(res.body.inWindow as { id: string }[]),
      ...(res.body.upcoming as { id: string }[]),
    ];
    expect(all.some((i) => i.id === id)).toBe(false);
  });

  it('47. isolation utilisateurs sur les rappels « Reçu ? »', async () => {
    const created = await postIncome(tokenA, {
      amount: '90000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-01',
    });
    const id = (created.body.expectedIncome as { id: string }).id;
    const resB = await getIncomeReminders(tokenB, '?today=2026-10-05');
    const all = [
      ...(resB.body.overdue as { id: string }[]),
      ...(resB.body.dueToday as { id: string }[]),
      ...(resB.body.inWindow as { id: string }[]),
      ...(resB.body.upcoming as { id: string }[]),
    ];
    expect(all.some((i) => i.id === id)).toBe(false);
  });

  it('48. today EXPLICITE pilote la dérivation (et today invalide → 400)', async () => {
    const created = await postIncome(tokenA, {
      amount: '90000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
    });
    const id = (created.body.expectedIncome as { id: string }).id;

    // « Aujourd'hui » = 10-03 : pas encore due (upcoming).
    const early = await getIncomeReminders(tokenA, '?today=2026-10-03');
    expect(
      (early.body.upcoming as { id: string }[]).map((i) => i.id),
    ).toContain(id);

    // « Aujourd'hui » = 10-05 : due.
    const same = await getIncomeReminders(tokenA, '?today=2026-10-05');
    expect(
      (same.body.dueToday as { id: string }[]).map((i) => i.id),
    ).toContain(id);

    expect(
      (await getIncomeReminders(tokenA, '?today=10-05-2026')).status,
    ).toBe(400);
  });
});
describe('Liste GET /expected-incomes — structure et tri', () => {
  it('reminderBucket dérivé pour PENDING, null pour résolu ; tri du plus proche', async () => {
    await postIncome(tokenA, {
      amount: '300000',
      certainty: 'CONFIRMED',
      windowStart: '2026-10-20',
      windowEnd: '2026-10-27',
      description: 'Freelance',
    });
    const exact = await postIncome(tokenA, {
      amount: '500000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-05',
      description: 'Salaire',
    });
    const exactId = (exact.body.expectedIncome as { id: string }).id;

    const list = await getIncomes(tokenA, '?today=2026-10-23');
    expect(list.status).toBe(200);
    const items = lastOf(list.body);
    // Tri stable : la date exacte 10-05 (overdue au 23) avant la plage 20..27 (inWindow).
    expect(items[0]!.description).toBe('Salaire');
    expect(items[0]!.reminderBucket).toBe('overdue');
    expect(items[1]!.description).toBe('Freelance');
    expect(items[1]!.reminderBucket).toBe('inWindow');

    // Après confirmation, reminderBucket devient null.
    await confirmReceived(tokenA, exactId, {
      amount: '500000',
      occurredAt: '2026-10-05',
      accountUnknown: true,
    });
    const after = lastOf((await getIncomes(tokenA)).body);
    const received = after.find((i) => i.id === exactId)!;
    expect(received.status).toBe('RECEIVED');
    expect(received.reminderBucket).toBeNull();
    // La Transaction réelle est exposée « si pertinente ».
    expect(received.receivedTransaction?.type).toBe('INCOME');
    expect(received.receivedTransaction?.amount).toBe('500000');
  });
});

describe('Garantie read-only : les GET ne changent JAMAIS d’état', () => {
  it('49. GET /income-reminders n’écrit rien (même sur un revenu en retard)', async () => {
    const created = await postIncome(tokenA, {
      amount: '90000',
      certainty: 'CONFIRMED',
      expectedDate: '2026-10-01', // en retard au 10-05
    });
    const id = (created.body.expectedIncome as { id: string }).id;

    const snapshot = async () => {
      const rows = await prisma.expectedIncome.findMany({
        where: { id },
        select: {
          status: true,
          receivedTransactionId: true,
          amount: true,
          expectedDate: true,
          updatedAt: true,
        },
      });
      return JSON.stringify(rows);
    };
    const beforeFingerprint = await snapshot();

    for (let i = 0; i < 3; i += 1) {
      const res = await getIncomeReminders(tokenA, '?today=2026-10-05');
      expect(res.status).toBe(200);
      expect(
        (res.body.overdue as { id: string }[]).map((r) => r.id),
      ).toContain(id);
    }

    // Toujours PENDING, aucun lien, aucune ligne modifiée.
    expect(await snapshot()).toBe(beforeFingerprint);
  });

  it('50. GET /expected-incomes n’écrit rien (ni création, ni mise à jour)', async () => {
    const created = await postIncome(tokenA, {
      amount: '450000',
      certainty: 'UNCERTAIN',
      windowStart: '2026-10-01',
      windowEnd: '2026-10-15',
    });
    const id = (created.body.expectedIncome as { id: string }).id;

    async function fingerprint(): Promise<string> {
      const rows = await prisma.expectedIncome.findMany({
        where: { userId: (await prisma.user.findUnique({ where: { email: 'income-a@example.com' }, select: { id: true } }))!.id },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          status: true,
          amount: true,
          certainty: true,
          expectedDate: true,
          windowStart: true,
          windowEnd: true,
          receivedTransactionId: true,
          updatedAt: true,
        },
      });
      return JSON.stringify(rows.map((r) => ({ ...r, expectedDate: r.expectedDate?.toISOString(), windowStart: r.windowStart?.toISOString(), windowEnd: r.windowEnd?.toISOString() })));
    }

    const beforeFingerprint = await fingerprint();
    for (let i = 0; i < 3; i += 1) {
      expect((await getIncomes(tokenA, '?today=2026-10-05')).status).toBe(200);
    }
    expect(await fingerprint()).toBe(beforeFingerprint);
    // Le revenu reste PENDING malgré la fenêtre dépassée (10-05 > 10-15 ? non,
    // ici on garde un jour intérieur pour ne rien présumer ; le GET ne mute pas).
    const rows = await prisma.expectedIncome.findMany({ where: { id }, select: { status: true } });
    expect(rows[0]?.status).toBe('PENDING');
  });
});
