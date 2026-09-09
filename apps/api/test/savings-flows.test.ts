import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { seedSystemCategories } from '../src/categories/seed.js';

/**
 * FLUX ÉPARGNE COMPLETS (étape 10) — API.
 *
 * Propositions post-revenu RÉEL (FIXED/PERCENTAGE, idempotentes, « Ignorer »
 * persistant) + retraits réels de l'Épargne (jamais au-delà du solde).
 * Verrous : une proposition n'est JAMAIS de l'argent ; confirmer crée
 * EXACTEMENT UN AccountTransfer source → SAVINGS — jamais une Transaction
 * EXPENSE/INCOME, jamais de double comptage.
 */

const PASSWORD = 'correct-horse-battery-staple';
const MONTH = '2026-09';
const DATE = '2026-09-03';

type AccountIds = {
  cash: string;
  bank: string;
  mvola: string;
  savings: string;
};

let tokenA = '';
let accountsA: AccountIds;
let userIdA = '';

const EMAIL_A = `flows-${Date.now()}a@test.dev`;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const getNext = (token: string) =>
  request(app).get('/savings/suggestions/next').set(auth(token));
const dismissSuggestion = (token: string, id: string) =>
  request(app).post(`/savings/suggestions/${id}/dismiss`).set(auth(token));
const confirmSuggestion = (token: string, id: string, body: Record<string, unknown>) =>
  request(app).post(`/savings/suggestions/${id}/confirm`).set(auth(token)).send(body);
const postWithdrawal = (token: string, body: Record<string, unknown>) =>
  request(app).post('/savings/withdrawals').set(auth(token)).send(body);
const postTx = (token: string, body: Record<string, unknown>) =>
  request(app).post('/transactions').set(auth(token)).send(body);
const postPlan = (token: string, body: Record<string, unknown>) =>
  request(app).post('/savings-plans').set(auth(token)).send(body);
const postTransfer = (token: string, body: Record<string, unknown>) =>
  request(app).post('/transfers').set(auth(token)).send(body);
const postExpectedIncome = (token: string, body: Record<string, unknown>) =>
  request(app).post('/expected-incomes').set(auth(token)).send(body);
const confirmReceived = (token: string, id: string, body: Record<string, unknown>) =>
  request(app)
    .post(`/expected-incomes/${id}/confirm-received`)
    .set(auth(token))
    .send(body);


async function register(email: string): Promise<string> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: PASSWORD });
  expect(res.status).toBe(201);
  return res.body.accessToken as string;
}

async function idsOf(token: string): Promise<AccountIds> {
  const res = await request(app).get('/accounts').set(auth(token));
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

async function fund(token: string, accountId: string, amount: string) {
  const res = await request(app)
    .patch(`/accounts/${accountId}`)
    .set(auth(token))
    .send({ targetBalance: amount });
  expect(res.status).toBe(200);
}

async function dashboard(token: string) {
  const res = await request(app).get('/accounts').set(auth(token));
  expect(res.status).toBe(200);
  return res.body as {
    currency: string;
    totalAvailable: string;
    accounts: { id: string; type: string; balance: string }[];
  };
}

async function incomeOn(token: string, accountId: string, amount: string) {
  const res = await postTx(token, {
    type: 'INCOME',
    amount,
    occurredAt: DATE,
    description: `Revenu test ${Date.now()}`,
    allocations: [{ accountId, amount }],
  });
  expect(res.status).toBe(201);
  return res.body.transaction as { id: string };
}

beforeAll(async () => {
  await seedSystemCategories();
  tokenA = await register(EMAIL_A);
  userIdA = (await prisma.user.findUniqueOrThrow({ where: { email: EMAIL_A } })).id;
  accountsA = await idsOf(tokenA);
});

beforeEach(async () => {
  // Scénario déterministe : on repart d'un état vide pour l'utilisateur de
  // test (jamais de reset global, jamais d'autre utilisateur touché).
  await prisma.accountAdjustment.deleteMany({ where: { userId: userIdA } });
  await prisma.savingsContribution.deleteMany({
    where: { savingsPlan: { userId: userIdA } },
  });
  await prisma.monthlySavingsPlan.deleteMany({ where: { userId: userIdA } });
  await prisma.savingsSuggestion.deleteMany({ where: { userId: userIdA } });
  await prisma.expectedIncome.deleteMany({ where: { userId: userIdA } });
  await prisma.accountTransfer.deleteMany({ where: { userId: userIdA } });
  await prisma.transaction.deleteMany({ where: { userId: userIdA } });
});
describe('Propositions d’épargne post-revenu RÉEL', () => {
  it('1. règle FIXED → suggestion = fixedAmount, source = compte du revenu', async () => {
    const plan = await postPlan(tokenA, {
      month: MONTH,
      mode: 'FIXED',
      fixedAmount: '50000.00',
    });
    expect(plan.status).toBe(201);

    await fund(tokenA, accountsA.mvola, '0');
    await incomeOn(tokenA, accountsA.mvola, '500000.00');

    const next = await getNext(tokenA);
    expect(next.status).toBe(200);
    const suggestion = next.body.suggestion;
    expect(suggestion).not.toBeNull();
    expect(Number(suggestion.rule.fixedAmount)).toBe(50000);
    expect(Number(suggestion.suggestedAmount)).toBe(50000);
    expect(suggestion.sourceAccount.id).toBe(accountsA.mvola);
    expect(suggestion.sourceAccount.type).toBe('MVOLA');
    expect(Number(suggestion.income.amount)).toBe(500000);
  });

  it('2. règle PERCENTAGE → suggestion = pourcentage × CE revenu', async () => {
    const plan = await postPlan(tokenA, {
      month: MONTH,
      mode: 'PERCENTAGE',
      percentage: '10',
    });
    expect(plan.status).toBe(201);

    await incomeOn(tokenA, accountsA.bank, '500000.00');

    const next = await getNext(tokenA);
    expect(next.status).toBe(200);
    const suggestion = next.body.suggestion;
    expect(suggestion.rule).toEqual({ mode: 'PERCENTAGE', percentage: '10' });
    expect(Number(suggestion.suggestedAmount)).toBe(50000);
    expect(suggestion.incomeMonth).toBe(MONTH);
  });

  it('3. le montant peut être MODIFIÉ avant confirmation', async () => {
    await postPlan(tokenA, { month: MONTH, mode: 'FIXED', fixedAmount: '50000.00' });
    await fund(tokenA, accountsA.mvola, '0');
    await incomeOn(tokenA, accountsA.mvola, '500000.00');

    const next = await getNext(tokenA);
    const id = next.body.suggestion.id as string;

    const confirmed = await confirmSuggestion(tokenA, id, { amount: '30000.00' });
    expect(confirmed.status).toBe(200);
    expect(Number(confirmed.body.transfer.amount)).toBe(30000);
    expect(confirmed.body.transfer.source.type).toBe('MVOLA');
    expect(confirmed.body.transfer.destination.type).toBe('SAVINGS');
    expect(confirmed.body.suggestion.status).toBe('CONFIRMED');
  });

  it('4. « Ignorer » → plus aucune proposition (décision persistante)', async () => {
    await incomeOn(tokenA, accountsA.bank, '200000.00');
    const before = await dashboard(tokenA);
    const totalBefore = before.totalAvailable;

    const next = await getNext(tokenA);
    const id = next.body.suggestion.id as string;
    const dismissed = await dismissSuggestion(tokenA, id);
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.status).toBe('DISMISSED');

    const after = await getNext(tokenA);
    expect(after.status).toBe(200);
    expect(after.body.suggestion).toBeNull();

    // Aucune mutation financière liée à la proposition.
    const afterDash = await dashboard(tokenA);
    expect(afterDash.totalAvailable).toBe(totalBefore);
  });

  it('5. « Ignorer » persiste après un rechargement (GET /next répété)', async () => {
    await incomeOn(tokenA, accountsA.mvola, '120000.00');
    const next = await getNext(tokenA);
    const id = next.body.suggestion.id as string;
    await dismissSuggestion(tokenA, id);

    const reload = await getNext(tokenA);
    expect(reload.body.suggestion).toBeNull();
    const reload2 = await getNext(tokenA);
    expect(reload2.body.suggestion).toBeNull();

    const row = await prisma.savingsSuggestion.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });
    expect(row.status).toBe('DISMISSED');
  });

  it('6-8. confirmation → UN transfert, source diminue, Épargne augmente, Total dispo baisse', async () => {
    await postPlan(tokenA, { month: MONTH, mode: 'FIXED', fixedAmount: '60000.00' });
    await fund(tokenA, accountsA.cash, '300000.00');
    await incomeOn(tokenA, accountsA.cash, '500000.00');

    const before = await dashboard(tokenA);
    const savingsBefore = before.accounts.find((a) => a.type === 'SAVINGS')!.balance;
    const cashBefore = before.accounts.find((a) => a.id === accountsA.cash)!.balance;
    const totalBefore = before.totalAvailable;

    const next = await getNext(tokenA);
    const id = next.body.suggestion.id as string;
    const confirmed = await confirmSuggestion(tokenA, id, { amount: '60000.00' });
    expect(confirmed.status).toBe(200);

    const after = await dashboard(tokenA);
    const savingsAfter = after.accounts.find((a) => a.type === 'SAVINGS')!.balance;
    const cashAfter = after.accounts.find((a) => a.id === accountsA.cash)!.balance;

    expect(Number(cashAfter)).toBe(Number(cashBefore) - 60000);
    expect(Number(savingsAfter)).toBe(Number(savingsBefore) + 60000);
    expect(Number(after.totalAvailable)).toBe(Number(totalBefore) - 60000);

    const transferCount = await prisma.accountTransfer.count({
      where: { userId: userIdA, deletedAt: null },
    });
    expect(transferCount).toBe(1);

    // Aucune Transaction EXPENSE/INCOME créée par la confirmation.
    const txRows = await prisma.transaction.findMany({
      where: { userId: userIdA, deletedAt: null },
      select: { type: true },
    });
    expect(txRows).toHaveLength(1);
    expect(txRows[0]!.type).toBe('INCOME');
  });

  it('9-12. aucun double comptage : 1 contribution, second confirm → 409, aucune 2e écriture', async () => {
    const plan = await postPlan(tokenA, { month: MONTH, mode: 'FIXED', fixedAmount: '40000.00' });
    const planId = plan.body.plan.id as string;
    await fund(tokenA, accountsA.bank, '0');
    await incomeOn(tokenA, accountsA.bank, '400000.00');

    const next = await getNext(tokenA);
    const id = next.body.suggestion.id as string;
    await confirmSuggestion(tokenA, id, { amount: '40000.00' });

    const contributions = await prisma.savingsContribution.count({
      where: { savingsPlanId: planId },
    });
    expect(contributions).toBe(1);

    const transfers = await prisma.accountTransfer.findMany({
      where: { userId: userIdA, deletedAt: null },
      select: { id: true },
    });
    expect(transfers).toHaveLength(1);

    const retry = await confirmSuggestion(tokenA, id, { amount: '40000.00' });
    expect(retry.status).toBe(409);

    const transfersAfterRetry = await prisma.accountTransfer.count({
      where: { userId: userIdA, deletedAt: null },
    });
    expect(transfersAfterRetry).toBe(1);
  });

  it('13. confirmation > disponible réel de la source → refus (jamais négatif)', async () => {
    await postPlan(tokenA, { month: MONTH, mode: 'FIXED', fixedAmount: '300000.00' });
    await fund(tokenA, accountsA.mvola, '40000.00');
    await incomeOn(tokenA, accountsA.mvola, '10000.00');

    const next = await getNext(tokenA);
    const id = next.body.suggestion.id as string;
    const refused = await confirmSuggestion(tokenA, id, { amount: '60000.00' });
    expect(refused.status).toBe(400);
    const transferCount = await prisma.accountTransfer.count({
      where: { userId: userIdA },
    });
    expect(transferCount).toBe(0);
  });

  it('14-15. ExpectedIncome PENDING futur/UNCERTAIN → aucune proposition ; RECEIVED → proposition', async () => {
    const future = await postExpectedIncome(tokenA, {
      amount: '800000.00',
      certainty: 'CONFIRMED',
      description: 'Salaire',
      expectedDate: '2026-10-01',
    });
    expect(future.status).toBe(201);
    const uncertain = await postExpectedIncome(tokenA, {
      amount: '200000.00',
      certainty: 'UNCERTAIN',
      description: 'Bonus',
      expectedDate: '2026-09-20',
    });
    expect(uncertain.status).toBe(201);

    const none = await getNext(tokenA);
    expect(none.body.suggestion).toBeNull();

    const id = future.body.expectedIncome.id as string;
    const received = await confirmReceived(tokenA, id, {
      amount: '800000.00',
      occurredAt: DATE,
      allocations: [{ accountId: accountsA.cash, amount: '800000.00' }],
    });
    expect(received.status).toBe(201);

    const next = await getNext(tokenA);
    expect(next.body.suggestion).not.toBeNull();
    expect(Number(next.body.suggestion.income.amount)).toBe(800000);
    expect(next.body.suggestion.incomeMonth).toBe(MONTH);
  });

  it('16. un transfert n’est pas un revenu → aucune proposition', async () => {
    await fund(tokenA, accountsA.bank, '100000.00');
    const res = await postTransfer(tokenA, {
      sourceAccountId: accountsA.bank,
      destinationAccountId: accountsA.cash,
      amount: '25000.00',
      occurredAt: DATE,
    });
    expect(res.status).toBe(201);

    const next = await getNext(tokenA);
    expect(next.body.suggestion).toBeNull();
  });

  it('17. idempotence reload : un seul PENDING par revenu (même id aux lectures)', async () => {
    await incomeOn(tokenA, accountsA.bank, '150000.00');
    const first = await getNext(tokenA);
    const second = await getNext(tokenA);
    expect(first.body.suggestion.id).toBe(second.body.suggestion.id);
    const pending = await prisma.savingsSuggestion.count({
      where: { userId: userIdA, status: 'PENDING' },
    });
    expect(pending).toBe(1);
  });
});

describe('Retraits manuels de l’Épargne', () => {
  it('18. retrait → destination créditée, Épargne diminue, Total disponible AUGMENTE', async () => {
    await fund(tokenA, accountsA.bank, '500000.00');
    const deposit = await postTransfer(tokenA, {
      sourceAccountId: accountsA.bank,
      destinationAccountId: accountsA.savings,
      amount: '200000.00',
      occurredAt: DATE,
    });
    expect(deposit.status).toBe(201);

    const before = await dashboard(tokenA);
    const savingsBefore = Number(before.accounts.find((a) => a.type === 'SAVINGS')!.balance);
    const bankBefore = Number(before.accounts.find((a) => a.id === accountsA.bank)!.balance);
    const totalBefore = Number(before.totalAvailable);

    const withdraw = await postWithdrawal(tokenA, {
      destinationAccountId: accountsA.bank,
      amount: '50000.00',
      occurredAt: DATE,
    });
    expect(withdraw.status).toBe(201);
    expect(Number(withdraw.body.transfer.amount)).toBe(50000);
    expect(withdraw.body.transfer.source.type).toBe('SAVINGS');
    expect(withdraw.body.transfer.destination.type).toBe('BANK');

    const after = await dashboard(tokenA);
    const savingsAfter = Number(after.accounts.find((a) => a.type === 'SAVINGS')!.balance);
    const bankAfter = Number(after.accounts.find((a) => a.id === accountsA.bank)!.balance);
    expect(bankAfter).toBe(bankBefore + 50000);
    expect(savingsAfter).toBe(savingsBefore - 50000);
    expect(Number(after.totalAvailable)).toBe(totalBefore + 50000);
  });

  it('19. retrait > solde Épargne → 400 et aucune écriture', async () => {
    await fund(tokenA, accountsA.bank, '100000.00');
    await postTransfer(tokenA, {
      sourceAccountId: accountsA.bank,
      destinationAccountId: accountsA.savings,
      amount: '10000.00',
      occurredAt: DATE,
    });

    const refused = await postWithdrawal(tokenA, {
      destinationAccountId: accountsA.bank,
      amount: '20000.00',
      occurredAt: DATE,
    });
    expect(refused.status).toBe(400);

    const transfers = await prisma.accountTransfer.count({ where: { userId: userIdA } });
    expect(transfers).toBe(1);
  });

  it('20. destination = Épargne ou inconnue → refus', async () => {
    await fund(tokenA, accountsA.bank, '50000.00');
    await postTransfer(tokenA, {
      sourceAccountId: accountsA.bank,
      destinationAccountId: accountsA.savings,
      amount: '10000.00',
      occurredAt: DATE,
    });

    const same = await postWithdrawal(tokenA, {
      destinationAccountId: accountsA.savings,
      amount: '5000.00',
      occurredAt: DATE,
    });
    expect(same.status).toBe(400);

    const unknown = await postWithdrawal(tokenA, {
      destinationAccountId: '00000000-0000-4000-8000-000000000000',
      amount: '5000.00',
      occurredAt: DATE,
    });
    expect(unknown.status).toBe(404);
  });

  it('21. ajout manuel réel (source → Épargne) sans aucune Transaction', async () => {
    await fund(tokenA, accountsA.mvola, '250000.00');
    const before = await dashboard(tokenA);
    const savingsBefore = Number(before.accounts.find((a) => a.type === 'SAVINGS')!.balance);

    const add = await postTransfer(tokenA, {
      sourceAccountId: accountsA.mvola,
      destinationAccountId: accountsA.savings,
      amount: '100000.00',
      feeAmount: '0',
      occurredAt: DATE,
      description: 'Ajout manuel',
    });
    expect(add.status).toBe(201);

    const after = await dashboard(tokenA);
    const savingsAfter = Number(after.accounts.find((a) => a.type === 'SAVINGS')!.balance);
    expect(savingsAfter).toBe(savingsBefore + 100000);
    const txRows = await prisma.transaction.count({ where: { userId: userIdA } });
    expect(txRows).toBe(0);
  });
});

