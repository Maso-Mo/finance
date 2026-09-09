import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const address = process.env.FINANCE_LAN_IP ?? Object.entries(networkInterfaces()).filter(([name]) => /^(wl|en|eth)/.test(name)).flatMap(([, list]) => list).find(a => a.family === 'IPv4' && !a.internal)?.address;
if (!address) throw new Error('No LAN interface found. Set FINANCE_LAN_IP explicitly.');
const origin = `http://${address}:5175`;
const apiFile = '/tmp/finance-validation/lan-api.mts';
await writeFile(apiFile, `import { app } from '${resolve('apps/api/src/app.ts')}';\nconst server = app.listen(4001, '127.0.0.1');\nserver.on('request', req => { if (req.method === 'OPTIONS') console.log('PREFLIGHT ' + req.headers.origin); });\nprocess.on('SIGTERM', () => server.close(() => process.exit(0)));\n`);
const api = spawn(process.execPath, ['--import', 'tsx', apiFile], { cwd: resolve('apps/api'), env: { ...process.env, CORS_ORIGIN: `${origin},http://localhost:5176` }, stdio: ['ignore', 'pipe', 'pipe'] });
let preflightLog = ''; api.stdout.on('data', chunk => { preflightLog += chunk.toString(); });
let apiErrors = ''; api.stderr.on('data', chunk => { apiErrors += chunk.toString(); });
let vite, localVite, browser;
const report = { origin, httpLAN: false, auth: false, apiDown: false, preflight: false, pageerrors: [] };
try {
  for (let i = 0; i < 50; i++) { try { const res = await fetch('http://127.0.0.1:4001/health'); if (res.ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  vite = await createServer({ root: resolve('apps/web'), configFile: resolve('apps/web/vite.config.ts'), server: { host: address, port: 5175, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:4001' } } } });
  await vite.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath(), headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await context.newPage(); page.on('pageerror', error => report.pageerrors.push(error.message));
  await page.goto(`${origin}/register`); report.httpLAN = true;
  const email = `lan-${Date.now()}@example.com`, password = 'Finance-LAN-validation-2026!';
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel(/Mot de passe/).fill(password); await page.getByRole('button', { name: 'S’inscrire' }).click();
  await page.locator('#guide-total').waitFor(); await page.reload(); await page.locator('#guide-total').waitFor();
  const cookie = (await context.cookies()).find(c => c.name === 'finance_refresh'); assert(cookie?.httpOnly && cookie.path === '/api/auth' && !cookie.secure);
  report.auth = true; report.secureContext = await page.evaluate(() => isSecureContext); report.cookie = { httpOnly: cookie.httpOnly, path: cookie.path, sameSite: cookie.sameSite };
  // Browser CORS preflight is forced by a cross-origin JSON POST to the loopback API from localhost.
  localVite = await createServer({ root: resolve('apps/web'), configFile: resolve('apps/web/vite.config.ts'), server: { host: '127.0.0.1', port: 5176, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:4001' } } } });
  await localVite.listen();
  const localPage = await context.newPage(); await localPage.goto('http://localhost:5176/login');
  const options = [];
  localPage.on('response', response => { if (response.request().method() === 'OPTIONS') options.push(response.status()); });
  const cors = await localPage.evaluate(async () => {
    const res = await fetch('http://127.0.0.1:4001/auth/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'absent@example.com', password: 'Invalid-password-2026!' }) }); return res.status;
  });
  assert.equal(cors, 401); assert(preflightLog.includes('PREFLIGHT http://localhost:5176')); report.preflight = true; report.browserPreflightObserved = true;
  const denied = await fetch('http://127.0.0.1:4001/auth/login', { method: 'OPTIONS', headers: { Origin: 'https://foreign.invalid', 'Access-Control-Request-Method': 'POST' } }); assert.equal(denied.status, 403);
  // Stop only the API process created by this script; keep the actual frontend running.
  const exited = new Promise(resolve => api.once('exit', resolve)); api.kill('SIGTERM'); await exited;
  const guest = await browser.newContext(); const login = await guest.newPage(); await login.goto(`${origin}/login`);
  await login.getByLabel('Email', { exact: true }).fill(email); await login.getByLabel('Mot de passe', { exact: true }).fill(password); await login.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await login.getByRole('alert').filter({ hasText: 'Connexion impossible.' }).waitFor(); report.apiDown = true;
  await login.screenshot({ path: '/tmp/finance-validation/lan-api-down.png' });
  assert.deepEqual(report.pageerrors, []); report.passed = true;
} catch (error) { report.failure = String(error.stack); report.apiErrors = apiErrors; process.exitCode = 1; }
finally { await browser?.close(); await vite?.close(); await localVite?.close(); if (api.exitCode === null) api.kill('SIGTERM'); await writeFile('/tmp/finance-validation/lan-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
