import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';

/**
 * DETTES / CRÉANCES / RÈGLEMENTS (étape 11) — API.
 *
 * Contrats clés :
 *  - le RESTANT est TOUJOURS dérivé (jamais stocké) ;
 *  - un règlement STANDARD n'impacte QUE le solde du compte — JAMAIS une
 *    Transaction EXPENSE/INCOME (anti-pollution du journal/budgets) ;
 *  - le sur-remboursement est impossible, y compris en COURSE (2 requêtes
 *    concurrentes → 1 seule passe) ;
 *  - une « avance » (OWED_TO_ME + kind INCOME_ADVANCE_RECEIVABLE) porte son
 *    +compte sur une vraie Transaction INCOME liée UNE seule fois ;
 *  - cette Transaction INCOME n'est modifiable/supprimable QUE via le module
 *    dettes (PATCH miroir ; DELETE → suppression logique des DEUX).
 */

const PASSWORD = 'correct-horse-battery-staple';

type AccountIds = { cash: string; bank: string; mvola: string };

let tokenA = ''; // « journal propre » : aucun revenu/dépense réel
let tokenB = ''; // avances & gardes sur Transactions
let accountsA: AccountIds;
let accountsB: AccountIds;

async function register(email: string): Promise<string> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: PASSWORD });
  expect(res.status).toBe(201);
  return res.body.accessToken as string;
}

async function accountIdsOf(token: string): Promise<AccountIds> {
  const res = await request(app).get('/accounts').set(auth(token));
  expect(res.status).toBe(200);
  const by = (type: string) =>
    (res.body.accounts as { type: string; id: string }[]).find(
      (account) => account.type === type,
    )!.id;
  return { cash: by('CASH'), bank: by('BANK'), mvola: by('MVOLA') };
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

beforeAll(async () => {
  await prisma.refreshSession.deleteMany();
  await cleanDomain();
  await prisma.user.deleteMany();

  tokenA = await register('debts-a@example.com');
  tokenB = await register('debts-b@example.com');
  accountsA = await accountIdsOf(tokenA);
  accountsB = await accountIdsOf(tokenB);
});

beforeEach(async () => {
  await cleanDomain();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const postDebt = (token: string, body: Record<string, unknown>) =>
  request(app).post('/debts').set(auth(token)).send(body);
const getDebts = (token: string) => request(app).get('/debts').set(auth(token));
const patchDebt = (token: string, id: string, body: Record<string, unknown>) =>
  request(app).patch(`/debts/${id}`).set(auth(token)).send(body);
const deleteDebt = (token: string, id: string) =>
  request(app).delete(`/debts/${id}`).set(auth(token));
const postSettlement = (
  token: string,
  debtId: string,
  body: Record<string, unknown>,
) =>
  request(app)
    .post(`/debts/${debtId}/settlements`)
    .set(auth(token))
    .send(body);
const patchSettlement = (
  token: string,
  debtId: string,
  settlementId: string,
  body: Record<string, unknown>,
) =>
  request(app)
    .patch(`/debts/${debtId}/settlements/${settlementId}`)
    .set(auth(token))
    .send(body);
const deleteSettlement = (
  token: string,
  debtId: string,
  settlementId: string,
) =>
  request(app)
    .delete(`/debts/${debtId}/settlements/${settlementId}`)
    .set(auth(token));

async function createDebtOk(
  token: string,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await postDebt(token, body);
  expect(res.status).toBe(201);
  return res.body.debt as { id: string };
}

async function debtOf(
  token: string,
  debtId: string,
): Promise<Record<string, unknown>> {
  const res = await getDebts(token);
  expect(res.status).toBe(200);
  const debt = (res.body.debts as Record<string, unknown>[]).find(
    (d) => d.id === debtId,
  );
  expect(debt).toBeDefined();
  return debt as Record<string, unknown>;
}

async function balanceOf(token: string, accountId: string): Promise<string> {
  const res = await request(app).get('/accounts').set(auth(token));
  expect(res.status).toBe(200);
  const account = (res.body.accounts as { id: string; balance: string }[]).find(
    (a) => a.id === accountId,
  )!;
  return account.balance;
}

async function ledgerTotals(token: string): Promise<{
  count: number;
  incomes: string;
  expenses: string;
}> {
  const res = await request(app)
    .get('/transactions?page=1&limit=50')
    .set(auth(token));
  expect(res.status).toBe(200);
  return {
    count: (res.body.transactions as unknown[]).length,
    incomes: res.body.totals.incomes as string,
    expenses: res.body.totals.expenses as string,
  };
}

describe('Création & montants dérivés', () => {
  it('refuse la création d’une « avance » sur « je dois » (400)', async () => {
    const res = await postDebt(tokenA, {
      direction: 'I_OWE',
      kind: 'INCOME_ADVANCE_RECEIVABLE',
      originalAmount: '100000',
    });
    expect(res.status).toBe(400);
  });

  it('crée une dette et une créance, remaining = original, OPEN, sans règlement', async () => {
    const iOwe = await createDebtOk(tokenA, {
      direction: 'I_OWE',
      originalAmount: '200000',
      counterpartyName: 'Jean',
      description: 'Prêt personnel',
    });
    const owed = await createDebtOk(tokenA, {
      direction: 'OWED_TO_ME',
      originalAmount: '150000',
    });

    const res = await getDebts(tokenA);
    expect(res.status).toBe(200);
    const debts = res.body.debts as Record<string, unknown>[];
    const first = debts.find((d) => d.id === iOwe.id)!;
    const second = debts.find((d) => d.id === owed.id)!;
    expect(first.remaining).toBe('200000');
    expect(first.settledAmount).toBe('0');
    expect(first.temporalStatus).toBe('OPEN');
    expect(first.settlements).toEqual([]);
    expect(second.remaining).toBe('150000');
    expect(second.temporalStatus).toBe('OPEN');
  });

  it('refuse échéance réelle ET « je ne sais plus » (400)', async () => {
    const res = await postDebt(tokenA, {
      direction: 'I_OWE',
      originalAmount: '10000',
      dueDate: '2026-09-01',
      dueDateUnknown: true,
    });
    expect(res.status).toBe(400);
  });

  it('dérive OVERDUE si l’échéance est passée, SETTLED si tout est réglé', async () => {
    const overdue = await createDebtOk(tokenA, {
      direction: 'I_OWE',
      originalAmount: '30000',
      dueDate: '2020-01-01',
    });
    const openFuture = await createDebtOk(tokenA, {
      direction: 'I_OWE',
      originalAmount: '30000',
      dueDate: '2030-01-01',
    });

    let debt = await debtOf(tokenA, overdue.id);
    expect(debt.temporalStatus).toBe('OVERDUE');
    expect((await debtOf(tokenA, openFuture.id)).temporalStatus).toBe('OPEN');

    // Règlement exact → SETTLED, même si l'échéance est ancienne.
    const settled = await createDebtOk(tokenA, {
      direction: 'OWED_TO_ME',
      originalAmount: '50000',
      dueDateUnknown: true,
    });
    const pay = await postSettlement(tokenA, settled.id, {
      amount: '50000',
      accountId: accountsA.bank,
      occurredAt: '2026-09-04',
    });
    expect(pay.status).toBe(201);
    debt = await debtOf(tokenA, settled.id);
    expect(debt.remaining).toBe('0');
    expect(debt.settledAmount).toBe('50000');
    expect(debt.temporalStatus).toBe('SETTLED');
  });
});

describe('Règlements STANDARD : solde comptable, jamais de Transaction', () => {
  it('rembourse une partie : remaining diminue, compte débité, journal vide', async () => {
    const debt = await createDebtOk(tokenA, {
      direction: 'I_OWE',
      originalAmount: '100000',
      counterpartyName: 'Jean',
    });
    const before = await balanceOf(tokenA, accountsA.cash);

    const pay = await postSettlement(tokenA, debt.id, {
      amount: '40000',
      accountId: accountsA.cash,
      occurredAt: '2026-09-05',
      description: 'Premier remboursement',
    });
    expect(pay.status).toBe(201);
    expect(pay.body.settlement.account.id).toBe(accountsA.cash);
    expect(pay.body.debt.remaining).toBe('60000');
    expect(pay.body.debt.settledAmount).toBe('40000');
    expect(pay.body.debt.settlements).toHaveLength(1);

    const after = await balanceOf(tokenA, accountsA.cash);
    expect(Number(after) - Number(before)).toBe(-40000);

    // Anti-pollution : aucun EXPENSE/INCOME dans le journal, aucun total.
    const totals = await ledgerTotals(tokenA);
    expect(totals.count).toBe(0);
    expect(totals.incomes).toBe('0');
    expect(totals.expenses).toBe('0');
  });

  it('règle une créance reçue : compte crédité, remaining diminue', async () => {
    const debt = await createDebtOk(tokenA, {
      direction: 'OWED_TO_ME',
      originalAmount: '80000',
      counterpartyName: 'Mika',
    });
    const before = await balanceOf(tokenA, accountsA.mvola);

    const pay = await postSettlement(tokenA, debt.id, {
      amount: '50000',
      accountId: accountsA.mvola,
      occurredAt: '2026-09-06',
    });
    expect(pay.status).toBe(201);
    expect(pay.body.debt.remaining).toBe('30000');
    expect(Number(await balanceOf(tokenA, accountsA.mvola)) - Number(before)).toBe(
      50000,
    );
    const totals = await ledgerTotals(tokenA);
    expect(totals.count).toBe(0);
  });

  it('accepte « compte inconnu » + « date inconnue » sans toucher aux comptes', async () => {
    const debt = await createDebtOk(tokenA, {
      direction: 'I_OWE',
      originalAmount: '70000',
    });
    const before = await balanceOf(tokenA, accountsA.cash);

    const pay = await postSettlement(tokenA, debt.id, {
      amount: '30000',
      accountUnknown: true,
      dateUnknown: true,
    });
    expect(pay.status).toBe(201);
    expect(pay.body.settlement.account).toBeNull();
    expect(pay.body.settlement.accountUnknown).toBe(true);
    expect(pay.body.settlement.occurredAt).toBeNull();
    expect(pay.body.settlement.dateUnknown).toBe(true);
    expect(pay.body.debt.remaining).toBe('40000');
    expect(await balanceOf(tokenA, accountsA.cash)).toBe(before);
  });

  it('refuse un compte absent sans « inconnu » explicite (400)', async () => {
    const debt = await createDebtOk(tokenA, {
      direction: 'I_OWE',
      originalAmount: '70000',
    });
    const res = await postSettlement(tokenA, debt.id, {
      amount: '10000',
      occurredAt: '2026-09-06',
    });
    expect(res.status).toBe(400);
  });

  it('refuse le sur-remboursement (400)', async () => {
    const debt = await createDebtOk(tokenA, {
      direction: 'I_OWE',
      originalAmount: '50000',
    });
    const ok = await postSettlement(tokenA, debt.id, {
      amount: '40000',
      accountId: accountsA.cash,
      occurredAt: '2026-09-05',
    });
    expect(ok.status).toBe(201);

    const over = await postSettlement(tokenA, debt.id, {
      amount: '20000',
      accountId: accountsA.cash,
      occurredAt: '2026-09-06',
    });
    expect(over.status).toBe(400);

    // Règlement exact du restant → autorisé.
    const exact = await postSettlement(tokenA, debt.id, {
      amount: '10000',
      accountId: accountsA.cash,
      occurredAt: '2026-09-07',
    });
    expect(exact.status).toBe(201);
    expect((await debtOf(tokenA, debt.id)).temporalStatus).toBe('SETTLED');
  });

  it('empêche le sur-remboursement même en cas de requêtes CONCURRENTES', async () => {
    const debt = await createDebtOk(tokenA, {
      direction: 'I_OWE',
      originalAmount: '50000',
    });

    const body = {
      amount: '40000',
      accountId: accountsA.cash,
      occurredAt: '2026-09-05',
    };
    const [first, second] = await Promise.all([
      postSettlement(tokenA, debt.id, body),
      postSettlement(tokenA, debt.id, body),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 400]);
    // Une seule ligne réglée malgré la course : remaining intact.
    const debtAfter = await debtOf(tokenA, debt.id);
    expect(debtAfter.remaining).toBe('10000');
    expect(debtAfter.settledAmount).toBe('40000');
  });

  it('un solde issu d’un règlement ne redevient jamais un solde de départ', async () => {
    const debt = await createDebtOk(tokenA, {
      direction: 'OWED_TO_ME',
      originalAmount: '60000',
      counterpartyName: 'Mika',
    });
    await postSettlement(tokenA, debt.id, {
      amount: '60000',
      accountId: accountsA.bank,
      occurredAt: '2026-09-06',
    });
    const balance = await balanceOf(tokenA, accountsA.bank);
    expect(balance).toBe('60000');
    expect(
      await prisma.accountAdjustment.count({
        where: { accountId: accountsA.bank },
      }),
    ).toBe(0);

    // « Je veux que le solde devienne 100000 » → AccountAdjustment (mouvement).
    const patch = await request(app)
      .patch(`/accounts/${accountsA.bank}`)
      .set(auth(tokenA))
      .send({ targetBalance: '100000' });
    expect(patch.status).toBe(200);
    expect(patch.body.account.balance).toBe('100000');
    expect(
      await prisma.accountAdjustment.count({
        where: { accountId: accountsA.bank },
      }),
    ).toBe(1);
  });
});

describe('PATCH & DELETE (dettes et règlements)', () => {
  it('ne peut pas baisser originalAmount sous le montant déjà réglé', async () => {
    const debt = await createDebtOk(tokenA, {
      direction: 'I_OWE',
      originalAmount: '100000',
    });
    await postSettlement(tokenA, debt.id, {
      amount: '40000',
      accountId: accountsA.cash,
      occurredAt: '2026-09-05',
    });

    const shrink = await patchDebt(tokenA, debt.id, { originalAmount: '30000' });
    expect(shrink.status).toBe(400);

    const exact = await patchDebt(tokenA, debt.id, { originalAmount: '40000' });
    expect(exact.status).toBe(200);
    expect(exact.body.debt.remaining).toBe('0');
  });

  it('modifie un règlement : remaining et solde se recalculent', async () => {
    const debt = await createDebtOk(tokenA, {
      direction: 'I_OWE',
      originalAmount: '100000',
    });
    const pay = await postSettlement(tokenA, debt.id, {
      amount: '40000',
      accountId: accountsA.cash,
      occurredAt: '2026-09-05',
    });
    expect(pay.status).toBe(201);
    const before = await balanceOf(tokenA, accountsA.cash);

    // Correction : ce n'était pas 40000 mais 25000.
    const patch = await patchSettlement(
      tokenA,
      debt.id,
      pay.body.settlement.id,
      { amount: '25000' },
    );
    expect(patch.status).toBe(200);
    expect(patch.body.debt.remaining).toBe('75000');
    expect(patch.body.debt.settledAmount).toBe('25000');
    expect(Number(await balanceOf(tokenA, accountsA.cash)) - Number(before)).toBe(
      15000,
    );
  });

  it('annule un règlement (DELETE) : l’impact sur le solde disparaît', async () => {
    const debt = await createDebtOk(tokenA, {
      direction: 'OWED_TO_ME',
      originalAmount: '90000',
      counterpartyName: 'Mika',
    });
    const pay = await postSettlement(tokenA, debt.id, {
      amount: '90000',
      accountId: accountsA.mvola,
      occurredAt: '2026-09-06',
    });
    expect(pay.status).toBe(201);
    expect(await balanceOf(tokenA, accountsA.mvola)).toBe('90000');

    const del = await deleteSettlement(tokenA, debt.id, pay.body.settlement.id);
    expect(del.status).toBe(204);
    expect(await balanceOf(tokenA, accountsA.mvola)).toBe('0');
    const debtAfter = await debtOf(tokenA, debt.id);
    expect(debtAfter.remaining).toBe('90000');
    expect(debtAfter.settlements).toEqual([]);
  });

  it('supprime une dette (logique) : elle disparaît de la liste', async () => {
    const debt = await createDebtOk(tokenA, {
      direction: 'I_OWE',
      originalAmount: '10000',
    });
    const del = await deleteDebt(tokenA, debt.id);
    expect(del.status).toBe(204);

    const res = await getDebts(tokenA);
    expect(
      (res.body.debts as { id: string }[]).some((d) => d.id === debt.id),
    ).toBe(false);
  });

  it('GET /debts est strictement read-only', async () => {
    const debt = await createDebtOk(tokenA, {
      direction: 'I_OWE',
      originalAmount: '20000',
    });
    await postSettlement(tokenA, debt.id, {
      amount: '5000',
      accountId: accountsA.cash,
      occurredAt: '2026-09-05',
    });
    const first = await debtOf(tokenA, debt.id);
    const second = await debtOf(tokenA, debt.id);
    expect(second.updatedAt).toBe(first.updatedAt);
    const res = await getDebts(tokenA);
    expect(res.body.debts).toHaveLength(1);
  });
});

describe('Avance (INCOME_ADVANCE_RECEIVABLE)', () => {
  it('crée UNE Transaction INCOME liée : +compte exact, jamais en double', async () => {
    const debt = await createDebtOk(tokenB, {
      direction: 'OWED_TO_ME',
      kind: 'INCOME_ADVANCE_RECEIVABLE',
      originalAmount: '300000',
      counterpartyName: 'Employeur',
      description: 'Avance sur salaire',
    });

    const before = await balanceOf(tokenB, accountsB.bank);
    const res = await postSettlement(tokenB, debt.id, {
      amount: '150000',
      accountId: accountsB.bank,
      occurredAt: '2026-09-05',
      description: 'Avance reçue',
    });
    expect(res.status).toBe(201);
    expect(res.body.debt.remaining).toBe('150000');

    // Le solde bouge d'EXACTEMENT le montant (une seule fois).
    expect(Number(await balanceOf(tokenB, accountsB.bank)) - Number(before)).toBe(
      150000,
    );
    // Une seule Transaction INCOME, au bon montant.
    const totals = await ledgerTotals(tokenB);
    expect(totals.count).toBe(1);
    expect(totals.incomes).toBe('150000');
    const ledger = await request(app)
      .get('/transactions?page=1&limit=50')
      .set(auth(tokenB));
    const income = ledger.body.transactions[0] as {
      type: string;
      amount: string;
      id: string;
    };
    expect(income.type).toBe('INCOME');
    expect(income.amount).toBe('150000');

    // Liaison UNIQUE en base (unique linkedTransactionId → aucun doublon).
    const linked = await prisma.debtSettlement.findMany({
      where: { debtId: debt.id, deletedAt: null },
      select: { linkedTransactionId: true },
    });
    expect(linked).toHaveLength(1);
    expect(linked[0]!.linkedTransactionId).toBe(income.id);
  });

  it('interdit PATCH/DELETE directs de la Transaction INCOME liée (409)', async () => {
    const debt = await createDebtOk(tokenB, {
      direction: 'OWED_TO_ME',
      kind: 'INCOME_ADVANCE_RECEIVABLE',
      originalAmount: '200000',
    });
    await postSettlement(tokenB, debt.id, {
      amount: '200000',
      accountId: accountsB.bank,
      occurredAt: '2026-09-05',
    });
    const ledger = await request(app)
      .get('/transactions?page=1&limit=50')
      .set(auth(tokenB));
    const income = ledger.body.transactions[0] as { id: string };

    const patch = await request(app)
      .patch(`/transactions/${income.id}`)
      .set(auth(tokenB))
      .send({
        type: 'INCOME',
        amount: '50000',
        occurredAt: '2026-09-06',
        dateUnknown: false,
        accountUnknown: false,
        allocations: [{ accountId: accountsB.bank, amount: '50000' }],
      });
    expect(patch.status).toBe(409);

    const del = await request(app)
      .delete(`/transactions/${income.id}`)
      .set(auth(tokenB));
    expect(del.status).toBe(409);

    // La dette reste intacte malgré les refus.
    const debtAfter = await debtOf(tokenB, debt.id);
    expect(debtAfter.remaining).toBe('0');
  });

  it('PATCH du règlement = PATCH MIROIR de la Transaction INCOME', async () => {
    const debt = await createDebtOk(tokenB, {
      direction: 'OWED_TO_ME',
      kind: 'INCOME_ADVANCE_RECEIVABLE',
      originalAmount: '300000',
    });
    const pay = await postSettlement(tokenB, debt.id, {
      amount: '150000',
      accountId: accountsB.bank,
      occurredAt: '2026-09-05',
    });
    expect(pay.status).toBe(201);
    expect(await balanceOf(tokenB, accountsB.bank)).toBe('150000');

    const patch = await patchSettlement(
      tokenB,
      debt.id,
      pay.body.settlement.id,
      { amount: '180000' },
    );
    expect(patch.status).toBe(200);
    expect(patch.body.debt.remaining).toBe('120000');

    const totals = await ledgerTotals(tokenB);
    expect(totals.count).toBe(1);
    expect(totals.incomes).toBe('180000');
    expect(await balanceOf(tokenB, accountsB.bank)).toBe('180000');
  });

  it('DELETE du règlement d’une avance supprime AUSSI la Transaction liée', async () => {
    const debt = await createDebtOk(tokenB, {
      direction: 'OWED_TO_ME',
      kind: 'INCOME_ADVANCE_RECEIVABLE',
      originalAmount: '250000',
    });
    const pay = await postSettlement(tokenB, debt.id, {
      amount: '250000',
      accountId: accountsB.bank,
      occurredAt: '2026-09-05',
    });
    expect(pay.status).toBe(201);
    expect(await balanceOf(tokenB, accountsB.bank)).toBe('250000');

    const del = await deleteSettlement(tokenB, debt.id, pay.body.settlement.id);
    expect(del.status).toBe(204);

    // Plus de Transaction dans le journal et plus d'impact comptable.
    const totals = await ledgerTotals(tokenB);
    expect(totals.count).toBe(0);
    expect(totals.incomes).toBe('0');
    expect(await balanceOf(tokenB, accountsB.bank)).toBe('0');

    const debtAfter = await debtOf(tokenB, debt.id);
    expect(debtAfter.remaining).toBe('250000');
    expect(debtAfter.settlements).toEqual([]);
  });
});






