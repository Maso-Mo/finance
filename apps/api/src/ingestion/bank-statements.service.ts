import { prisma } from '../db.js';
import { ApiError } from '../http-error.js';
import {
  parseStatementText,
} from '@finance/finance-core';
import { createTransactionRecord } from '../transactions/transactions.service.js';
import type {
  StatementImportRequest,
  StatementImportResult,
  StatementPreviewRequest,
  StatementPreviewResponse,
  TransactionUpsert,
} from '@finance/shared-types';

/**
 * Ingestion LOCALE de relevés bancaires / mobile money (V1 — fondation).
 *
 * Règles absolues :
 *  - PREVIEW est STRICTEMENT read-only : aucune écriture Prisma possible ;
 *  - IMPORT re-parse le TEXTE D'ORIGINE avec la grammaire pure de
 *    finance-core : le client ne soumet que les INDICES des lignes vues en
 *    aperçu (jamais un montant/type arbitraire) ;
 *  - déduplication IDEMPOTENTE : une ligne déjà importée à l'identique
 *    (type + montant + date + description) est ignorée — relancer l'import
 *    du même fichier ne crée AUCUN doublon ;
 *  - chaque ligne importée reste « compte inconnu » / « catégorie inconnue »
 *    (accountUnknown / categoryUnknown) : elle n'impacte AUCUN solde tant
 *    qu'un humain ne l'a pas ventilée dans le journal ;
 *  - aucun LLM, aucun service externe : extraction + parsing 100 % locaux.
 */

const IMPORT_DESCRIPTION_PREFIX = '[Relevé] ';

/** Description d'import (bornée, préfixée pour retrouver la source). */
function importDescription(description: string | null): string {
  const base = (description ?? 'Sans libellé').replace(/\s+/g, ' ').trim();
  const full = `${IMPORT_DESCRIPTION_PREFIX}${base}`;
  return full.length <= 120 ? full : `${full.slice(0, 116)}…`;
}

/** Clé de déduplication identique à l'import (type + montant + jour + description). */
function statementKey(
  type: string,
  amount: string,
  date: string,
  description: string,
): string {
  return `${type}|${Number(amount).toFixed(2)}|${date}|${description}`;
}

/**
 * Aperçu STRICTEMENT read-only : parse le texte et signale les lignes déjà
 * importées (déduplication visible AVANT l'import). Aucune écriture : seule
 * une LECTURE des Transactions « [Relevé] » de l'utilisateur est faite.
 */
export async function previewStatement(
  userId: string,
  input: StatementPreviewRequest,
): Promise<StatementPreviewResponse> {
  const parsed = parseStatementText(input.text, {
    provider: input.provider ?? 'BANK',
  });

  let existingKeys: Set<string> | null = null;
  const datedRows = parsed.rows.filter((row) => row.date !== null);
  if (datedRows.length > 0) {
    const matchers = datedRows.map((row) => ({
      userId,
      type: row.kind,
      amount: row.amount,
      occurredAt: new Date(`${row.date}T12:00:00.000Z`),
      description: importDescription(row.description),
      deletedAt: null,
    }));
    const found = await prisma.transaction.findMany({
      where: { OR: matchers },
      select: {
        type: true,
        amount: true,
        occurredAt: true,
        description: true,
      },
    });
    existingKeys = new Set(
      found.map((row) =>
        statementKey(
          row.type,
          row.amount.toFixed(2),
          (row.occurredAt?.toISOString() ?? '').slice(0, 10),
          row.description ?? '',
        ),
      ),
    );
  }

  return {
    provider: parsed.provider,
    rows: parsed.rows.map((row) => ({
      line: row.line,
      kind: row.kind,
      amount: row.amount,
      date: row.date,
      description: row.description,
      raw: row.raw,
      alreadyImported:
        row.date !== null &&
        existingKeys !== null &&
        existingKeys.has(
          statementKey(row.kind, row.amount, row.date, importDescription(row.description)),
        ),
    })),
    ignored: parsed.ignored,
    headers: parsed.headers,
  };
}

/**
 * Importe les lignes reconnues (`rowIndices`, 1-based, référentiel = texte).
 *
 * Pour chaque ligne sélectionnée, dans l'ordre du fichier :
 *  - si une transaction identique existe déjà chez l'utilisateur
 *    (type + montant + date + description), elle est IGNORÉE (idempotence) ;
 *  - sinon une vraie Transaction EXPENSE/INCOME « compte inconnu » est créée
 *    via le service du journal existant (étape 5) — jamais un second système.
 */
export async function importStatement(
  userId: string,
  input: StatementImportRequest,
): Promise<StatementImportResult> {
  const parsed = parseStatementText(input.text, {
    provider: input.provider ?? 'BANK',
  });
  const byLine = new Map(parsed.rows.map((row) => [row.line, row]));
  const requested = [...new Set(input.rowIndices)];
  const selected = requested.map((line) => {
    const row = byLine.get(line);
    if (!row) {
      throw new ApiError(
        400,
        `Line ${line} was not recognized in the statement (re-run the preview).`,
      );
    }
    return row;
  });
  if (selected.length === 0) {
    throw new ApiError(400, 'Select at least one recognized row to import.');
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currency: true },
  });
  if (!user) {
    throw new ApiError(401, 'User not found.');
  }

  let skippedDuplicates = 0;
  const imported: StatementImportResult['imported'] = [];

  await prisma.$transaction(async (tx) => {
    for (const row of selected) {
      const description = importDescription(row.description);
      const occurredAtDate = row.date
        ? new Date(`${row.date}T12:00:00.000Z`)
        : null;

      // Déduplication idempotente : même type + montant + jour + description
      // (dont préfixe [Relevé]) déjà présent chez l'utilisateur.
      const existing = await tx.transaction.findFirst({
        where: {
          userId,
          type: row.kind,
          amount: row.amount,
          occurredAt: occurredAtDate,
          description,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (existing) {
        skippedDuplicates += 1;
        continue;
      }

      const upsert: TransactionUpsert = {
        type: row.kind,
        amount: row.amount,
        description,
        accountUnknown: true,
        // EXPENSE sans catégorie choisie : « je ne sais plus » explicite.
        ...(row.kind === 'EXPENSE' ? { categoryUnknown: true } : {}),
        ...(occurredAtDate
          ? { occurredAt: row.date ?? undefined }
          : { dateUnknown: true }),
      };

      const transaction = await createTransactionRecord(tx, userId, upsert);
      imported.push({
        line: row.line,
        id: transaction.id,
        kind: row.kind,
        amount: transaction.amount,
        date: transaction.occurredAt,
        description: transaction.description,
      });
    }
  });

  return { imported, skippedDuplicates };
}
