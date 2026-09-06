import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { dateInputToDate } from '../src/dates.js';
import {
  financialForecastResponseSchema,
  type FinancialForecastResponse,
} from '@finance/shared-types';

/**
 * PRÉVISION FINANCIÈRE DE FIN DE MOIS (correctif 8.1) — GET /forecast.
 *
 * GET STRICTEMENT READ-ONLY : lectures (comptes/transactions dérivées,
 * PlannedExpense, ExpectedIncome) + calcul. Aucune écriture, aucun changement
 * de statut, aucune génération, aucune table Forecast.
 *
 * Contrat V1 : la prévision financière n'existe QUE pour le MOIS COURANT (mois
 * contenant `today`). Elle vaut :
 *   monthEndAvailableForecast =
 *     availableToday − pendingPlannedExpensesTotal + confirmedExpectedIncomeTotal
 * (les revenus UNCERTAIN restent séparés, jamais inclus).
 */

const PASSWORD = 'correct-horse-battery-staple';

type AccountIds = {
  cash: string;
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
  return { cash: by('CASH'), savings: by('SAVINGS') };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function getForecast(token: string, query = '') {
  return request(app).get(`/forecast${query}`).set(auth(token));
}

function setTarget(token: string, accountId: string, targetBalance: string) {
  return request(app)
    .patch(`/accounts/${accountId}`)
    .set(auth(token))
    .send({ targetBalance });
}

function postPlanned(token: string, body: Record<string, unknown>) {
  return request(app)
    .post('/planned-expenses')
    .set(auth(token))
    .send(body);
}

function deletePlanned(token: string, id: string) {
  return request(app).delete(`/planned-expenses/${id}`).set(auth(token));
}

function postIncome(token: string, body: Record<string, unknown>) {
  return request(app)
    .post('/expected-incomes')
    .set(auth(token))
    .send(body);
}

function deleteIncome(token: string, id: string) {
  return request(app).delete(`/expected-incomes/${id}`).set(auth(token));
}

function confirmPaid(token: string, id: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/planned-expenses/${id}/confirm-paid`)
    .set(auth(token))
    .send(body);
}

function confirmReceived(
  token: string,
  id: string,
  body: Record<string, unknown>,
) {
  return request(app)
    .post(`/expected-incomes/${id}/confirm-received`)
    .set(auth(token))
    .send(body);
}

/** « Je veux que le solde connu devienne X » via l'API (initialBalance ici). */
async function fund(token: string, accountId: string, amount: string) {
  const res = await setTarget(token, accountId, amount);
  expect(res.status).toBe(200);
}

/** Crée une PlannedExpense PENDING ponctuelle et renvoie son id. */
async function plannedPending(token: string, amount: string, dueDate: string) {
  const res = await postPlanned(token, {
    amount,
    dueDate,
    categoryUnknown: true,
    description: 'Obligation prévue',
  });
  expect(res.status).toBe(201);
  return (res.body.plannedExpense as { id: string }).id;
}

/** Crée un ExpectedIncome PENDING (date exacte) et renvoie son id. */
async function incomePending(
  token: string,
  amount: string,
  certainty: 'CONFIRMED' | 'UNCERTAIN',
  expectedDate: string,
) {
  const res = await postIncome(token, { amount, certainty, expectedDate });
  expect(res.status).toBe(201);
  return (res.body.expectedIncome as { id: string }).id;
}

async function forecastOf(
  token: string,
  today = '2026-09-15',
): Promise<FinancialForecastResponse> {
  const res = await getForecast(token, `?today=${today}`);
  expect(res.status).toBe(200);
  return financialForecastResponseSchema.parse(res.body);
}

beforeAll(async () => {
  await prisma.monthlyBudget.deleteMany();
  await prisma.expectedIncome.deleteMany();
  await prisma.plannedExpense.deleteMany();
  await prisma.recurringExpenseRule.deleteMany();
  await prisma.transactionAccountAllocation.deleteMany();
  await prisma.accountAdjustment.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.user.deleteMany();

  tokenA = await register('forecast-a@example.com');
  tokenB = await register('forecast-b@example.com');
  accountsA = await idsOf(tokenA);
  accountsB = await idsOf(tokenB);
});

beforeEach(async () => {
  await prisma.monthlyBudget.deleteMany();
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

describe('GET /forecast — sécurité & read-only', () => {
  it('non authentifié → 401 ; today invalide → 400', async () => {
    expect((await request(app).get('/forecast')).status).toBe(401);
    expect((await getForecast(tokenA, '?today=2026-13-01')).status).toBe(400);
    expect((await getForecast(tokenA, '?today=20260910')).status).toBe(400);
  });

  it('GET strictement READ-ONLY : aucune ligne créée ni modifiée', async () => {
    await fund(tokenA, accountsA.cash, '500000');
    await plannedPending(tokenA, '100000', '2026-09-20');
    const incomeId = await incomePending(tokenA, '200000', 'CONFIRMED', '2026-09-18');

    const snapshot = async () => ({
      planned: await prisma.plannedExpense.count(),
      incomes: await prisma.expectedIncome.count(),
      transactions: await prisma.transaction.count(),
      allocations: await prisma.transactionAccountAllocation.count(),
      adjustments: await prisma.accountAdjustment.count(),
    });
    const before = await snapshot();
    const incomeStatusBefore = (
      await prisma.expectedIncome.findUnique({ where: { id: incomeId } })
    )?.status;

    for (let i = 0; i < 3; i += 1) {
      await forecastOf(tokenA);
    }
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(
      (await prisma.expectedIncome.findUnique({ where: { id: incomeId } }))
        ?.status,
    ).toBe(incomeStatusBefore);
  });
});

describe('Prévision financière — disponible aujourd’hui & épargne exclue', () => {
  it('availableToday = Total disponible réel (Cash), Épargne EXCLUE', async () => {
    await fund(tokenA, accountsA.cash, '100000');
    await fund(tokenA, accountsA.savings, '1000000');
    const forecast = await forecastOf(tokenA);
    expect(forecast.availableToday).toBe('100000');
    expect(forecast.pendingPlannedExpensesTotal).toBe('0');
    expect(forecast.confirmedExpectedIncomeTotal).toBe('0');
    expect(forecast.monthEndAvailableForecast).toBe('100000');
  });

  it('mois couvert = mois de today (septembre 2026) et monthEnd au 30/09', async () => {
    await plannedPending(tokenA, '50000', '2026-09-30');
    const forecast = await forecastOf(tokenA);
    expect(forecast.month).toBe('2026-09');
    expect(forecast.today).toBe('2026-09-15');
    expect(forecast.pendingPlannedExpensesTotal).toBe('50000');
  });
});


describe('Dépenses planifiées — seules les PENDING dues à l’horizon sortent', () => {
  it('PENDING due dans le mois → soustraite du forecast', async () => {
    await fund(tokenA, accountsA.cash, '500000');
    await plannedPending(tokenA, '200000', '2026-09-20');
    const forecast = await forecastOf(tokenA);
    expect(forecast.pendingPlannedExpensesTotal).toBe('200000');
    expect(forecast.monthEndAvailableForecast).toBe('300000');
  });

  it('PENDING en RETARD (due passée, toujours PENDING) → toujours soustraite', async () => {
    await fund(tokenA, accountsA.cash, '400000');
    await plannedPending(tokenA, '120000', '2026-09-05');
    const forecast = await forecastOf(tokenA, '2026-09-20');
    expect(forecast.pendingPlannedExpensesTotal).toBe('120000');
    expect(forecast.monthEndAvailableForecast).toBe('280000');
  });

  it('PENDING dont l’échéance DÉPASSE le mois → non soustraite', async () => {
    await fund(tokenA, accountsA.cash, '400000');
    await plannedPending(tokenA, '150000', '2026-10-05');
    const forecast = await forecastOf(tokenA);
    expect(forecast.pendingPlannedExpensesTotal).toBe('0');
    expect(forecast.monthEndAvailableForecast).toBe('400000');
  });

  it('PAID → NON soustraite (sa Transaction EXPENSE est déjà dans availableToday)', async () => {
    await fund(tokenA, accountsA.cash, '500000');
    const plannedId = await plannedPending(tokenA, '200000', '2026-09-20');
    const confirm = await confirmPaid(tokenA, plannedId, {
      amount: '200000',
      occurredAt: '2026-09-20',
      categoryUnknown: true,
      allocations: [{ accountId: accountsA.cash, amount: '200000' }],
    });
    expect(confirm.status).toBe(201);
    expect(confirm.body.plannedExpense.status).toBe('PAID');
    const forecast = await forecastOf(tokenA);
    expect(forecast.availableToday).toBe('300000');
    expect(forecast.pendingPlannedExpensesTotal).toBe('0');
    // PAID déjà déduit du réel : la soustraire ENCORE donnerait 100 000.
    expect(forecast.monthEndAvailableForecast).toBe('300000');
  });

  it('CANCELED → non soustraite', async () => {
    await fund(tokenA, accountsA.cash, '400000');
    const plannedId = await plannedPending(tokenA, '90000', '2026-09-25');
    const del = await deletePlanned(tokenA, plannedId);
    expect(del.status).toBe(200);
    expect(del.body.plannedExpense.status).toBe('CANCELED');
    const forecast = await forecastOf(tokenA);
    expect(forecast.pendingPlannedExpensesTotal).toBe('0');
    expect(forecast.monthEndAvailableForecast).toBe('400000');
  });

  it('SKIPPED → non soustraite', async () => {
    await fund(tokenA, accountsA.cash, '400000');
    // Insertion directe : une occurrence récurrente ignorée (statut SKIPPED).
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'forecast-a@example.com' },
      select: { id: true },
    });
    await prisma.plannedExpense.create({
      data: {
        userId: user.id,
        amount: '70000',
        dueDate: dateInputToDate('2026-09-25'),
        status: 'SKIPPED',
      },
    });
    const forecast = await forecastOf(tokenA);
    expect(forecast.pendingPlannedExpensesTotal).toBe('0');
    expect(forecast.monthEndAvailableForecast).toBe('400000');
  });
});


describe('Revenus futurs — seuls CONFIRMED PENDING attendus à l’horizon entrent', () => {
  it('CONFIRMED PENDING à date exacte dans le mois → ajouté', async () => {
    await fund(tokenA, accountsA.cash, '200000');
    await incomePending(tokenA, '300000', 'CONFIRMED', '2026-09-18');
    const forecast = await forecastOf(tokenA);
    expect(forecast.confirmedExpectedIncomeTotal).toBe('300000');
    expect(forecast.monthEndAvailableForecast).toBe('500000');
  });

  it('CONFIRMED PENDING à date exacte le DERNIER jour du mois → ajouté', async () => {
    await incomePending(tokenA, '150000', 'CONFIRMED', '2026-09-30');
    const forecast = await forecastOf(tokenA);
    expect(forecast.confirmedExpectedIncomeTotal).toBe('150000');
    expect(forecast.monthEndAvailableForecast).toBe('150000');
  });

  it('CONFIRMED PENDING avec expectedDate le MOIS SUIVANT → NON ajouté', async () => {
    await incomePending(tokenA, '150000', 'CONFIRMED', '2026-10-01');
    const forecast = await forecastOf(tokenA);
    expect(forecast.confirmedExpectedIncomeTotal).toBe('0');
    expect(forecast.monthEndAvailableForecast).toBe('0');
  });

  it('CONFIRMED PENDING en PLAGE dont windowEnd ≤ fin de mois → ajouté (borne de fin)', async () => {
    const res = await postIncome(tokenA, {
      amount: '500000',
      certainty: 'CONFIRMED',
      windowStart: '2026-09-20',
      windowEnd: '2026-09-30',
    });
    expect(res.status).toBe(201);
    const forecast = await forecastOf(tokenA);
    expect(forecast.confirmedExpectedIncomeTotal).toBe('500000');
  });

  it('CONFIRMED PENDING en PLAGE dont windowEnd DÉPASSE la fin du mois → NON ajouté', async () => {
    const res = await postIncome(tokenA, {
      amount: '500000',
      certainty: 'CONFIRMED',
      windowStart: '2026-09-25',
      windowEnd: '2026-10-05',
    });
    expect(res.status).toBe(201);
    const forecast = await forecastOf(tokenA);
    expect(forecast.confirmedExpectedIncomeTotal).toBe('0');
    expect(forecast.monthEndAvailableForecast).toBe('0');
  });

  it('CONFIRMED PENDING EN RETARD (date passée, toujours PENDING) → reste compté', async () => {
    await incomePending(tokenA, '120000', 'CONFIRMED', '2026-09-10');
    const forecast = await forecastOf(tokenA, '2026-09-20');
    expect(forecast.confirmedExpectedIncomeTotal).toBe('120000');
  });

  it('RECEIVED → NON ajouté (sa Transaction INCOME est déjà dans availableToday)', async () => {
    const incomeId = await incomePending(tokenA, '300000', 'CONFIRMED', '2026-09-18');
    const confirm = await confirmReceived(tokenA, incomeId, {
      amount: '300000',
      occurredAt: '2026-09-18',
      allocations: [{ accountId: accountsA.cash, amount: '300000' }],
    });
    expect(confirm.status).toBe(201);
    expect(confirm.body.expectedIncome.status).toBe('RECEIVED');
    const forecast = await forecastOf(tokenA);
    expect(forecast.availableToday).toBe('300000');
    expect(forecast.confirmedExpectedIncomeTotal).toBe('0');
    // L'ajouter ENCORE donnerait 600 000 : il vaut exactement le réel.
    expect(forecast.monthEndAvailableForecast).toBe('300000');
  });

  it('CANCELED → non ajouté', async () => {
    const incomeId = await incomePending(tokenA, '250000', 'CONFIRMED', '2026-09-20');
    const del = await deleteIncome(tokenA, incomeId);
    expect(del.status).toBe(200);
    expect(del.body.expectedIncome.status).toBe('CANCELED');
    const forecast = await forecastOf(tokenA);
    expect(forecast.confirmedExpectedIncomeTotal).toBe('0');
  });
});


describe('Formule & cas combinés', () => {
  it('500 000 − 200 000 + 300 000 = 600 000 ; 1 000 000 incertain SÉPARÉ', async () => {
    await fund(tokenA, accountsA.cash, '500000');
    await plannedPending(tokenA, '200000', '2026-09-20');
    await incomePending(tokenA, '300000', 'CONFIRMED', '2026-09-18');
    const uncertainRes = await postIncome(tokenA, {
      amount: '1000000',
      certainty: 'UNCERTAIN',
      windowStart: '2026-09-20',
      windowEnd: '2026-09-30',
    });
    expect(uncertainRes.status).toBe(201);

    const forecast = await forecastOf(tokenA);
    expect(forecast.availableToday).toBe('500000');
    expect(forecast.pendingPlannedExpensesTotal).toBe('200000');
    expect(forecast.confirmedExpectedIncomeTotal).toBe('300000');
    expect(forecast.monthEndAvailableForecast).toBe('600000');
    // 1 000 000 incertain : jamais dans le résultat principal (PAS 1 600 000).
    expect(forecast.uncertainIncomePotential).toBe('1000000');
  });

  it('UNCERTAIN PENDING seul → séparé, forecast inchangé', async () => {
    await incomePending(tokenA, '800000', 'UNCERTAIN', '2026-09-25');
    const forecast = await forecastOf(tokenA);
    expect(forecast.uncertainIncomePotential).toBe('800000');
    expect(forecast.confirmedExpectedIncomeTotal).toBe('0');
    expect(forecast.monthEndAvailableForecast).toBe('0');
  });

  it('plusieurs dépenses prévues ET plusieurs revenus confirmés/incertains', async () => {
    await fund(tokenA, accountsA.cash, '1000000');
    await plannedPending(tokenA, '150000', '2026-09-15');
    await plannedPending(tokenA, '250000', '2026-09-25');
    await incomePending(tokenA, '100000', 'CONFIRMED', '2026-09-10');
    const windowRes = await postIncome(tokenA, {
      amount: '200000',
      certainty: 'CONFIRMED',
      windowStart: '2026-09-20',
      windowEnd: '2026-09-27',
    });
    expect(windowRes.status).toBe(201);
    const uncertainRes = await postIncome(tokenA, {
      amount: '400000',
      certainty: 'UNCERTAIN',
      windowStart: '2026-09-25',
      windowEnd: '2026-09-30',
    });
    expect(uncertainRes.status).toBe(201);

    const forecast = await forecastOf(tokenA);
    expect(forecast.pendingPlannedExpensesTotal).toBe('400000');
    expect(forecast.confirmedExpectedIncomeTotal).toBe('300000');
    expect(forecast.uncertainIncomePotential).toBe('400000');
    // 1 000 000 − 400 000 + 300 000 = 900 000.
    expect(forecast.monthEndAvailableForecast).toBe('900000');
  });

  it('prévision NÉGATIVE jamais clampée à zéro', async () => {
    await fund(tokenA, accountsA.cash, '100000');
    await plannedPending(tokenA, '300000', '2026-09-25');
    const forecast = await forecastOf(tokenA);
    expect(forecast.monthEndAvailableForecast).toBe('-200000');
    expect(forecast.availableToday).toBe('100000');
  });

  it('isolation utilisateurs : les engagements de B n’affectent jamais A', async () => {
    await fund(tokenB, accountsB.cash, '700000');
    await plannedPending(tokenB, '500000', '2026-09-25');
    await incomePending(tokenB, '900000', 'CONFIRMED', '2026-09-18');

    const forecastA = await forecastOf(tokenA);
    expect(forecastA.availableToday).toBe('0');
    expect(forecastA.pendingPlannedExpensesTotal).toBe('0');
    expect(forecastA.confirmedExpectedIncomeTotal).toBe('0');
    expect(forecastA.monthEndAvailableForecast).toBe('0');

    const forecastB = await forecastOf(tokenB);
    expect(forecastB.availableToday).toBe('700000');
    expect(forecastB.pendingPlannedExpensesTotal).toBe('500000');
    expect(forecastB.confirmedExpectedIncomeTotal).toBe('900000');
    // 700 000 − 500 000 + 900 000 = 1 100 000.
    expect(forecastB.monthEndAvailableForecast).toBe('1100000');
  });
});

describe('DOUBLE COMPTAGE — avant/après confirmations réelles', () => {
  it('500 000 ; plan 200 000 ; revenu 300 000 → 600 000, puis paiement & réception réels', async () => {
    await fund(tokenA, accountsA.cash, '500000');
    const plannedId = await plannedPending(tokenA, '200000', '2026-09-20');
    const incomeId = await incomePending(tokenA, '300000', 'CONFIRMED', '2026-09-18');

    // Étape 1 : tout est encore PENDING → 500 − 200 + 300 = 600.
    let forecast = await forecastOf(tokenA);
    expect(forecast.availableToday).toBe('500000');
    expect(forecast.pendingPlannedExpensesTotal).toBe('200000');
    expect(forecast.confirmedExpectedIncomeTotal).toBe('300000');
    expect(forecast.monthEndAvailableForecast).toBe('600000');

    // Étape 2 : la dépense planifiée devient PAID (vraie Transaction EXPENSE).
    const paid = await confirmPaid(tokenA, plannedId, {
      amount: '200000',
      occurredAt: '2026-09-20',
      categoryUnknown: true,
      allocations: [{ accountId: accountsA.cash, amount: '200000' }],
    });
    expect(paid.status).toBe(201);
    expect(paid.body.plannedExpense.status).toBe('PAID');

    // Compte réel : 300 000. La PlannedExpense PAID n'est plus déduite.
    forecast = await forecastOf(tokenA);
    expect(forecast.availableToday).toBe('300000');
    expect(forecast.pendingPlannedExpensesTotal).toBe('0');
    expect(forecast.confirmedExpectedIncomeTotal).toBe('300000');
    // 300 000 + 300 000 = 600 000 (PAS 400 000 : la dépense n'est pas
    // comptée une seconde fois).
    expect(forecast.monthEndAvailableForecast).toBe('600000');

    // Étape 3 : le revenu devient RECEIVED (vraie Transaction INCOME).
    const received = await confirmReceived(tokenA, incomeId, {
      amount: '300000',
      occurredAt: '2026-09-18',
      allocations: [{ accountId: accountsA.cash, amount: '300000' }],
    });
    expect(received.status).toBe(201);
    expect(received.body.expectedIncome.status).toBe('RECEIVED');

    // Compte réel : 600 000. Le revenu RECEIVED n'est plus ajouté.
    forecast = await forecastOf(tokenA);
    expect(forecast.availableToday).toBe('600000');
    expect(forecast.pendingPlannedExpensesTotal).toBe('0');
    expect(forecast.confirmedExpectedIncomeTotal).toBe('0');
    // 600 000 + 0 = 600 000 (PAS 900 000 : le revenu n'est pas compté deux fois).
    expect(forecast.monthEndAvailableForecast).toBe('600000');
  });
});
