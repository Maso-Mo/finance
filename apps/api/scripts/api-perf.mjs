#!/usr/bin/env node
/**
 * api-perf — benchmark de lectures API authentifiées (dataset finance_perf).
 *
 * Usage :
 *   DATABASE_URL=… pnpm --filter @finance/api db:perf-seed   # une fois
 *   node scripts/api-perf.mjs http://localhost:4000 perf-benchmark@finance.local 'PerfBenchmark#2026'
 *
 * Mesure N répétitions par endpoint puis affiche p50/p95/p99 (ms) et l'échec
 * éventuel. Machine : documentée dans le rapport d'étape 14.
 */
const [base, email, password] = process.argv.slice(2);
if (!base || !email || !password) {
  console.error('Usage: node scripts/api-perf.mjs <base> <email> <password>');
  process.exit(2);
}

const REPEATS = Number(process.env.REPEATS ?? 30);

async function main() {
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) {
    throw new Error(`login failed: ${login.status} ${await login.text()}`);
  }
  const { accessToken } = await login.json();
  const headers = { authorization: `Bearer ${accessToken}` };

  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const endpoints = [
    ['GET /accounts', '/accounts'],
    ['GET /transactions', '/transactions?page=1&limit=20'],
    ['GET /planned-expenses', '/planned-expenses'],
    ['GET /reminders', `/reminders?date=${today}`],
    ['GET /expected-incomes', '/expected-incomes'],
    ['GET /income-reminders', `/income-reminders?month=${month}`],
    ['GET /budgets', `/budgets?month=${month}`],
    ['GET /forecast', '/forecast'],
    ['GET /transfers', '/transfers'],
    ['GET /savings-plans', '/savings-plans'],
    ['GET /debts', '/debts'],
    ['GET /notifications', '/notifications'],
  ];

  const results = [];
  for (const [label, path] of endpoints) {
    const samples = [];
    let lastStatus = 0;
    for (let i = 0; i < REPEATS; i++) {
      const start = performance.now();
      const res = await fetch(`${base}${path}`, { headers });
      const elapsed = performance.now() - start;
      lastStatus = res.status;
      samples.push(elapsed);
      if (res.status !== 200) {
        // Lire le corps une fois pour diagnostiquer.
        const text = await res.text();
        console.error(`  [${label}] status=${res.status} body=${text.slice(0, 140)}`);
        break;
      } else {
        await res.arrayBuffer();
      }
    }
    samples.sort((a, b) => a - b);
    const p = (q) => samples[Math.min(samples.length - 1, Math.floor((q / 100) * samples.length))] ?? 0;
    results.push({ label, n: samples.length, p50: p(50), p95: p(95), p99: p(99), max: samples.at(-1), status: lastStatus });
  }

  console.log('\nEndpoint | n | p50 | p95 | p99 | max | status');
  for (const r of results) {
    console.log(
      `${r.label} | ${r.n} | ${r.p50.toFixed(1)}ms | ${r.p95.toFixed(1)}ms | ${r.p99.toFixed(1)}ms | ${r.max.toFixed(1)}ms | ${r.status}`,
    );
  }
}

main().catch((error) => {
  console.error('bench failed:', error);
  process.exitCode = 1;
});
