import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { deflateSync } from 'node:zlib';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { extractPdfText } from '../src/ingestion/pdf.js';
import { seedSystemCategories } from '../src/categories/seed.js';

/**
 * INGESTION LOCALE DE RELEVÉS (fondation V1) — API.
 *
 * Règles verrouillées :
 *  - PREVIEW est STRICTEMENT read-only (aucune écriture) ;
 *  - IMPORT re-parse le texte d'origine : le client ne choisit que des INDICES
 *    de lignes reconnues (jamais un montant/type arbitraire) ;
 *  - IMPORT idempotent : rejouer le même fichier ne crée AUCUN doublon ;
 *  - l'extraction PDF est locale (FlateDecode + Tj/TJ), sans LLM ni service ;
 *  - les lignes importées sont « compte inconnu » / « catégorie inconnue ».
 */

const PASSWORD = 'correct-horse-battery-staple';

const STATEMENT_TEXT = [
  'date;description;debit;credit',
  '01/09/2026;Retrait distributeur;20000.00;',
  '01/09/2026;Virement salaire;;1500000.00',
  '02/09/2026;Ligne sans argent;;',
].join('\n');

let tokenA = '';
let tokenB = '';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const postPreview = (token: string, body: Record<string, unknown>) =>
  request(app).post('/ingestion/bank-statements/preview').set(auth(token)).send(body);
const postImport = (token: string, body: Record<string, unknown>) =>
  request(app).post('/ingestion/bank-statements/import').set(auth(token)).send(body);

async function register(email: string): Promise<string> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: PASSWORD });
  expect(res.status).toBe(201);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  await seedSystemCategories();
  tokenA = await register(`ingest-${Date.now()}a@test.dev`);
  tokenB = await register(`ingest-${Date.now()}b@test.dev`);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Ingestion relevés — PREVIEW', () => {
  it('1. preview pure : lignes reconnues + en-tête + rejets, AUCUNE écriture', async () => {
    const res = await postPreview(tokenA, { text: STATEMENT_TEXT });
    expect(res.status).toBe(200);
    expect(res.body.headers).toEqual([1]);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0]).toMatchObject({
      line: 2,
      kind: 'EXPENSE',
      amount: '20000.00',
      date: '2026-09-01',
    });
    expect(res.body.rows[1]).toMatchObject({ line: 3, kind: 'INCOME' });
    expect(res.body.ignored[0]?.reason).toContain('aucun montant');

    // Strictement read-only : aucune transaction créée.
    const ledger = await request(app)
      .get('/transactions?page=1&limit=5')
      .set(auth(tokenB));
    expect(ledger.status).toBe(200);
    expect(ledger.body.transactions).toHaveLength(0);
  });

  it('2. texte non reconnu → zéro ligne, jamais devinée', async () => {
    const res = await postPreview(tokenA, { text: 'Facture photocopie simple.' });
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(0);
    expect(res.body.ignored.length).toBeGreaterThan(0);
  });
});

describe('Ingestion relevés — IMPORT idempotent', () => {
  it('3. importe les lignes choisies puis ignore les doublons', async () => {
    const first = await postImport(tokenA, {
      text: STATEMENT_TEXT,
      rowIndices: [2, 3],
    });
    expect(first.status).toBe(201);
    expect(first.body.imported).toHaveLength(2);
    expect(first.body.skippedDuplicates).toBe(0);
    expect(first.body.imported[0]).toMatchObject({ line: 2, kind: 'EXPENSE' });
    expect(first.body.imported[1]).toMatchObject({ line: 3, kind: 'INCOME' });

    // Deuxième import du même fichier : aucun doublon, tout est ignoré.
    const second = await postImport(tokenA, {
      text: STATEMENT_TEXT,
      rowIndices: [2, 3],
    });
    expect(second.status).toBe(201);
    expect(second.body.imported).toHaveLength(0);
    expect(second.body.skippedDuplicates).toBe(2);

    // Ligne non reconnue dans le texte → refus explicite (jamais inventée).
    const bad = await postImport(tokenA, {
      text: STATEMENT_TEXT,
      rowIndices: [99],
    });
    expect(bad.status).toBe(400);
  });

  it('4. l’import d’un utilisateur n’affecte jamais un autre utilisateur', async () => {
    const res = await postImport(tokenB, {
      text: STATEMENT_TEXT,
      rowIndices: [2],
    });
    expect(res.status).toBe(201);
    expect(res.body.imported).toHaveLength(1);
    expect(res.body.skippedDuplicates).toBe(0);
  });
});

describe('Extraction PDF locale', () => {
  it('5. un PDF simple FlateDecode → texte → lignes reconnues', () => {
    const content = [
      'BT /F1 10 Tf 40 700 Td',
      '(2026-09-01;Marche Alakamisy;-4500.00) Tj',
      'T* (2026-09-02;Vente zebu;+1500000) Tj',
      'ET',
    ].join('\n');
    const stream = deflateSync(Buffer.from(content, 'latin1'));
    const pdf = Buffer.concat([
      Buffer.from(
        `%PDF-1.4\n1 0 obj << /Length ${stream.length} /Filter /FlateDecode >> stream\n`,
        'latin1',
      ),
      stream,
      Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
    ]);
    const text = extractPdfText(pdf);
    expect(text).toContain('2026-09-01;Marche Alakamisy;-4500.00');
    expect(text).toContain('2026-09-02;Vente zebu;+1500000');
  });

  it('6. fichier non-PDF → refus explicite', () => {
    expect(() => extractPdfText(Buffer.from('ceci est du texte', 'latin1'))).toThrow(
      'not a PDF',
    );
  });
});

describe('Ingestion relevés — déduplication visible AVANT import', () => {
  it('7. nouveau fichier = anciennes lignes + nouvelle : preview les signale', async () => {
    const mixed = [
      'date;description;debit;credit',
      '01/09/2026;Retrait distributeur;20000.00;', // déjà importée par tokenA (test 3)
      '02/09/2026;Nouvelle depense;5000.00;', // nouvelle
      '01/09/2026;Virement salaire;;1500000.00', // déjà importée par tokenA (test 3)
    ].join('\n');

    const preview = await postPreview(tokenA, { text: mixed });
    expect(preview.status).toBe(200);
    expect(preview.body.rows).toHaveLength(3);
    expect(preview.body.rows[0]).toMatchObject({
      line: 2,
      alreadyImported: true,
    });
    expect(preview.body.rows[1]).toMatchObject({
      line: 3,
      alreadyImported: false,
    });
    expect(preview.body.rows[2]).toMatchObject({
      line: 4,
      alreadyImported: true,
    });

    // Import de la SEULE nouvelle ligne : pas de doublon, 2 ignorées.
    const imported = await postImport(tokenA, { text: mixed, rowIndices: [3] });
    expect(imported.status).toBe(201);
    expect(imported.body.imported).toHaveLength(1);
    expect(imported.body.skippedDuplicates).toBe(0);
  });

  it('8. extract PDF (HTTP) → texte → preview → import complet', async () => {
    const content = [
      '(date;description;debit;credit) Tj',
      'T* (04/09/2026;Marche Alakamisy;4500.00;) Tj',
      'T* (05/09/2026;Vente zebu;;850000.00) Tj',
    ].join('\n');
    const stream = deflateSync(Buffer.from(content, 'latin1'));
    const pdf = Buffer.concat([
      Buffer.from(
        `%PDF-1.4\n1 0 obj << /Length ${stream.length} /Filter /FlateDecode >> stream\n`,
        'latin1',
      ),
      stream,
      Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
    ]);

    const extract = await request(app)
      .post('/ingestion/bank-statements/extract')
      .set(auth(tokenB))
      .set('content-type', 'application/pdf')
      .send(pdf);
    expect(extract.status).toBe(200);
    expect(extract.body.text).toContain('Marche Alakamisy');
    expect(extract.body.text).toContain('Vente zebu');

    const preview = await postPreview(tokenB, { text: extract.body.text });
    expect(preview.status).toBe(200);
    expect(preview.body.rows).toHaveLength(2);
    expect(preview.body.rows[0]).toMatchObject({ line: 2, kind: 'EXPENSE' });
    expect(preview.body.rows[1]).toMatchObject({ line: 3, kind: 'INCOME' });

    const imported = await postImport(tokenB, {
      text: extract.body.text,
      rowIndices: [2, 3],
    });
    expect(imported.status).toBe(201);
    expect(imported.body.imported).toHaveLength(2);
    expect(imported.body.skippedDuplicates).toBe(0);
  });

  it('9. corps non-PDF sur /extract → refus explicite (jamais deviné)', async () => {
    const res = await request(app)
      .post('/ingestion/bank-statements/extract')
      .set(auth(tokenB))
      .set('content-type', 'application/pdf')
      .send(Buffer.from('ceci est du texte brut', 'latin1'));
    expect(res.status).toBe(400);
  });
});

