import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { dateInputToDate } from '../src/dates.js';
import { runNotificationMaintenance } from '../src/notifications/notification-scheduler.js';
import { sendWebPush } from '../src/notifications/push-transport.js';

/**
 * WEB PUSH + SUBSCRIPTIONS (étape 12) — API.
 *
 * Le TRANSPORT est MOCKÉ (sendWebPush) : aucun vrai fournisseur Push n'est
 * contacté. On contrôle succès, 404/410 (abonnement expiré) et erreur
 * temporaire. Contrats couverts : ownership strict, endpoint UNIQUE, plusieurs
 * navigateurs, désactivation logique, aucune clé sensible renvoyée par l'API,
 * pas de delivery dupliquée, centre interne intact en cas d'échec Push.
 */

vi.mock('../src/notifications/push-transport.js', () => ({
  sendWebPush: vi.fn(),
}));

const PASSWORD = 'correct-horse-battery-staple';
const NOW = '2026-09-20T09:30:00.000Z';

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
  await prisma.pushNotificationDelivery.deleteMany();
  await prisma.appNotification.deleteMany();
  await prisma.notificationPreference.deleteMany();
  await prisma.pushSubscription.deleteMany();
  await prisma.debtSettlement.deleteMany();
  await prisma.debt.deleteMany();
  await prisma.plannedExpense.deleteMany();
  await prisma.expectedIncome.deleteMany();
  await prisma.recurringExpenseRule.deleteMany();
}

beforeAll(async () => {
  // VAPID « de test » : assez pour activer la branche d'envoi ; le transport
  // étant mocké, aucune vraie clé cryptographique n'est nécessaire.
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = 'test-private-key';
  process.env.WEB_PUSH_VAPID_SUBJECT = 'mailto:test@example.com';

  await prisma.refreshSession.deleteMany();
  await cleanDomain();
  await prisma.user.deleteMany();
  const a = await register('push-a@example.com');
  const b = await register('push-b@example.com');
  tokenA = a.token;
  tokenB = b.token;
  userA = a.id;
});

beforeEach(async () => {
  await cleanDomain();
  vi.mocked(sendWebPush).mockReset();
  vi.mocked(sendWebPush).mockResolvedValue({ ok: true });
});

afterAll(async () => {
  delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  delete process.env.WEB_PUSH_VAPID_SUBJECT;
  await prisma.$disconnect();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const ENDPOINT_A =
  'https://push.example.test/sub/a-000000000000000000000001';
const ENDPOINT_B =
  'https://push.example.test/sub/a-000000000000000000000002';

async function createSubscription(
  token: string,
  endpoint: string = ENDPOINT_A,
): Promise<Record<string, unknown>> {
  const res = await request(app)
    .post('/push-subscriptions')
    .set(auth(token))
    .send({ endpoint, p256dh: 'p256dh-value', auth: 'auth-value' });
  expect(res.status).toBe(201);
  return res.body.subscription as Record<string, unknown>;
}

async function setPref(
  token: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await request(app)
    .patch('/notification-preferences')
    .set(auth(token))
    .send({ timezone: 'UTC', localTime: '00:00', ...body });
  expect(res.status).toBe(200);
}

// ------------------------------------------------------------ SUBSCRIPTIONS --

describe('PushSubscriptions — CRUD, ownership, unicité', () => {
  it('57. création → aucun secret (p256dh/auth/endpoint) renvoyé', async () => {
    const sub = await createSubscription(tokenA);
    expect(sub.id).toBeTruthy();
    expect(Object.keys(sub).sort()).toEqual(['createdAt', 'disabledAt', 'id']);
  });

  it('57bis. endpoint dupliqué par le MÊME utilisateur → géré proprement', async () => {
    const first = await createSubscription(tokenA);
    const second = await createSubscription(tokenA);
    expect(second.id).toBe(first.id);
    expect(await prisma.pushSubscription.count()).toBe(1);
  });

  it('57ter. plusieurs navigateurs/appareils autorisés', async () => {
    const one = await createSubscription(tokenA, ENDPOINT_A);
    const two = await createSubscription(tokenA, ENDPOINT_B);
    expect(one.id).not.toBe(two.id);
    const res = await request(app).get('/push-subscriptions').set(auth(tokenA));
    expect(res.body.subscriptions).toHaveLength(2);
    expect((res.body.subscriptions[0] as { id: string }).id).toBe(one.id);
  });

  it('57quater. endpoint déjà utilisé par un AUTRE utilisateur → 409', async () => {
    await createSubscription(tokenA);
    const res = await request(app)
      .post('/push-subscriptions')
      .set(auth(tokenB))
      .send({ endpoint: ENDPOINT_A, p256dh: 'x', auth: 'y' });
    expect(res.status).toBe(409);
  });

  it('58. ownership : B ne peut pas désactiver un endpoint de A (404)', async () => {
    const sub = await createSubscription(tokenA);
    const res = await request(app)
      .delete(`/push-subscriptions/${sub.id}`)
      .set(auth(tokenB));
    expect(res.status).toBe(404);
    const row = await prisma.pushSubscription.findUniqueOrThrow({
      where: { id: sub.id as string },
    });
    expect(row.disabledAt).toBeNull();
  });

  it('35. désactivation logique → plus d’envois, notifications internes intactes', async () => {
    await setPref(tokenA, { browserPushEnabled: true });
    await createSubscription(tokenA);
    await prisma.plannedExpense.create({
      data: {
        userId: userA,
        amount: '50000',
        currency: 'MGA',
        dueDate: dateInputToDate('2026-09-20'),
        categoryUnknown: true,
      },
    });

    const sub = (
      await request(app).get('/push-subscriptions').set(auth(tokenA))
    ).body.subscriptions[0] as { id: string };
    const res = await request(app)
      .delete(`/push-subscriptions/${sub.id}`)
      .set(auth(tokenA));
    expect(res.status).toBe(204);

    vi.mocked(sendWebPush).mockClear();
    await runNotificationMaintenance(NOW);
    expect(vi.mocked(sendWebPush)).not.toHaveBeenCalled();
    // Le centre interne garde le rappel malgré le push désactivé.
    expect(await prisma.appNotification.count()).toBe(1);
    expect(await prisma.pushNotificationDelivery.count()).toBe(0);
  });
});

// ---------------------------------------------------------------- DELIVERY --

describe('Livraison Web Push (transport mocké)', () => {
  it('58. notification envoyée à l’abonnement actif — payload générique', async () => {
    await setPref(tokenA, { browserPushEnabled: true });
    await createSubscription(tokenA);
    await prisma.plannedExpense.create({
      data: {
        userId: userA,
        amount: '50000',
        currency: 'MGA',
        dueDate: dateInputToDate('2026-09-20'),
        categoryUnknown: true,
      },
    });

    await runNotificationMaintenance(NOW);
    expect(vi.mocked(sendWebPush)).toHaveBeenCalledTimes(1);

    const payload = (vi.mocked(sendWebPush).mock.calls[0]?.[1] ?? {}) as {
      title?: string;
      route?: string;
      body?: string;
    };
    expect(payload.title).toBe('Finance');
    expect(payload.route).toBe('/planned');
    // Confidentialité par défaut : AUCUN montant dans le push.
    expect(String(payload.body)).not.toMatch(/50\s*000|Ar/);

    const delivery = await prisma.pushNotificationDelivery.findFirstOrThrow();
    expect(delivery.status).toBe('SENT');
    expect(delivery.sentAt).not.toBeNull();
  });

  it('48. showAmountsInPush=true → le montant apparaît (concis)', async () => {
    await setPref(tokenA, { browserPushEnabled: true, showAmountsInPush: true });
    await createSubscription(tokenA);
    await prisma.expectedIncome.create({
      data: {
        userId: userA,
        amount: '120000',
        currency: 'MGA',
        certainty: 'CONFIRMED',
        status: 'PENDING',
        expectedDate: dateInputToDate('2026-09-20'),
      },
    });

    await runNotificationMaintenance(NOW);
    expect(vi.mocked(sendWebPush)).toHaveBeenCalledTimes(1);
    const payload = (vi.mocked(sendWebPush).mock.calls[0]?.[1] ?? {}) as {
      body?: string;
    };
    expect(String(payload.body)).toContain('120 000');
  });

  it('58. pas de delivery dupliquée (double run, UNIQUE DB)', async () => {
    await setPref(tokenA, { browserPushEnabled: true });
    await createSubscription(tokenA);
    await prisma.plannedExpense.create({
      data: {
        userId: userA,
        amount: '50000',
        currency: 'MGA',
        dueDate: dateInputToDate('2026-09-20'),
        categoryUnknown: true,
      },
    });

    await runNotificationMaintenance(NOW);
    vi.mocked(sendWebPush).mockClear();
    await runNotificationMaintenance(NOW);

    expect(vi.mocked(sendWebPush)).not.toHaveBeenCalled();
    expect(await prisma.pushNotificationDelivery.count()).toBe(1);
    const delivery = await prisma.pushNotificationDelivery.findFirstOrThrow();
    expect(delivery.status).toBe('SENT');
  });

  it('58. 404/410 du fournisseur → abonnement désactivé, centre intact', async () => {
    vi.mocked(sendWebPush).mockResolvedValue({
      ok: false,
      code: 'SUBSCRIPTION_GONE',
    });
    await setPref(tokenA, { browserPushEnabled: true });
    const sub = await createSubscription(tokenA);
    await prisma.plannedExpense.create({
      data: {
        userId: userA,
        amount: '50000',
        currency: 'MGA',
        dueDate: dateInputToDate('2026-09-20'),
        categoryUnknown: true,
      },
    });

    await runNotificationMaintenance(NOW);

    const dbSub = await prisma.pushSubscription.findUniqueOrThrow({
      where: { id: sub.id as string },
    });
    expect(dbSub.disabledAt).not.toBeNull();
    const delivery = await prisma.pushNotificationDelivery.findFirstOrThrow();
    expect(delivery.status).toBe('FAILED');
    expect(delivery.lastErrorCode).toBe('SUBSCRIPTION_GONE');
    // La notification interne est préservée (jamais de rollback).
    expect(await prisma.appNotification.count()).toBe(1);
  });

  it('58. erreur temporaire → notification interne intacte, delivery FAILED', async () => {
    vi.mocked(sendWebPush).mockResolvedValue({ ok: false, code: 'SEND_FAILED' });
    await setPref(tokenA, { browserPushEnabled: true });
    const sub = await createSubscription(tokenA);
    await prisma.plannedExpense.create({
      data: {
        userId: userA,
        amount: '50000',
        currency: 'MGA',
        dueDate: dateInputToDate('2026-09-20'),
        categoryUnknown: true,
      },
    });

    await runNotificationMaintenance(NOW);

    expect(await prisma.appNotification.count()).toBe(1);
    const delivery = await prisma.pushNotificationDelivery.findFirstOrThrow();
    expect(delivery.status).toBe('FAILED');
    expect(delivery.lastErrorCode).toBe('SEND_FAILED');
    const dbSub = await prisma.pushSubscription.findUniqueOrThrow({
      where: { id: sub.id as string },
    });
    expect(dbSub.disabledAt).toBeNull(); // erreur temporaire ≠ endpoint mort
  });

  it('34. sans consentement (browserPushEnabled=false) → aucun envoi', async () => {
    await setPref(tokenA, { browserPushEnabled: false });
    await createSubscription(tokenA);
    await prisma.plannedExpense.create({
      data: {
        userId: userA,
        amount: '50000',
        currency: 'MGA',
        dueDate: dateInputToDate('2026-09-20'),
        categoryUnknown: true,
      },
    });

    await runNotificationMaintenance(NOW);
    expect(vi.mocked(sendWebPush)).not.toHaveBeenCalled();
    expect(await prisma.appNotification.count()).toBe(1); // centre interne actif
    expect(await prisma.pushNotificationDelivery.count()).toBe(0);
  });
});


