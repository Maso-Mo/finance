import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';

/**
 * PRISE EN MAIN GUIDÉE (onboarding) — API.
 *
 * Contrats couverts :
 *  - GET /me/onboarding (read-only strict) : { completed: boolean }, faux pour
 *    un nouveau compte ;
 *  - POST /me/onboarding/complete : idempotent, sans corps requis, mémorise la
 *    date de fin (completed devient true) ;
 *  - la complétion est PERSISTANTE et ne verrouille ni ne réinitialise rien :
 *    aucune donnée financière n'est créée/modifiée par ces routes ;
 *  - ownership : l'état d'un utilisateur n'affecte jamais celui d'un autre ;
 *  - requêtes non authentifiées → 401.
 */

const PASSWORD = 'correct-horse-battery-staple';
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let tokenA = '';
let tokenB = '';
let userA = '';

async function register(email: string): Promise<{ token: string; id: string }> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: PASSWORD });
  expect(res.status).toBe(201);
  return { token: res.body.accessToken as string, id: res.body.user.id as string };
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
  const a = await register('onboarding-a@example.com');
  const b = await register('onboarding-b@example.com');
  tokenA = a.token;
  tokenB = b.token;
  userA = a.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /me/onboarding (read-only)', () => {
  it('renvoie completed=false pour un nouveau compte', async () => {
    const res = await request(app)
      .get('/me/onboarding')
      .set(auth(tokenA));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ completed: false });
  });

  it('est strictement read-only : aucune écriture en base', async () => {
    const before = await prisma.transaction.count({ where: { userId: userA } });
    const res = await request(app)
      .get('/me/onboarding')
      .set(auth(tokenA));
    expect(res.status).toBe(200);
    expect(await prisma.transaction.count({ where: { userId: userA } })).toBe(before);
  });

  it('refuse les requêtes non authentifiées', async () => {
    const res = await request(app).get('/me/onboarding');
    expect(res.status).toBe(401);
  });
});

describe('POST /me/onboarding/complete', () => {
  it('mémorise la fin du parcours (completed passe à true)', async () => {
    const res = await request(app)
      .post('/me/onboarding/complete')
      .set(auth(tokenB))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ completed: true });

    const status = await request(app)
      .get('/me/onboarding')
      .set(auth(tokenB));
    expect(status.body).toEqual({ completed: true });
  });

  it('est idempotent : un second appel reste completed=true', async () => {
    const res = await request(app)
      .post('/me/onboarding/complete')
      .set(auth(tokenB))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ completed: true });
  });

  it('ne touche à AUCUNE donnée financière', async () => {
    const accountsBefore = await prisma.account.count({ where: { userId: userA } });
    const transactionsBefore = await prisma.transaction.count({
      where: { userId: userA },
    });
    await request(app)
      .post('/me/onboarding/complete')
      .set(auth(tokenA))
      .send({});
    expect(await prisma.account.count({ where: { userId: userA } })).toBe(
      accountsBefore,
    );
    expect(
      await prisma.transaction.count({ where: { userId: userA } }),
    ).toBe(transactionsBefore);
  });

  it('préserve l’ownership : l’état de B n’affecte pas A', async () => {
    // A vient de terminer ci-dessus → completed=true pour A également.
    const a = await request(app).get('/me/onboarding').set(auth(tokenA));
    const b = await request(app).get('/me/onboarding').set(auth(tokenB));
    expect(a.body).toEqual({ completed: true });
    expect(b.body).toEqual({ completed: true });
  });

  it('refuse les requêtes non authentifiées', async () => {
    const res = await request(app).post('/me/onboarding/complete').send({});
    expect(res.status).toBe(401);
  });
});
