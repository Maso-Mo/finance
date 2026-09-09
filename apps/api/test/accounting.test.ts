import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { csvCell } from '../src/accounting/accounting.service.js';
const password = 'Accounting-test-password-2026';
let token = '', otherToken = '', userId = '', bank = '', savings = '';
const auth = () => ({ Authorization: `Bearer ${token}` });
const month = new Date().toISOString().slice(0, 7);
const occurredAt = new Date(`${month}-08T12:00:00Z`);
beforeAll(async () => {
  const registered = await request(app).post('/auth/register').send({ email: `accounting-${Date.now()}@example.com`, password });
  expect(registered.status).toBe(201); token = registered.body.accessToken; userId = registered.body.user.id;
  const other = await request(app).post('/auth/register').send({ email: `accounting-other-${Date.now()}@example.com`, password });
  otherToken = other.body.accessToken;
  const accounts = await prisma.account.findMany({ where: { userId } });
  bank = accounts.find(a => a.type === 'BANK')!.id; savings = accounts.find(a => a.type === 'SAVINGS')!.id;
  for (const [type, amount, deletedAt, date] of [
    ['INCOME', '1000', null, occurredAt], ['EXPENSE', '250', null, occurredAt], ['INCOME', '999', new Date(), occurredAt], ['EXPENSE', '999', null, new Date('2020-01-01')],
  ] as const) await prisma.transaction.create({ data: { userId, type, amount, deletedAt, occurredAt: date, allocations: { create: { accountId: bank, amount } } } });
  await prisma.accountTransfer.create({ data: { userId, sourceAccountId: bank, destinationAccountId: savings, amount: '100', feeAmount: '5', occurredAt } });
  const debt = await prisma.debt.create({ data: { userId, direction: 'I_OWE', originalAmount: '100' } });
  await prisma.debtSettlement.create({ data: { userId, debtId: debt.id, accountId: bank, amount: '30', occurredAt } });
  const advance = await prisma.debt.create({ data: { userId, direction: 'OWED_TO_ME', kind: 'INCOME_ADVANCE_RECEIVABLE', originalAmount: '50' } });
  const tx = await prisma.transaction.create({ data: { userId, type: 'INCOME', amount: '50', occurredAt, allocations: { create: { accountId: bank, amount: '50' } } } });
  await prisma.debtSettlement.create({ data: { userId, debtId: advance.id, accountId: bank, amount: '50', occurredAt, linkedTransactionId: tx.id } });
});
afterAll(() => prisma.$disconnect());
describe('personal accounting reads', () => {
  it('income minus expense excludes internal moves, fees, savings and standard debt principal', async () => {
    const res = await request(app).get(`/accounting/overview?month=${month}`).set(auth());
    expect(res.status).toBe(200); expect(res.body).toMatchObject({ income: '1050.00', expense: '250.00', result: '800.00', internal: '100' });
    expect(res.body.accounts).toHaveLength(6);
  });
  it('unifies each transfer/advance once, excludes soft-deleted and outside-period entries', async () => {
    const res = await request(app).get(`/accounting/journal?month=${month}`).set(auth());
    expect(res.status).toBe(200); expect(res.body.total).toBe(5);
    expect(res.body.rows.filter((r: { type: string }) => r.type === 'Transfert')).toHaveLength(1);
    expect(res.body.rows.filter((r: { type: string }) => r.type === 'Avance/revenu')).toHaveLength(1);
  });
  it('paginates in deterministic global order and filters', async () => {
    const a = await request(app).get(`/accounting/journal?month=${month}&limit=2&page=1`).set(auth());
    const b = await request(app).get(`/accounting/journal?month=${month}&limit=2&page=2`).set(auth());
    expect(a.status).toBe(200); expect(a.body.rows).toHaveLength(2);
    expect(new Set([...a.body.rows, ...b.body.rows].map(row => row.id)).size).toBe(4);
    const debt = await request(app).get(`/accounting/journal?month=${month}&kind=DEBT`).set(auth());
    expect(debt.body.total).toBe(1);
  });
  it('enforces ownership and validates query parameters', async () => {
    const other = await request(app).get(`/accounting/journal?month=${month}`).set({ Authorization: `Bearer ${otherToken}` });
    expect(other.body.total).toBe(0);
    expect((await request(app).get('/accounting/journal?month=2026-13').set(auth())).status).toBe(400);
    expect((await request(app).get(`/accounting/journal?month=${month}&page=0`).set(auth())).status).toBe(400);
    expect((await request(app).get(`/accounting/overview?month=${month}`)).status).toBe(401);
  });
  it('GETs and CSV do not write; explicit correction uses AccountAdjustment', async () => {
    const before = await prisma.accountAdjustment.count({ where: { userId } });
    const txCount = await prisma.transaction.count({ where: { userId } });
    const csv = await request(app).get(`/accounting/export?month=${month}`).set(auth());
    expect(csv.status).toBe(200); expect(csv.text).toContain('Compte source');
    expect(await prisma.accountAdjustment.count({ where: { userId } })).toBe(before);
    expect(await prisma.transaction.count({ where: { userId } })).toBe(txCount);
    const corrected = await request(app).patch(`/accounts/${bank}`).set(auth()).send({ targetBalance: '700' });
    expect(corrected.status).toBe(200);
    expect(await prisma.accountAdjustment.count({ where: { userId } })).toBe(before + 1);
  });
  it('quotes CSV and prevents spreadsheet formula execution', () => {
    expect(csvCell('=SUM(1,2)')).toBe('"\'=SUM(1,2)"'); expect(csvCell('a"b')).toBe('"a""b"');
  });
});
