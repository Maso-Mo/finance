/**
 * Conversions de dates calendaires à la frontière API.
 *
 * Une échéance financière est un JOUR (YYYY-MM-DD), jamais un instant UTC.
 * Le stockage PostgreSQL utilise des colonnes DATE. On écrit toujours un
 * `Date` à MINUIT UTC (le jour ne bouge donc jamais avec le fuseau de la
 * session), et on relit via toISOString().slice(0, 10).
 */

/** « YYYY-MM-DD » → Date UTC à minuit pour une colonne DATE. */
export function dateInputToDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Date (colonne DATE lue par Prisma) → « YYYY-MM-DD ». */
export function dbDateToISO(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Jour local du processus au format « YYYY-MM-DD » (valeur par défaut). */
export function todayLocalISO(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
