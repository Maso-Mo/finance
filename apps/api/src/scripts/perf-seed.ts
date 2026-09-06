import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { prisma } from '../db.js';

/**
 * perf-seed — jeu de données SYNTHÉTIQUE et déterministe pour benchmark.
 *
 * Usage :
 *   DATABASE_URL="postgresql://finance:***@localhost:5432/finance_perf?schema=public" \
 *     pnpm --filter @finance/api db:perf-seed
 *
 * ⚠ GARDE ANTI-DESTRUCTION : le script REFUSE de s'exécuter sur une base
 * réelle/quotidienne (finance_dev, finance_test, finance_prod, finance…).
 * Seules les bases explicitement dédiées au test/perf sont acceptées
 * (nom contenant perf, benchmark, probe ou e2e).
 *
 * Données générées pour UN utilisateur sur ~24 mois (déterministe pour un
 * jour d'exécution donné) :
 *   ~10 000 Transactions (+ allocations), 2 000 PlannedExpenses,
 *   1 000 ExpectedIncome, 2 000 Transfers, 250 dettes + règlements,
 *   budgets mensuels, plans d'épargne + contributions, notifications.
 * Les montants sont des chaînes décimales exactes (jamais de flottant).
 */

const DB_URL = process.env.DATABASE_URL ?? '';
function databaseName(url: string): string {
  const clean = url.replace(/["']/g, '');
  const match = /\/\/([^/@]+)@[^/]+\/([^?]+)/.exec(clean) ?? /[^/]+\/([^?]+)\??/.exec(clean);
  return match?.[2]?.split('?')[0] ?? '';
}

const LIVE = /^(finance_dev|finance_test|finance_prod|finance)$/;
const ALLOWED = /(perf|benchmark|probe|e2e)/;
function guard(): void {
  const db = databaseName(DB_URL);
  if (!db) {
    throw new Error('DATABASE_URL requise (ou apps/api/.env).');
  }
  if (LIVE.test(db)) {
    throw new Error(
      `REFUS : base réelle '${db}'. perf-seed s'exécute uniquement sur une base de benchmark (finance_perf, *_probe, *_e2e…).`,
    );
  }
  if (!ALLOWED.test(db)) {
    throw new Error(
      `REFUS : base '${db}' non explicitement dédiée au test/perf.`,
    );
  }
  console.log(`[perf-seed] base cible : ${db} (acceptée : benchmark).`);
}

// --- RNG déterministe (mulberry32) ---
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260906);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)] as T;
const int = (min: number, max: number): number =>
  Math.floor(min + rand() * (max - min + 1));
const money = (min: number, max: number): string =>
  `${int(min, max)}.00`;

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
/** Date UTC jour 1..28 (jamais le 29-31 : aucun risque d'invalidité). */
function dayInWindow(anchor: Date, monthsBack: number): Date {
  const d = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - monthsBack, 1),
  );
  d.setUTCDate(int(1, 28));
  return d;
}

const DAY = 86_400_000;

// --- Constantes de volume (échelle 1 = « années d'utilisation ») ---
const SCALE = Number(process.env.PERF_SCALE ?? 1);
const MONTHS_BACK = 24;
const MONTHS = Array.from({ length: MONTHS_BACK }, (_, m) => m);
const TX_TARGET = Math.round(10_000 * SCALE);

async function main(): Promise<void> {
  guard();

  const email = 'perf-benchmark@finance.local';
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log('[perf-seed] utilisateur déjà présent — suppression ciblée (utilisateur de bench uniquement).');
    // Nettoyage ciblé : uniquement les lignes de CET utilisateur, jamais une
    // autre base / un autre utilisateur.
    const userId = existing.id;
    await prisma.$transaction([
      prisma.transactionAccountAllocation.deleteMany({ where: { transaction: { userId } } }),
      prisma.appNotification.deleteMany({ where: { userId } }),
      prisma.assistantActionProposal.deleteMany({ where: { userId } }),
      prisma.assistantDraft.deleteMany({ where: { userId } }),
      prisma.recurringExpenseRule.deleteMany({ where: { userId } }),
      prisma.debtSettlement.deleteMany({ where: { userId } }),
      prisma.monthlyBudget.deleteMany({ where: { userId } }),
      prisma.accountAdjustment.deleteMany({ where: { userId } }),
      prisma.plannedExpense.deleteMany({ where: { userId } }),
      prisma.expectedIncome.deleteMany({ where: { userId } }),
      prisma.debt.deleteMany({ where: { userId } }),
      prisma.savingsContribution.deleteMany({ where: { savingsPlan: { userId } } }),
      prisma.accountTransfer.deleteMany({ where: { userId } }),
      prisma.monthlySavingsPlan.deleteMany({ where: { userId } }),
      prisma.transaction.deleteMany({ where: { userId } }),
      prisma.refreshSession.deleteMany({ where: { userId } }),
      prisma.account.deleteMany({ where: { userId } }),
      prisma.user.delete({ where: { id: userId } }),
    ]);
  }
  const anchor = new Date(Date.UTC(2026, 6 - 1, 15)); // juin 2026 — jour déterministe
  // --- Utilisateur + 6 comptes standards ---
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await argon2.hash('PerfBenchmark#2026'),
      currency: 'MGA',
    },
  });
  const typeList = ['BANK', 'MVOLA', 'ORANGE_MONEY', 'AIRTEL_MONEY', 'CASH', 'SAVINGS'] as const;
  const accountIds: Record<string, string> = {};
  for (const type of typeList) {
    const account = await prisma.account.create({
      data: {
        userId: user.id,
        type,
        currency: 'MGA',
        initialBalance: money(500_000, 8_000_000),
      },
    });
    accountIds[type] = account.id;
  }
  const spendingAccountIds = Object.values(accountIds).filter(
    (id) => id !== accountIds.SAVINGS,
  );

  const categories = await prisma.category.findMany({
    where: { isSystem: true, userId: null },
    select: { id: true },
  });
  const catIds = categories.map((c) => c.id);
  if (catIds.length === 0) {
    throw new Error('[perf-seed] Aucune catégorie système — exécutez d’abord pnpm db:seed.');
  }

  // --- Transactions (montants exacts, allocations cohérentes) ---
  const expenseIds: string[] = [];
  const incomeIds: string[] = [];
  {
    const CHUNK = 600;
    let txBuf: Array<Record<string, unknown>> = [];
    let allocBuf: Array<Record<string, unknown>> = [];
    const flush = async () => {
      if (txBuf.length > 0) {
        await prisma.transaction.createMany({ data: txBuf as never });
        await prisma.transactionAccountAllocation.createMany({ data: allocBuf as never });
        txBuf = [];
        allocBuf = [];
      }
    };
    for (let i = 0; i < TX_TARGET; i++) {
      const mb = pick(MONTHS);
      const occurredAt = dayInWindow(anchor, mb);
      const type = rand() < 0.3 ? 'INCOME' : 'EXPENSE';
      const accountUnknown = rand() < 0.03;
      const id = randomUUID();
      const row: Record<string, unknown> = {
        id,
        userId: user.id,
        type,
        amount: money(5_000, type === 'INCOME' ? 4_000_000 : 250_000),
        description: `Benchmark ${type} #${i}`,
        occurredAt,
        accountUnknown,
        categoryUnknown: type === 'EXPENSE' && rand() < 0.03,
        deletedAt: null,
      };
      if (type === 'EXPENSE' && !row.categoryUnknown) {
        row.categoryId = pick(catIds);
      }
      txBuf.push(row);
      if (!accountUnknown) {
        const accountId = pick(spendingAccountIds);
        allocBuf.push({
          id: randomUUID(),
          transactionId: id,
          accountId,
          amount: String(row.amount),
        });
      }
      (type === 'INCOME' ? incomeIds : expenseIds).push(id);
      if (txBuf.length >= CHUNK) {
        await flush();
      }
    }
    await flush();
  }
  console.log(`[perf-seed] transactions : ${TX_TARGET}`);
  // --- Helpeurs d'insertion en masse ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const insertInChunks = async (table: any, rows: any[]): Promise<void> => {
    for (let i = 0; i < rows.length; i += 600) {
      await table.createMany({ data: rows.slice(i, i + 600) });
    }
  };
  const monthKeyOf = (mb: number): string => {
    const d = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - mb, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  const monthsKey = MONTHS.map((mb) => monthKeyOf(mb));

  // --- PlannedExpenses (2 000) : PENDING/PAID/CANCELED/SKIPPED ---
  const PLANNED_TARGET = Math.round(2_000 * SCALE);
  {
    const rows: unknown[] = [];
    const expensePool = [...expenseIds].reverse();
    for (let i = 0; i < PLANNED_TARGET; i++) {
      const r = rand();
      const status = r < 0.6 ? 'PENDING' : r < 0.85 ? 'PAID' : r < 0.95 ? 'CANCELED' : 'SKIPPED';
      const categoryUnknown = rand() < 0.03;
      const row: Record<string, unknown> = {
        id: randomUUID(),
        userId: user.id,
        amount: money(10_000, 1_200_000),
        currency: 'MGA',
        dueDate: dayInWindow(anchor, int(0, MONTHS_BACK - 1)),
        description: `Benchmark planned #${i}`,
        status,
        categoryUnknown,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      if (!categoryUnknown) row.categoryId = pick(catIds);
      if (status === 'PAID' && expensePool.length > 0) {
        row.confirmedTransactionId = expensePool.pop();
      }
      rows.push(row);
    }
    await insertInChunks(prisma.plannedExpense, rows);
    console.log(`[perf-seed] planned_expenses : ${PLANNED_TARGET}`);
  }

  // --- ExpectedIncome (1 000) : PENDING/RECEIVED/CANCELED ---
  const EXPECTED_TARGET = Math.round(1_000 * SCALE);
  {
    const rows: unknown[] = [];
    const incomePool = [...incomeIds].reverse();
    for (let i = 0; i < EXPECTED_TARGET; i++) {
      const r = rand();
      const status = r < 0.65 ? 'PENDING' : r < 0.9 ? 'RECEIVED' : 'CANCELED';
      const useWindow = rand() < 0.25;
      const day = dayInWindow(anchor, int(0, 6));
      const row: Record<string, unknown> = {
        id: randomUUID(),
        userId: user.id,
        amount: money(50_000, 3_000_000),
        currency: 'MGA',
        certainty: rand() < 0.75 ? 'CONFIRMED' : 'UNCERTAIN',
        status,
        description: `Benchmark expected #${i}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      if (useWindow) {
        row.windowStart = new Date(day.getTime() - int(1, 5) * DAY);
        row.windowEnd = new Date(day.getTime() + int(1, 5) * DAY);
      } else {
        row.expectedDate = day;
      }
      if (status === 'RECEIVED' && incomePool.length > 0) {
        row.receivedTransactionId = incomePool.pop();
      }
      rows.push(row);
    }
    await insertInChunks(prisma.expectedIncome, rows);
    console.log(`[perf-seed] expected_incomes : ${EXPECTED_TARGET}`);
  }

  // --- Plans d'épargne (1 actif / mois) + contributions ---
  const planIdByMonth: Record<string, string> = {};
  {
    const rows = monthsKey.map((month) => ({
      id: randomUUID(),
      userId: user.id,
      month,
      mode: 'FIXED' as const,
      fixedAmount: money(100_000, 600_000),
      currency: 'MGA',
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    await insertInChunks(prisma.monthlySavingsPlan, rows as unknown[]);
    for (const row of rows) planIdByMonth[row.month] = row.id;
  }

  // --- Transfers (2 000) + contributions épargne liées ---
  const TRANSFER_TARGET = Math.round(2_000 * SCALE);
  {
    const savingsTransferRefs: Array<{ id: string; month: string }> = [];
    const rows: unknown[] = [];
    for (let i = 0; i < TRANSFER_TARGET; i++) {
      const mb = pick(MONTHS);
      const toSavings = rand() < 0.2;
      const sourceAccountId = pick(spendingAccountIds);
      const destinationAccountId = toSavings
        ? accountIds.SAVINGS
        : pick(spendingAccountIds.filter((id) => id !== sourceAccountId));
      const id = randomUUID();
      const row: Record<string, unknown> = {
        id,
        userId: user.id,
        sourceAccountId,
        destinationAccountId,
        amount: money(10_000, 1_500_000),
        feeAmount: rand() < 0.25 ? money(0, 5_000) : '0.00',
        currency: 'MGA',
        occurredAt: dayInWindow(anchor, mb),
        dateUnknown: false,
        deletedAt: null,
        description: `Benchmark transfer #${i}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.push(row);
      if (toSavings) savingsTransferRefs.push({ id, month: monthKeyOf(mb) });
    }
    await insertInChunks(prisma.accountTransfer, rows);

    // Contributions épargne : uniquement vers des plans existants du mois.
    const contribRows = savingsTransferRefs
      .filter((ref) => planIdByMonth[ref.month])
      .slice(0, Math.round(700 * SCALE))
      .map((ref) => ({
        id: randomUUID(),
        savingsPlanId: planIdByMonth[ref.month],
        transferId: ref.id,
        createdAt: new Date(),
      }));
    await insertInChunks(prisma.savingsContribution, contribRows as unknown[]);
    console.log(
      `[perf-seed] transfers : ${TRANSFER_TARGET}, contributions épargne : ${contribRows.length}`,
    );
  }
  // --- Dettes (250) + règlements (total <= original, parts exactes) ---
  const splitAmount = (total: number, parts: number): number[] => {
    if (parts === 1) return [total];
    const out: number[] = [];
    let left = total;
    for (let i = 0; i < parts - 1; i++) {
      const remainingSlots = parts - i - 1;
      const max = left - remainingSlots * 1_000;
      const p = int(1_000, Math.max(1_000, max));
      out.push(p);
      left -= p;
    }
    out.push(left);
    return out;
  };
  const DEBT_TARGET = Math.round(250 * SCALE);
  {
    const debtRows: unknown[] = [];
    const settleRows: unknown[] = [];
    for (let i = 0; i < DEBT_TARGET; i++) {
      const direction = rand() < 0.5 ? 'I_OWE' : 'OWED_TO_ME';
      const debtId = randomUUID();
      const total = int(50_000, 3_000_000);
      const settlementCount = int(1, 4);
      const parts = splitAmount(total, settlementCount);
      debtRows.push({
        id: debtId,
        userId: user.id,
        direction,
        kind: 'STANDARD',
        originalAmount: `${total}.00`,
        currency: 'MGA',
        counterpartyName: `Benchmark contact #${i}`,
        description: `Benchmark debt #${i}`,
        dueDate: dayInWindow(anchor, int(0, 6)),
        dueDateUnknown: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      for (const p of parts) {
        settleRows.push({
          id: randomUUID(),
          debtId,
          userId: user.id,
          amount: `${p}.00`,
          currency: 'MGA',
          accountId: pick(spendingAccountIds),
          accountUnknown: false,
          occurredAt: dayInWindow(anchor, int(0, 8)),
          dateUnknown: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }
    await insertInChunks(prisma.debt, debtRows);
    await insertInChunks(prisma.debtSettlement, settleRows);
    console.log(`[perf-seed] debts : ${DEBT_TARGET}, settlements : ${settleRows.length}`);
  }

  // --- Budgets mensuels (global + par catégorie, uniques) ---
  {
    const rows: unknown[] = [];
    for (const month of monthsKey) {
      rows.push({
        id: randomUUID(),
        userId: user.id,
        month,
        amount: money(500_000, 2_000_000),
        currency: 'MGA',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      for (const catId of catIds) {
        rows.push({
          id: randomUUID(),
          userId: user.id,
          month,
          amount: money(50_000, 800_000),
          currency: 'MGA',
          categoryId: catId,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }
    await insertInChunks(prisma.monthlyBudget, rows);
    console.log(`[perf-seed] monthly_budgets : ${rows.length}`);
  }
  // --- Notifications internes (4 000, clés de dédup uniques) ---
  const NOTIF_TARGET = Math.round(4_000 * SCALE);
  {
    const types = [
      'PLANNED_EXPENSE_DUE',
      'PLANNED_EXPENSE_OVERDUE',
      'EXPECTED_INCOME_DUE',
      'EXPECTED_INCOME_WINDOW',
      'EXPECTED_INCOME_OVERDUE',
      'DEBT_DUE',
      'DEBT_OVERDUE',
    ] as const;
    const sourceFamilies = ['PLANNED_EXPENSE', 'EXPECTED_INCOME', 'DEBT'] as const;
    const routes = ['/planned', '/expected', '/debts'] as const;
    const rows: unknown[] = [];
    for (let i = 0; i < NOTIF_TARGET; i++) {
      const type = pick(types);
      const localDate = dayInWindow(anchor, int(0, 23));
      const isRead = rand() < 0.55;
      rows.push({
        id: randomUUID(),
        userId: user.id,
        type,
        sourceType: pick(sourceFamilies),
        sourceId: randomUUID(),
        localDate,
        dedupeKey: `${user.id}:${type}:${i}`,
        title: 'Rappel benchmark',
        body: 'Benchmark notification',
        route: pick(routes),
        pushBody: rand() < 0.3 ? 'Rappel benchmark (push)' : null,
        isRead,
        readAt: isRead ? new Date() : null,
        createdAt: new Date(),
      });
    }
    await insertInChunks(prisma.appNotification, rows);
    console.log(`[perf-seed] notifications : ${NOTIF_TARGET}`);
  }

  // --- Récapitulatif ---
  const [txs, plannedCount, expectedCount, transfersCount, contributionsCount] = await prisma.$transaction([
    prisma.transaction.count({ where: { userId: user.id } }),
    prisma.plannedExpense.count({ where: { userId: user.id } }),
    prisma.expectedIncome.count({ where: { userId: user.id } }),
    prisma.accountTransfer.count({ where: { userId: user.id } }),
    prisma.savingsContribution.count({ where: { savingsPlan: { userId: user.id } } }),
  ]);
  console.log('[perf-seed] TERMINÉ — utilisateur de benchmark prêt.');
  console.log(
    `[perf-seed] user=${user.id} tx=${txs} planned=${plannedCount} expected=${expectedCount} ` +
      `transfers=${transfersCount} contributions=${contributionsCount}`,
  );
}

main()
  .catch((error) => {
    console.error('[perf-seed] failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
