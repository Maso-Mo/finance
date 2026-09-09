import { createServer, preview } from 'vite';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const webURL = process.env.FINANCE_WEB_URL ?? 'http://localhost:5173';
const buildURL = process.env.FINANCE_BUILD_URL ?? 'http://localhost:4173';
const output = process.env.FINANCE_SCREENSHOTS ?? '/tmp/finance-validation';
await mkdir(output, { recursive: true });
let managedServer, managedPreview, managedAPI;
if (process.env.FINANCE_MANAGED_WEB === '1') {
  const apiFile = `${output}/local-api.mjs`;
  await writeFile(apiFile, `import { app } from '${resolve('apps/api/dist/app.js')}';\nconst server = app.listen(4000, '127.0.0.1');\nprocess.on('SIGTERM', () => server.close(() => process.exit(0)));\n`);
  managedAPI = spawn(process.execPath, [apiFile], { cwd: resolve('apps/api'), env: { ...process.env, CORS_ORIGIN: `${webURL},${buildURL}` }, stdio: ['ignore', 'ignore', 'pipe'] });
  for (let i = 0; i < 50; i++) { try { if ((await fetch('http://127.0.0.1:4000/health')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 200)); }
  managedServer = await createServer({ root: resolve('apps/web'), configFile: resolve('apps/web/vite.config.ts'), server: { host: '127.0.0.1', port: Number(new URL(webURL).port), strictPort: true } });
  await managedServer.listen();
  managedPreview = await preview({ root: resolve('apps/web'), configFile: resolve('apps/web/vite.config.ts'), preview: { host: '127.0.0.1', port: Number(new URL(buildURL).port), strictPort: true } });
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath(), headless: true });
const report = { screenshots: [], geometry: [], console: [], expectedHttpErrors: [], pageerrors: [], auth: {}, offline: {} };
const password = 'Finance-validation-2026!';
const email = `chromium-${Date.now()}@example.com`;
const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1366, height: 768 } });
const page = await context.newPage();
let expectedNetworkFailure = false;
page.on('console', message => {
  if (!['error', 'warning'].includes(message.type())) return;
  if (expectedNetworkFailure && /Failed to load resource/.test(message.text())) return;
  if (/401/.test(message.text()) && /\/auth\/(refresh|login)/.test(message.location().url)) { report.expectedHttpErrors.push(message.location().url); return; }
  report.console.push(message.text());
});
page.on('pageerror', error => report.pageerrors.push(error.message));
const capture = async name => { const path = `${output}/${name}.png`; await page.screenshot({ path, fullPage: false }); report.screenshots.push(path); };
async function closeGuide() { await page.waitForTimeout(650); const close = page.getByRole('button', { name: 'Quitter le guide sans rien enregistrer' }); if (await close.isVisible()) await close.click(); }
async function checkDialog(name) {
  const dialog = page.getByRole('dialog', { name, exact: true }); await dialog.waitFor();
  const rect = await dialog.boundingBox(), viewport = page.viewportSize();
  assert(rect.x >= 15 && rect.y >= 15 && rect.x + rect.width <= viewport.width - 15 && rect.y + rect.height <= viewport.height - 15, JSON.stringify({ name, rect, viewport }));
  const visible = await dialog.evaluate(el => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + 20); return el.contains(top); }); assert(visible, 'dialog under overlay');
  const description = await dialog.getAttribute('aria-describedby'); assert((await page.locator(`#${description}`).innerText()).length > 20);
  for (let i = 0; i < 9; i++) { await page.keyboard.press('Tab'); assert(await dialog.evaluate(el => el.contains(document.activeElement)), 'focus escaped'); }
  report.geometry.push({ name, viewport, rect });
  return dialog;
}
try {
  await page.goto(`${webURL}/register`);
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel(/Mot de passe/).fill(password);
  await page.getByRole('button', { name: 'S’inscrire' }).click();
  await checkDialog('Total disponible'); report.auth.register = true;
  await closeGuide();
  // Seed the registered test account through real authenticated API mutations.
  await page.evaluate(async ({ email, password }) => {
    const login = await fetch('/api/auth/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }).then(r => r.json());
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` };
    const dashboard = await fetch('/api/accounts', { headers }).then(r => r.json());
    const bank = dashboard.accounts.find(a => a.type === 'BANK').id;
    const cash = dashboard.accounts.find(a => a.type === 'CASH').id;
    const now = new Date();
    for (let month = 0; month < 6; month++) {
      const date = new Date(Date.UTC(now.getFullYear(), now.getMonth() - month, 8)).toISOString().slice(0, 10);
      for (const [type, amount, description] of [['INCOME', String(500000 + month * 25000), 'Salaire de démonstration'], ['EXPENSE', String(120000 + month * 7000), 'Courses et transport']]) {
        const response = await fetch('/api/transactions', { method: 'POST', headers, body: JSON.stringify({ type, amount, description, ...(type === 'EXPENSE' ? { categoryUnknown: true } : {}), occurredAt: date, allocations: [{ accountId: bank, amount }] }) });
        if (!response.ok) throw new Error(await response.text());
      }
    }
    const transfer = await fetch('/api/transfers', { method: 'POST', headers, body: JSON.stringify({ sourceAccountId: bank, destinationAccountId: cash, amount: '25000', feeAmount: '500', occurredAt: new Date().toISOString().slice(0, 10), description: 'Retrait de démonstration' }) });
    if (!transfer.ok) throw new Error(await transfer.text());
    const budget = await fetch('/api/budgets', { method: 'POST', headers, body: JSON.stringify({ month: new Date().toISOString().slice(0,7), amount: '200000' }) }); if (!budget.ok) throw new Error(await budget.text());
  }, { email, password });
  await page.reload(); await page.locator('#guide-analytics button').first().waitFor(); await closeGuide();
  const cookie = (await context.cookies()).find(c => c.name === 'finance_refresh');
  assert(cookie?.httpOnly && cookie.path === '/api/auth' && cookie.sameSite === 'Lax'); report.auth.cookie = { httpOnly: cookie.httpOnly, path: cookie.path, sameSite: cookie.sameSite, secure: cookie.secure };
  await page.getByRole('button', { name: 'Déconnexion', exact: true }).first().click(); await page.waitForURL('**/login');
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Mot de passe', { exact: true }).fill(password); await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await page.locator('#guide-total').waitFor(); await page.reload(); await page.locator('#guide-total').waitFor(); report.auth.loginRefresh = true; await closeGuide();
  for (const viewport of [{ width: 390, height: 844 }, { width: 1366, height: 768 }, { width: 360, height: 800 }]) {
    await page.setViewportSize(viewport);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { localStorage.setItem('finance.theme-preference', theme); }, theme); await page.goto(`${webURL}/`); await page.locator('#guide-analytics button').first().waitFor(); await closeGuide();
      await page.evaluate(() => document.fonts.ready); assert(await page.evaluate(() => document.fonts.check('16px Inter') && getComputedStyle(document.body).fontFamily.startsWith('Inter')));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const prefix = `${viewport.width}-${theme}`;
      await capture(`${prefix}-home`);
      await page.getByRole('button', { name: 'Détails', exact: true }).click();
      assert.equal(await page.locator('li li').count(), 0); await page.getByRole('button', { name: 'Masquer les détails' }).click();
      await page.locator('#guide-analytics').scrollIntoViewIfNeeded(); await capture(`${prefix}-graphs`);
      if (viewport.width < 1024) await page.getByRole('button', { name: 'Plus', exact: true }).click();
      await page.getByRole('button', { name: /prise en main/i }).filter({ visible: true }).click();
      await checkDialog('Total disponible'); await capture(`${prefix}-guide-total`);
      for (let i = 0; i < 13; i++) await page.getByRole('dialog').last().getByRole('button', { name: /Suivant/ }).click();
      await checkDialog('Comptabilité'); await capture(`${prefix}-guide-accounting`);
      await page.getByRole('button', { name: "J'ai compris, terminer le guide", exact: true }).click();
      await page.getByRole('dialog', { name: 'Terminer le guide ?' }).waitFor();
      await page.getByRole('button', { name: 'Terminer', exact: true }).click(); await page.getByRole('dialog', { name: 'Terminer le guide ?' }).waitFor({ state: 'hidden' });
      await page.goto(`${webURL}/accounting`); await page.getByRole('heading', { name: 'Vérification des comptes' }).waitFor(); await page.getByText('Salaire de démonstration').filter({ visible: true }).first().waitFor(); await page.getByRole('button', { name: 'Vérifier le solde', exact: true }).first().waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await capture(`${prefix}-accounting`);
    }
  }
  assert.equal(await page.getByRole('button', { name: 'Vérifier le solde', exact: true }).count(), 6);
  await page.getByRole('button', { name: 'Vérifier le solde', exact: true }).first().click();
  const correctionDialog = page.getByRole('dialog');
  await correctionDialog.getByRole('textbox').fill('123456');
  await correctionDialog.getByRole('button', { name: 'Vérifier l’écart', exact: true }).click();
  await correctionDialog.getByText(/Écart :/).waitFor();
  await correctionDialog.getByRole('button', { name: 'Corriger le solde', exact: true }).click();
  await correctionDialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Corrections', exact: true }).click();
  await page.getByText('Correction du solde', { exact: true }).filter({ visible: true }).first().waitFor();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Exporter la période/ }).click();
  const download = await downloadPromise;
  assert(download.suggestedFilename().endsWith('.csv'));
  await download.saveAs(`${output}/accounting.csv`);
  report.accounting = { sixAccounts: true, correctionConfirmed: true, journalFilter: true, csv: true };
  // Built app + real Service Worker, distinct localhost port but same auth cookie host.
  await page.goto(`${buildURL}/`); await page.locator('#guide-analytics button').first().waitFor();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await page.reload(); await page.locator('#guide-analytics button').first().waitFor();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  expectedNetworkFailure = true; await context.setOffline(true); await page.reload();
  await page.getByRole('button', { name: 'Consulter mes données hors connexion' }).click();
  await page.locator('#guide-analytics').getByText('Hors connexion', { exact: true }).waitFor();
  assert.equal(await page.locator('#guide-analytics button[aria-label]').count(), 6);
  await capture('offline-home'); report.offline.reload = true;
  await page.getByRole('button', { name: 'Détails', exact: true }).click();
  const edit = page.locator('#guide-total li').first(); await edit.getByRole('button').click(); await edit.locator('input').fill('1'); await edit.getByRole('button', { name: /Enregistrer|OK|Valider/ }).click();
  await page.getByText('Cette action nécessite une connexion à Finance.', { exact: true }).waitFor(); report.offline.mutationBlocked = true;
  await context.setOffline(false); await page.locator('#guide-analytics').getByText('Hors connexion', { exact: true }).waitFor({ state: 'hidden', timeout: 45000 }); report.offline.resync = true;
  expectedNetworkFailure = false;
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByRole('button', { name: 'Déconnexion', exact: true }).filter({ visible: true }).click();
  await page.waitForURL('**/login');
  const snapshotsAfterLogout = await page.evaluate(async () => {
    const db = await new Promise((resolve,reject) => {const r=indexedDB.open('finance-read-snapshots-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const rows = await new Promise(resolve=>{const r=db.transaction('snapshots').objectStore('snapshots').getAll();r.onsuccess=()=>resolve(r.result);}); db.close(); return rows;
  });
  assert.equal(snapshotsAfterLogout.length, 0); report.offline.logoutCleanup = true;
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Mot de passe', { exact: true }).fill('Incorrect-password-2026!'); await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await page.getByRole('alert').filter({hasText:'Email ou mot de passe incorrect.'}).waitFor(); report.auth.badPassword = true;
  assert.deepEqual(report.pageerrors, []); assert.deepEqual(report.console, []);
  report.passed = true;
} catch (error) { report.failure = String(error.stack); await capture('failure'); process.exitCode = 1; }
finally { await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, failure: report.failure, screenshots: report.screenshots.length, console: report.console, pageerrors: report.pageerrors }, null, 2)); await browser.close(); await managedServer?.close(); managedPreview?.httpServer.close(); managedAPI?.kill('SIGTERM'); }
