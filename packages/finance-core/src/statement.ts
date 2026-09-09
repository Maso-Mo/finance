/**
 * Extraction de relevés bancaires / mobile money — finance-core.
 *
 * V1 « ingestion locale de relevés » : la source d'entrée est le TEXTE extrait
 * du PDF (l'extraction PDF elle-même vit côté API, hors finance-core). Ce
 * module parse le texte ligne à ligne de façon PURE, LOCALE et SANS LLM, avec
 * des garde-fous STRICTS :
 *
 *  - aucune ligne ambiguë n'est devinée : elle est rejetée avec une raison ;
 *  - un relevé n'est JAMAIS une écriture : les lignes reconnues restent des
 *    CANDIDATS qu'un humain relit/confirme avant import ;
 *  - le sens (INCOME/EXPENSE) doit être EXPLICITE (colonne débit/crédit ou
 *    montant signé) — jamais déduit d'un solde ;
 *  - les montants sont restitués en chaîne décimale exacte (jamais flottant) ;
 *  - `rowKey` offre une clé canonique de déduplication par utilisateur.
 *
 * Grammaires V1 (voir docs/mobile-ingestion.md pour les exemples) :
 *  - « SIGNED »        : date ; description ; montant signé (− = dépense) ;
 *  - « CREDIT_DEBIT »  : date ; description ; débit ; crédit (exactement un
 *    des deux rempli).
 * Tout autre format est rejeté proprement (ligne ignorée + raison).
 */

export type StatementProviderHint =
  | 'BANK'
  | 'MVOLA'
  | 'ORANGE_MONEY'
  | 'AIRTEL_MONEY';

export type StatementRowKind = 'INCOME' | 'EXPENSE';

/** Ligne de relevé RECONNUE (candidat d'import, jamais une écriture). */
export interface ParsedStatementRow {
  /** 1-based dans le texte source (audit et relecture humaine). */
  line: number;
  raw: string;
  kind: StatementRowKind;
  /** Chaîne décimale exacte (« 4500.00 »), strictement positive. */
  amount: string;
  /** Jour calendaire « YYYY-MM-DD » si lisible, sinon null. */
  date: string | null;
  /** Description nettoyée, ou null. */
  description: string | null;
  /** Colonne qui a porté le sens (audit). */
  sourceColumn: 'debit' | 'credit' | 'amount';
}

/** Ligne ignorée (ambiguë ou hors grammaire), avec une raison explicite. */
export interface IgnoredStatementLine {
  line: number;
  raw: string;
  reason: string;
}

export interface StatementParseResult {
  provider: StatementProviderHint;
  rows: ParsedStatementRow[];
  ignored: IgnoredStatementLine[];
  /** Lignes identifiées comme en-têtes de colonnes (ignorées). */
  headers: number[];
}

/** Normalise un montant « 1234.56 / 1 234,56 / 4500 » → décimal exact. */
export function normalizeMoneyText(value: string): string | null {
  let clean = value.trim().replace(/\s/g, '');
  if (clean.startsWith('+')) clean = clean.slice(1);
  const sign = clean.startsWith('-');
  if (sign) clean = clean.slice(1);
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(clean)) return null;
  const [intRaw, fracRaw] = clean.includes(',')
    ? clean.split(',')
    : clean.includes('.')
      ? clean.split('.')
      : [clean, undefined];
  const int = intRaw.replace(/\D/g, '');
  const frac = fracRaw?.padEnd(2, '0') ?? '00';
  if (int.length === 0) return null;
  const normalized = `${int}.${frac}`;
  if (Number(normalized) <= 0) return null;
  return sign ? `-${normalized}` : normalized;
}

/** Date « YYYY-MM-DD » ou « DD/MM/YYYY » dans une cellule → « YYYY-MM-DD ». */
export function normalizeDateText(value: string): string | null {
  const iso = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return iso[0];
  const dmy = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const day = dmy[1];
    const month = dmy[2];
    const year = dmy[3];
    if (!day || !month || !year) return null;
    const dd = day.padStart(2, '0');
    const mm = month.padStart(2, '0');
    if (Number(month) > 12 || Number(day) > 31) return null;
    return `${year}-${mm}-${dd}`;
  }
  return null;
}

/** Cellules d'une ligne (tabulation > point-virgule > pipe > virgule). */
export function splitStatementLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (trimmed.includes('\t')) {
    return trimmed.split('\t').map((cell) => cell.trim());
  }
  const separator = trimmed.includes(';')
    ? ';'
    : trimmed.includes('|')
      ? '|'
      : ',';
  return trimmed.split(separator).map((cell) => cell.trim());
}

const HEADER_TOKENS = new Set([
  'date',
  'date operation',
  'date valeur',
  'libelle',
  'libellé',
  'description',
  'montant',
  'debit',
  'débit',
  'credit',
  'crédit',
  'solde',
  'type',
  'details',
  'détails',
  'reference',
  'référence',
]);

function looksLikeHeader(cells: string[]): boolean {
  const tokens = cells.filter((cell) => HEADER_TOKENS.has(cell.toLowerCase()));
  return (
    tokens.length >= 2 ||
    cells.some((cell) =>
      /^(date|d[ée]bit|cr[ée]dit|montant|libell[ée])$/i.test(cell),
    )
  );
}

function numericOrEmpty(cell: string): boolean {
  if (cell === '') return true;
  return normalizeMoneyText(cell) !== null;
}

/**
 * Parse le texte extrait d'un relevé (pure, déterministe).
 *
 * Chaque ligne est traitée indépendamment. Une ligne non reconnue n'arrête
 * jamais le traitement : elle est ajoutée à `ignored` avec sa raison.
 */
export function parseStatementText(
  text: string,
  options: { provider?: StatementProviderHint } = {},
): StatementParseResult {
  const provider = options.provider ?? 'BANK';
  const rows: ParsedStatementRow[] = [];
  const ignored: IgnoredStatementLine[] = [];
  const headers: number[] = [];

  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (!trimmed) return;
    const cells = splitStatementLine(trimmed);
    if (cells.length < 2) {
      ignored.push({
        line: lineNumber,
        raw: trimmed,
        reason: 'ligne sans colonne exploitable.',
      });
      return;
    }
    if (looksLikeHeader(cells)) {
      headers.push(lineNumber);
      return;
    }

    // --- Grammaire CREDIT_DEBIT : [date?, description, débit, crédit] ---
    if (cells.length >= 4) {
      const last = cells.slice(-2);
      if (numericOrEmpty(last[0] ?? '') && numericOrEmpty(last[1] ?? '')) {
        const debit = normalizeMoneyText(last[0] ?? '');
        const credit = normalizeMoneyText(last[1] ?? '');
        if (debit && credit) {
          ignored.push({
            line: lineNumber,
            raw: trimmed,
            reason: 'les colonnes débit et crédit sont toutes les deux remplies.',
          });
          return;
        }
        const kind: StatementRowKind | null = debit
          ? 'EXPENSE'
          : credit
            ? 'INCOME'
            : null;
        if (!kind) {
          ignored.push({
            line: lineNumber,
            raw: trimmed,
            reason: 'aucun montant débit/crédit lisible.',
          });
          return;
        }
        const before = cells.slice(0, -2);
        const date = normalizeDateText(before[0] ?? '');
        const description =
          before
            .slice(date ? 1 : 0)
            .filter((cell) => cell !== '')
            .join(' · ') || null;
        rows.push({
          line: lineNumber,
          raw: trimmed,
          kind,
          amount: (debit ?? credit ?? '').replace(/^-/, ''),
          date,
          description: description && description.length > 0 ? description : null,
          sourceColumn: debit ? 'debit' : 'credit',
        });
        return;
      }
    }

    // --- Grammaire SIGNED : [date?, description…, montant signé] ---
    const lastCell = cells[cells.length - 1] ?? '';
    const normalizedAmount = normalizeMoneyText(lastCell);
    if (normalizedAmount && (lastCell.includes('-') || lastCell.startsWith('+'))) {
      const kind: StatementRowKind = normalizedAmount.startsWith('-')
        ? 'EXPENSE'
        : 'INCOME';
      const before = cells.slice(0, -1);
      const date = normalizeDateText(before[0] ?? '');
      const description =
        before
          .slice(date ? 1 : 0)
          .filter((cell) => cell !== '')
          .join(' · ') || null;
      rows.push({
        line: lineNumber,
        raw: trimmed,
        kind,
        amount: normalizedAmount.replace(/^-/, ''),
        date,
        description,
        sourceColumn: 'amount',
      });
      return;
    }

    ignored.push({
      line: lineNumber,
      raw: trimmed,
      reason: 'aucun montant explicite (signé ou colonne débit/crédit) reconnu.',
    });
  });

  return { provider, rows, ignored, headers };
}

/** Clé canonique de déduplication d'une ligne reconnue (par utilisateur). */
export function statementRowKey(row: {
  kind: StatementRowKind;
  amount: string;
  date: string | null;
  description: string | null;
}): string {
  const description = (row.description ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  return `${row.kind}|${row.amount}|${row.date ?? ''}|${description}`;
}
