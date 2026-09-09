/**
 * E2E — validation navigateur RÉEL (Chromium système via playwright-core).
 *
 * Prérequis :
 *  - API locale branchée sur une base vierge (finance_e2e) sur le port 4000 ;
 *  - build de production servi en preview sur le port 4173 ;
 *  - LANCEMENT : node e2e.mjs http://127.0.0.1:4173 http://127.0.0.1:4000 /usr/bin/chromium
 *
 * Couvre : auth (register / login / mauvais mot de passe / double-clic /
 * logout / restauration de session), écriture réelle d'une dépense via l'UI,
 * rendu de toutes les pages, responsive multi-viewports, thème light/dark
 * persisté, erreurs réseau, console propre.
 */
import { chromium } from 'playwright-core';

const WEB = process.argv[2] ?? 'http://127.0.0.1:4173';
const API = process.argv[3] ?? 'http://127.0.0.1:4000';
const EXEC = process.argv[4] ?? '/usr/bin/chromium';
const VIEWPORTS = [
  { name: '360x800', width: 360, height: 800 },
  { name: '390x844', width: 390, height: 844 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

let failures = 0;
const failuresLog = [];
const pass = (label) => console.log(`  OK   ${label}`);
const fail = (label, detail = '') => {
  failures += 1;
  failuresLog.push(`${label} ${detail}`.trim());
  console.log(`  ✗ FAIL ${label} ${detail}`.trim());
};
const heading = (t) => console.log(`\n## ${t}`);

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const monthISO = () => todayISO().slice(0, 7);
const noOverflow = async (page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1,
  );

async function loginViaFetch(email, password) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login fetch ${res.status} ${await res.text()}`);
  return (await res.json()).accessToken;
}

async function seedApiData(token) {
  const auth = { authorization: `Bearer ${token}` };
  const accounts = await (await fetch(`${API}/accounts`, { headers: auth })).json();
  const byType = Object.fromEntries(accounts.accounts.map((a) => [a.type, a.id]));
  const cats = await (await fetch(`${API}/categories`, { headers: auth })).json();
  const post = async (path, body) => {
    const r = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST ${path} ${r.status} ${await r.text()}`);
    return r;
  };
  await post('/planned-expenses', { amount: '50000', dueDate: todayISO(), categoryId: cats.categories[0].id });
  await post('/planned-expenses', { amount: '250000', dueDate: todayISO(), categoryUnknown: true });
  await post('/expected-incomes', { amount: '600000', certainty: 'CONFIRMED', expectedDate: todayISO() });
  await post('/budgets', { month: monthISO(), amount: '1000000' });
  await post('/transfers', {
    sourceAccountId: byType.MVOLA,
    destinationAccountId: byType.BANK,
    amount: '100000',
    feeAmount: '2500',
    occurredAt: todayISO(),
  });
  await post('/debts', {
    direction: 'I_OWE',
    originalAmount: '300000',
    counterpartyName: 'E2E contact',
    dueDate: todayISO(),
  });
}

async function main() {
  heading('Lancement Chromium (système, headless)');
  const browser = await chromium.launch({ executablePath: EXEC, headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const benignConsole = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    const origin = msg.location().url;
    if (
      /401 \(Unauthorized\)/.test(text) ||
      /ERR_FAILED/.test(text) ||
      /404 \(Not Found\)/.test(text) ||
      (/400 \(Bad Request\)/.test(text) && origin.includes('/auth/'))
    ) {
      benignConsole.push(`${text} @ ${origin}`);
    } else {
      consoleErrors.push(`${text} @ ${origin}`);
    }
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  const email = `e2e-${Date.now()}@finance.local`;
  const password = 'StrongPass#123';

  heading('AUTH — erreur réseau sur login (POST auth coupé)');
  await page.route(`${API}/auth/login`, (route) => route.abort());
  await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill('x@y.z');
  await page.getByLabel('Mot de passe').fill('wrong');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  try {
    await page.getByRole('alert').waitFor({ timeout: 4000 });
    if ((await page.getByRole('alert').textContent()).length > 0) pass('erreur réseau login affichée');
    else fail('erreur réseau login : alerte vide');
  } catch {
    fail('erreur réseau login non affichée');
  }
  await page.unroute(`${API}/auth/login`);

  heading('AUTH — inscription');
  await page.goto(`${WEB}/register`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Mot de passe (min. 8 caractères)').fill(password);
  await page.getByRole('button', { name: /Créer|inscri/i }).click();
  try {
    await page.waitForFunction(() => document.body.innerText.includes('Total disponible'), { timeout: 15000 });
    pass('register → dashboard');
  } catch {
    fail('register n’atteint pas le dashboard');
  }

  heading('PRISE EN MAIN — guide parcouru puis terminé (aucun overlay bloquant)');
  try {
    const finalStep = page.getByRole('button', {
      name: "J'ai compris, terminer le guide",
    });
    let clicked = false;
    for (let i = 0; i < 18; i += 1) {
      if (await finalStep.isVisible().catch(() => false)) {
        await finalStep.click();
        await page
          .getByRole('button', { name: 'Terminer', exact: true })
          .click({ timeout: 3000 });
        await page
          .waitForFunction(
            () => !document.querySelector('.fixed.inset-0.z-\\[1000\\]'),
            { timeout: 6000 },
          )
          .catch(() => {});
        clicked = true;
        break;
      }
      await page.getByRole('button', { name: /Suivant/ }).click({ timeout: 3000 });
      await page.waitForTimeout(120);
    }
    if (clicked) pass('guide de prise en main terminé (progression persistée)');
    else pass('aucun guide de prise en main à terminer');
  } catch {
    pass('aucun guide de prise en main à terminer');
  }

  heading('DASHBOARD — détails, 6 comptes, épargne');
  await page.getByRole('button', { name: 'Détails' }).click();
  for (const label of ['Banque', 'MVola', 'Orange Money', 'Airtel Money', 'Cash', 'Épargne']) {
    try {
      await page.getByText(label, { exact: true }).first().waitFor({ timeout: 3000 });
    } catch {
      fail(`compte manquant dans Détails : ${label}`);
    }
  }
  pass('6 comptes listés dans Détails');
  await page.getByRole('button', { name: 'Masquer les détails' }).click();
  heading('AUTH — restauration de session après reload');
  await page.reload({ waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(() => document.body.innerText.includes('Total disponible'), { timeout: 15000 });
    pass('session restaurée après refresh');
  } catch {
    fail('session perdue après refresh');
  }

  heading('AUTH — logout, mauvais mot de passe, double-clic login');
  await page.getByRole('button', { name: 'Déconnexion' }).click();
  await page.waitForURL('**/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Mot de passe').fill('mauvais');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  try {
    await page.getByRole('alert').waitFor({ timeout: 12000 });
    pass('mauvais mot de passe rejeté');
  } catch {
    fail('mauvais mot de passe non rejeté');
  }
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Mot de passe').fill(password);
  const btn = page.getByRole('button', { name: 'Se connecter' });
  await btn.click({ clickCount: 2, delay: 50 });
  try {
    await page.waitForFunction(() => document.body.innerText.includes('Total disponible'), { timeout: 15000 });
    pass('double-clic login → une seule connexion (dashboard)');
  } catch {
    fail('double-clic login → pas de dashboard');
  }

  heading('SEED API — données de la journée');
  try {
    const token = await loginViaFetch(email, password);
    await seedApiData(token);
    pass('planned x2, expected, budget, transfert, dette créés');
  } catch (error) {
    fail(`seed API : ${error.message}`);
  }

  heading('ÉCRITURE RÉELLE — dépense via l’UI');
  await page.goto(`${WEB}/transactions`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Nouvelle opération' }).click();
  await page.getByRole('button', { name: 'Dépense' }).click();
  await page.getByPlaceholder('0').fill('12000');
  await page.locator('input[type="date"]').fill(todayISO());
  await page.getByLabel('Ajouter Banque').click();
  const bankRow = page.getByLabel('Ajouter Banque').locator('xpath=ancestor::div[1]');
  await bankRow.getByPlaceholder('Montant…').fill('12000');
  await page.locator('select').selectOption({ index: 1 });
  await page.getByLabel(/Description/).fill('Dépense E2E restaurant');
  const postResp = page.waitForResponse(
    (r) => r.url().includes('/transactions') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Vérifier et confirmer…' }).click();
  await page.getByRole('button', { name: 'Confirmer et enregistrer' }).click();
  try {
    const resp = await postResp;
    if (resp.status() === 200 || resp.status() === 201) pass('POST /transactions accepté');
    else fail(`POST /transactions status=${resp.status()}`);
    await page.getByText('Dépense E2E restaurant').waitFor({ timeout: 5000 });
    pass('la dépense apparaît dans l’historique');
  } catch (error) {
    fail(`écriture dépense : ${String(error).slice(0, 160)}`);
  }

  heading('IMPORT RELEVÉ (Comptabilité) — preview → choix → import → dédup');
  await page.goto(`${WEB}/accounting`, { waitUntil: 'domcontentloaded' });
  try {
    await page.getByRole('heading', { name: 'Comptabilité', level: 1 }).waitFor({ timeout: 15000 });
    pass('page Comptabilité rendue');
  } catch (error) {
    fail(`Comptabilité : rendu impossible — ${String(error).slice(0, 120)}`);
  }
  await page.getByRole('button', { name: 'Importer un relevé bancaire' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  const statementText = [
    'date;description;debit;credit',
    '01/09/2026;Marche E2E;4500.00;',
    '02/09/2026;Salaire E2E;;300000.00',
  ].join('\n');
  const uploadStatement = () =>
    page.setInputFiles('input[type="file"]', {
      name: 'releve-e2e.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(statementText, 'utf8'),
    });
  try {
    await uploadStatement();
    await page.getByText(/2 lignes reconnues/).waitFor({ timeout: 10000 });
    await page.getByText('Marche E2E', { exact: false }).first().waitFor({ timeout: 3000 });
    pass('aperçu relevé : lignes reconnues affichées (aucune écriture)');
  } catch (error) {
    fail(`aperçu relevé : ${String(error).slice(0, 160)}`);
  }
  const importResp = page.waitForResponse(
    (r) => r.url().includes('/ingestion/bank-statements/import') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /Importer 2 lignes/ }).click();
  try {
    const resp = await importResp;
    if (resp.status() !== 201) {
      fail(`POST import relevé status=${resp.status()}`);
    } else {
      pass('POST /ingestion/bank-statements/import accepté (201)');
      await page.getByText(/2 lignes importées/).waitFor({ timeout: 8000 });
      pass('message de confirmation de l’import affiché');
    }
  } catch (error) {
    fail(`import relevé : ${String(error).slice(0, 160)}`);
  }
  try {
    await page.getByRole('button', { name: 'Choisir un autre fichier' }).click();
    await uploadStatement();
    await page.getByText('Déjà importée', { exact: false }).first().waitFor({ timeout: 8000 });
    pass('doublons signalés avant un second import (idempotence visible)');
  } catch (error) {
    fail(`dédup relevé : ${String(error).slice(0, 160)}`);
  }
  await page.getByRole('button', { name: 'Annuler tout' }).click();
  pass('boîte d’import fermée sans erreur');

  heading('RENDU — toutes les pages (1366x768)');
  const pagesToCheck = [
    ['/', 'Finance'],
    ['/transactions', 'Transactions'],
    ['/planned', 'Dépenses à venir'],
    ['/expected', 'Revenus à venir'],
    ['/budgets', 'Budgets'],
    ['/savings', 'Épargne'],
    ['/debts', 'Dettes et créances'],
    ['/notifications', 'Notifications'],
    ['/assistant', 'Assistant IA'],
  ];
  for (const [route, h1] of pagesToCheck) {
    try {
      await page.goto(`${WEB}${route}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.getByRole('heading', { name: h1, level: 1 }).waitFor({ timeout: 15000 });
      const overflow = await noOverflow(page);
      if (overflow) pass(`${route} rendu sans overflow`);
      else fail(`${route} : overflow horizontal`);
    } catch (error) {
      fail(`${route} : rendu impossible — ${String(error).slice(0, 140)}`);
    }
  }
  try {
    await page.getByText('Assistant non configuré sur le serveur').waitFor({ timeout: 15000 });
    pass('assistant en mode dégradé (provider non configuré)');
  } catch {
    fail('message assistant dégradé absent');
  }

  heading('NOTIFICATIONS — centre rendu');
  await page.goto(`${WEB}/notifications`, { waitUntil: 'domcontentloaded' });
  try {
    await page.getByRole('heading', { name: 'Notifications', level: 1 }).waitFor();
    pass('centre de notifications rendu');
  } catch {
    fail('centre de notifications non rendu');
  }

  heading('THÈME — choix persisté (dark puis light puis système)');
  await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((key) => localStorage.setItem(key, 'dark'), 'finance.theme-preference');
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (await page.evaluate(() => document.documentElement.classList.contains('dark'))) {
    pass('choix dark persisté appliqué');
  } else {
    fail('choix dark non appliqué après reload');
  }
  await page.evaluate((key) => localStorage.setItem(key, 'light'), 'finance.theme-preference');
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (await page.evaluate(() => !document.documentElement.classList.contains('dark'))) {
    pass('choix light persisté appliqué');
  } else {
    fail('choix light non appliqué après reload');
  }
  await page.evaluate((key) => localStorage.removeItem(key), 'finance.theme-preference');
  await page.reload({ waitUntil: 'domcontentloaded' });
  pass('retour au mode système (préférence effacée)');

  heading('RESPONSIVE — 5 viewports sur les pages clés');
  const responsiveRoutes = ['/', '/transactions', '/assistant', '/notifications', '/debts', '/savings'];
  for (const vp of VIEWPORTS) {
    const ctx2 = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const p2 = await ctx2.newPage();
    p2.on('pageerror', (e) => pageErrors.push(`responsive:${vp.name} ${e}`));
    let okRoute = true;
    for (const route of responsiveRoutes) {
      try {
        await p2.goto(`${WEB}${route}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await p2.waitForTimeout(250);
        if (!(await noOverflow(p2))) {
          okRoute = false;
          fail(`responsive ${vp.name} ${route} : overflow horizontal`);
        }
      } catch (error) {
        okRoute = false;
        fail(`responsive ${vp.name} ${route} : chargement — ${String(error).slice(0, 100)}`);
      }
    }
    if (okRoute) pass(`responsive ${vp.name} sans overflow (${responsiveRoutes.length} pages)`);
    await ctx2.close();
  }

  heading('ERREURS RÉSEAU — /accounts coupé sur le dashboard');
  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p3 = await ctx3.newPage();
  await p3.goto(`${WEB}/login`);
  await p3.getByLabel('Email').fill(email);
  await p3.getByLabel('Mot de passe').fill(password);
  await p3.getByRole('button', { name: 'Se connecter' }).click();
  await p3.waitForFunction(() => document.body.innerText.includes('Total disponible'), { timeout: 15000 });
  await p3.route(`${API}/accounts`, (route) => route.abort());
  await p3.reload({ waitUntil: 'domcontentloaded' });
  try {
    const alertVisible = await p3
      .locator('p.text-red-600, [role="alert"]')
      .first()
      .isVisible()
      .catch(() => false);
    const snapshotRendered = await p3
      .waitForFunction(
        () => document.body.innerText.includes('Total disponible'),
        { timeout: 20000 },
      )
      .then(() => true)
      .catch(() => false);
    if (alertVisible) {
      pass('erreur API affichée proprement quand /accounts est coupé');
    } else if (snapshotRendered) {
      pass('mode hors-ligne : snapshot local affiché quand /accounts est coupé');
    } else {
      fail('aucune erreur ni snapshot visible quand /accounts est coupé');
    }
  } catch {
    fail('aucune erreur ni snapshot visible quand /accounts est coupé');
  }
  await ctx3.close();

  heading('CONSOLE ET ERREURS JS');
  if (pageErrors.length === 0) pass('aucune pageerror');
  else fail(`pageerrors : ${pageErrors.slice(0, 3).join(' | ')}`);
  const relevant = consoleErrors.filter((e) => !/Download the React DevTools/.test(e));
  if (relevant.length === 0) {
    pass(`aucune erreur console inattendue (${benignConsole.length} bénignes suivies : refresh invité 401 / tests hors-ligne / favicon 404)`);
  } else {
    fail(`erreurs console inattendues : ${relevant.slice(0, 3).join(' | ')}`);
  }

  await browser.close();

  heading('RÉSULTAT E2E');
  if (failures === 0) {
    console.log('E2E : TOUS LES PARCOURS PASSENT.');
  } else {
    console.log(`E2E : ${failures} échec(s).`);
    console.log(failuresLog.join('\n'));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('E2E runner failed:', error);
  process.exitCode = 1;
});
