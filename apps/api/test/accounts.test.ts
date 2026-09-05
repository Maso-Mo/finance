import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import type { AccountType } from '@finance/shared-types';

const PASSWORD = 'correct-horse-battery-staple';
const SIX_TYPES: AccountType[] = [
  'BANK',
  'MVOLA',
  'ORANGE_MONEY',
  'AIRTEL_MONEY',
  'CASH',
  'SAVINGS',
];

let tokenA = '';
let tokenB = '';
let accountACashId = '';
let accountABankId = '';

async function register(email: string): Promise<string> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: PASSWORD });
  expect(res.status).toBe(201);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  await prisma.refreshSession.deleteMany();
  await prisma.user.deleteMany();

  tokenA = await register('account-a@example.com');
  tokenB = await register('account-b@example.com');

  const dashA = await request(app)
    .get('/accounts')
    .set('Authorization', `Bearer ${tokenA}`);
  const cash = dashA.body.accounts.find(
    (a: { type: string }) => a.type === 'CASH',
  );
  const bank = dashA.body.accounts.find(
    (a: { type: string }) => a.type === 'BANK',
  );
  accountACashId = (cash as { id: string }).id;
  accountABankId = (bank as { id: string }).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function expectNoSecrets(body: unknown): void {
  expect(JSON.stringify(body)).not.toContain('passwordHash');
}

describe('GET /accounts', () => {
  it('non authentifié → 401', async () => {
    const res = await request(app).get('/accounts');
    expect(res.status).toBe(401);
    expectNoSecrets(res.body);
  });

  it('l’inscription crée les 6 comptes standards, devise MGA, total 0', async () => {
    const res = await request(app)
      .get('/accounts')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const types = res.body.accounts.map((a: { type: string }) => a.type).sort();
    expect(types).toEqual([...SIX_TYPES].sort());
    for (const a of res.body.accounts) {
      expect(a.currency).toBe('MGA');
      expect(a.initialBalance).toBe('0');
    }
    expect(res.body.currency).toBe('MGA');
    expect(res.body.totalAvailable).toBe('0');
    expectNoSecrets(res.body);
  });

  it('un utilisateur ne voit que ses propres comptes', async () => {
    const resB = await request(app)
      .get('/accounts')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(resB.status).toBe(200);
    const idsA = new Set(
      (
        await request(app)
          .get('/accounts')
          .set('Authorization', `Bearer ${tokenA}`)
      ).body.accounts.map((a: { id: string }) => a.id),
    );
    for (const a of resB.body.accounts) {
      expect(idsA.has(a.id as string)).toBe(false);
    }
  });
});

describe('PATCH /accounts/:id', () => {
  it('met à jour son propre compte et recale le total disponible', async () => {
    const patch = await request(app)
      .patch(`/accounts/${accountACashId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ initialBalance: '150000' });
    expect(patch.status).toBe(200);
    expect(patch.body.account.initialBalance).toBe('150000');
    expect(patch.body.account.type).toBe('CASH');
    expect(patch.body.totalAvailable).toBe('150000');
    expectNoSecrets(patch.body);
  });

  it('met à jour plusieurs comptes (ex. Banque) et total = somme hors épargne', async () => {
    const patchBank = await request(app)
      .patch(`/accounts/${accountABankId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ initialBalance: '200000' });
    expect(patchBank.status).toBe(200);
    // CASH 150000 + BANK 200000 = 350000 (pas d’épargne renseignée).
    expect(patchBank.body.totalAvailable).toBe('350000');
  });

  it('utilisateur A ne peut pas modifier le compte de B → 404', async () => {
    const res = await request(app)
      .patch(`/accounts/${accountACashId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ initialBalance: '999999' });
    expect(res.status).toBe(404);
    expectNoSecrets(res.body);

    // La valeur n'a pas changé.
    const dashA = await request(app)
      .get('/accounts')
      .set('Authorization', `Bearer ${tokenA}`);
    const cash = dashA.body.accounts.find(
      (a: { type: string }) => a.type === 'CASH',
    );
    expect((cash as { initialBalance: string }).initialBalance).toBe('150000');
  });

  it('montant invalide → 400', async () => {
    for (const bad of ['abc', '-5', 'Infinity', '1.234', 'NaN', '']) {
      const res = await request(app)
        .patch(`/accounts/${accountACashId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ initialBalance: bad });
      expect(res.status, `amount=${JSON.stringify(bad)}`).toBe(400);
    }
    expectNoSecrets({});
  });

  it('compte inconnu → 404', async () => {
    const res = await request(app)
      .patch('/accounts/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ initialBalance: '100' });
    expect(res.status).toBe(404);
  });
});

describe('devise', () => {
  it('préférence de devise appliquée à l’utilisateur et à ses comptes', async () => {
    const prefs = await request(app)
      .patch('/me/preferences')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ currency: 'EUR' });
    expect(prefs.status).toBe(204);

    const dashB = await request(app)
      .get('/accounts')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(dashB.status).toBe(200);
    expect(dashB.body.currency).toBe('EUR');
    for (const a of dashB.body.accounts) {
      expect(a.currency).toBe('EUR');
    }
  });
});
