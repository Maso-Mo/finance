import { Prisma } from '../generated/prisma/client.js';
import { toMoney } from '@finance/finance-core';
import type { AccountingKind, AccountingRow } from '@finance/shared-types';
import { prisma } from '../db.js';
import { getDashboard } from '../accounts/accounts.service.js';

export function monthRange(month: string) {
  const start = new Date(`${month}-01T00:00:00Z`);
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  return { gte: start, lt: end };
}

export async function getAccountingOverview(userId: string, month: string) {
  const occurredAt = monthRange(month);
  const [dashboard, transactions, transfers] = await Promise.all([
    getDashboard(userId),
    prisma.transaction.groupBy({ by: ['type'], where: { userId, deletedAt: null, occurredAt }, _sum: { amount: true } }),
    prisma.accountTransfer.aggregate({ where: { userId, deletedAt: null, occurredAt }, _sum: { amount: true } }),
  ]);
  const income = toMoney(transactions.find(row => row.type === 'INCOME')?._sum.amount?.toString() ?? '0');
  const expense = toMoney(transactions.find(row => row.type === 'EXPENSE')?._sum.amount?.toString() ?? '0');
  return { ...dashboard, month, income: income.toFixed(2), expense: expense.toFixed(2), result: income.minus(expense).toFixed(2), internal: transfers._sum.amount?.toString() ?? '0' };
}

// One read-only SQL union gives global ordering/pagination without downloading
// every model's complete history. All branches scope ownership and period.
function journalSQL(userId: string, month: string, kind: AccountingKind) {
  const { gte, lt } = monthRange(month);
  return Prisma.sql`
    WITH journal AS (
      SELECT 'tx:' || t.id::text AS id, t."occurredAt" AS date,
        CASE WHEN ds.id IS NOT NULL THEN 'Avance/revenu' WHEN t.type = 'INCOME' THEN 'Revenu' ELSE 'Dépense' END AS type,
        t.type::text AS kind, COALESCE(t.description, '') AS description,
        CASE WHEN t.type = 'EXPENSE' THEN COALESCE(a.accounts, 'Compte inconnu') ELSE '' END AS source,
        CASE WHEN t.type = 'INCOME' THEN COALESCE(a.accounts, 'Compte inconnu') ELSE '' END AS destination,
        COALESCE(c.name, 'Sans catégorie') AS category,
        CASE WHEN t.type = 'INCOME' THEN t.amount ELSE 0 END AS incoming,
        CASE WHEN t.type = 'EXPENSE' THEN t.amount ELSE 0 END AS outgoing, 0::numeric AS fees
      FROM transactions t
      LEFT JOIN categories c ON c.id = t."categoryId"
      LEFT JOIN debt_settlements ds ON ds."linkedTransactionId" = t.id AND ds."userId" = t."userId" AND ds."deletedAt" IS NULL
      LEFT JOIN LATERAL (SELECT string_agg(ac.type::text, ', ' ORDER BY ac.type) AS accounts
        FROM transaction_account_allocations al JOIN accounts ac ON ac.id = al."accountId"
        WHERE al."transactionId" = t.id AND ac."userId" = ${userId}::uuid) a ON true
      WHERE t."userId" = ${userId}::uuid AND t."deletedAt" IS NULL AND t."occurredAt" >= ${gte} AND t."occurredAt" < ${lt}
      UNION ALL
      SELECT 'transfer:' || t.id::text, t."occurredAt", 'Transfert', 'TRANSFER', COALESCE(t.description, ''),
        s.type::text, d.type::text, '', t.amount, t.amount, t."feeAmount"
      FROM account_transfers t JOIN accounts s ON s.id = t."sourceAccountId" JOIN accounts d ON d.id = t."destinationAccountId"
      WHERE t."userId" = ${userId}::uuid AND t."deletedAt" IS NULL AND t."occurredAt" >= ${gte} AND t."occurredAt" < ${lt}
      UNION ALL
      SELECT 'adjustment:' || a.id::text, a."createdAt", 'Correction', 'ADJUSTMENT', 'Correction du solde',
        CASE WHEN a.amount < 0 THEN ac.type::text ELSE '' END, CASE WHEN a.amount >= 0 THEN ac.type::text ELSE '' END, '',
        greatest(a.amount, 0), greatest(-a.amount, 0), 0
      FROM account_adjustments a JOIN accounts ac ON ac.id = a."accountId"
      WHERE a."userId" = ${userId}::uuid AND a."createdAt" >= ${gte} AND a."createdAt" < ${lt}
      UNION ALL
      SELECT 'debt:' || s.id::text, s."occurredAt", 'Remboursement de dette', 'DEBT', COALESCE(s.description, ''),
        CASE WHEN d.direction = 'I_OWE' THEN COALESCE(ac.type::text, 'Compte inconnu') ELSE '' END,
        CASE WHEN d.direction = 'OWED_TO_ME' THEN COALESCE(ac.type::text, 'Compte inconnu') ELSE '' END, '',
        CASE WHEN d.direction = 'OWED_TO_ME' THEN s.amount ELSE 0 END,
        CASE WHEN d.direction = 'I_OWE' THEN s.amount ELSE 0 END, 0
      FROM debt_settlements s JOIN debts d ON d.id = s."debtId" LEFT JOIN accounts ac ON ac.id = s."accountId"
      WHERE s."userId" = ${userId}::uuid AND d."userId" = ${userId}::uuid AND s."deletedAt" IS NULL AND d."deletedAt" IS NULL
        AND s."linkedTransactionId" IS NULL AND s."occurredAt" >= ${gte} AND s."occurredAt" < ${lt}
    ) SELECT * FROM journal WHERE (${kind} = 'ALL' OR kind = ${kind})`;
}

export async function getAccountingJournal(userId: string, month: string, kind: AccountingKind, page: number, limit: number) {
  const query = journalSQL(userId, month, kind);
  const [rows, counts] = await prisma.$transaction([
    prisma.$queryRaw<(Omit<AccountingRow, 'date'> & { date: Date })[]>(Prisma.sql`SELECT * FROM (${query}) j ORDER BY date DESC, id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`),
    prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`SELECT count(*) AS total FROM (${query}) j`),
  ], { isolationLevel: 'RepeatableRead' });
  return { rows: rows.map(row => ({ id: row.id, date: row.date.toISOString(), type: row.type, description: row.description,
    source: row.source, destination: row.destination, category: row.category,
    incoming: String(row.incoming), outgoing: String(row.outgoing), fees: String(row.fees) })), total: Number(counts[0]?.total ?? 0), page, limit };
}

export function csvCell(value: string) {
  // Prevent spreadsheet formulas when a description begins with =,+,-,@.
  const safe = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
