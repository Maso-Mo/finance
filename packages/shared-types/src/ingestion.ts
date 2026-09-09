import { z } from 'zod';
import { dateOnlySchema } from './transaction.js';

/**
 * Contrats partagés de l'INGESTION LOCALE de relevés (V1 — fondation).
 *
 * Philosophie « 100 % local, textuel, déterministe — jamais de LLM » :
 *  - la source est le TEXTE extrait localement d'un PDF (ou collé) ;
 *  - la grammaire reconnue est STRICTE (finance-core) : les lignes ambiguës
 *    sont rejetées avec une raison, jamais devinées ;
 *  - l'IMPORT est piloté par les indices de lignes du texte d'origine :
 *    le client ne peut PAS soumettre un montant/type arbitraire — le serveur
 *    RE-PARSE le texte et n'importe que les lignes réellement reconnues ;
 *  - toute ligne importée reste « compte inconnu » / « catégorie inconnue » :
 *    elle n'impacte AUCUN solde tant qu'un humain ne l'a pas allouée.
 */

/** Fournisseur / origine probable d'un relevé (indice d'affichage). */
export const statementProviderHintSchema = z.enum([
  'BANK',
  'MVOLA',
  'ORANGE_MONEY',
  'AIRTEL_MONEY',
]);
export type StatementProviderHint = z.infer<typeof statementProviderHintSchema>;

export const STATEMENT_PROVIDER_HINTS: readonly StatementProviderHint[] = [
  'BANK',
  'MVOLA',
  'ORANGE_MONEY',
  'AIRTEL_MONEY',
];

// --- Aperçu (preview) : parse pure, aucune écriture ---
export const statementPreviewRequestSchema = z.object({
  provider: statementProviderHintSchema.optional(),
  text: z
    .string()
    .min(1, 'Provide the extracted statement text.')
    .max(200_000, 'Statement text is too large (200 KB max).'),
});
export type StatementPreviewRequest = z.infer<
  typeof statementPreviewRequestSchema
>;

export const statementRowKindSchema = z.enum(['INCOME', 'EXPENSE']);
export type StatementRowKind = z.infer<typeof statementRowKindSchema>;

export const statementRowCandidateSchema = z.object({
  /** Numéro de ligne (1-based) dans le texte source. */
  line: z.number().int().positive(),
  kind: statementRowKindSchema,
  amount: z.string(),
  date: dateOnlySchema.nullable(),
  description: z.string().nullable(),
  raw: z.string(),
  /** true si une Transaction identique existe déjà (déduplication visible AVANT import). */
  alreadyImported: z.boolean(),
});
export type StatementRowCandidate = z.infer<typeof statementRowCandidateSchema>;

export const statementIgnoredLineSchema = z.object({
  line: z.number().int().positive(),
  raw: z.string(),
  reason: z.string(),
});
export type StatementIgnoredLine = z.infer<typeof statementIgnoredLineSchema>;

export const statementPreviewResponseSchema = z.object({
  provider: statementProviderHintSchema,
  rows: z.array(statementRowCandidateSchema),
  ignored: z.array(statementIgnoredLineSchema),
  headers: z.array(z.number().int().positive()),
});
export type StatementPreviewResponse = z.infer<
  typeof statementPreviewResponseSchema
>;

// --- Import : le serveur re-parse le texte et n'importe que `rowIndices` ---
export const statementImportRequestSchema = z.object({
  provider: statementProviderHintSchema.optional(),
  text: z
    .string()
    .min(1, 'Provide the extracted statement text.')
    .max(200_000, 'Statement text is too large (200 KB max).'),
  /** Indices 1-based des lignes reconnues à importer (dédupliqués côté service). */
  rowIndices: z
    .array(z.number().int().positive())
    .min(1, 'Select at least one row to import.')
    .max(500, 'At most 500 rows per import.'),
});
export type StatementImportRequest = z.infer<typeof statementImportRequestSchema>;

/** Texte extrait localement d'un PDF (réponse de /extract). */
export const statementExtractResponseSchema = z.object({
  text: z.string(),
});
export type StatementExtractResponse = z.infer<
  typeof statementExtractResponseSchema
>;

export const statementImportResultSchema = z.object({
  /** Ligne importée, avec sa ligne d'origine et sa Transaction créée. */
  imported: z.array(
    z.object({
      line: z.number().int().positive(),
      id: z.string().uuid(),
      kind: statementRowKindSchema,
      amount: z.string(),
      date: dateOnlySchema.nullable(),
      description: z.string().nullable(),
    }),
  ),
  /** Nombre de lignes déjà présentes (déduplication idempotente). */
  skippedDuplicates: z.number().int().nonnegative(),
});
export type StatementImportResult = z.infer<typeof statementImportResultSchema>;
