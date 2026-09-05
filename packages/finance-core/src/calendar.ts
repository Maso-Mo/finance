/**
 * Dates calendaires et planification mensuelle — finance-core.
 *
 * Une échéance financière est un JOUR (YYYY-MM-DD), jamais un instant UTC.
 * Tous les helpers ci-dessous sont PURS : ils manipulent des chaînes
 * « YYYY-MM-DD » / « YYYY-MM » et des entiers, sans Date locale hasardeuse.
 * La comparaison lexicale de chaînes ISO (« A < B ») est exacte.
 *
 * Règle V1 des mois incomplets : un jour demandé absent d'un mois est
 * remplacé par LE DERNIER JOUR de ce mois (31 → 30 en avril, 28/29 en
 * février, etc.).
 */

export interface CalendarDate {
  year: number;
  month: number; // 1..12
  day: number;
}

export function isValidISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const { year, month, day } = parseISODate(value);
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

export function parseISODate(value: string): CalendarDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new RangeError(`Invalid calendar date "${value}". Expected YYYY-MM-DD.`);
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

/** Nombre de jours d'un mois (1..12). Fonction pure, jamais de fuseau. */
export function daysInMonth(year: number, month: number): number {
  // Le 0 de Date.UTC renvoie le dernier jour du mois précédent.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Clampe un jour du mois sur le dernier jour existant (28/29/30/31). */
export function clampDayOfMonth(year: number, month: number, day: number): number {
  return Math.max(1, Math.min(day, daysInMonth(year, month)));
}

export interface YearMonth {
  year: number;
  month: number; // 1..12
}

export function addMonths(yearMonth: YearMonth, offset: number): YearMonth {
  const total = yearMonth.year * 12 + (yearMonth.month - 1) + offset;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

export function monthToKey(yearMonth: YearMonth): string {
  return `${yearMonth.year}-${String(yearMonth.month).padStart(2, '0')}`;
}

export function keyToMonth(key: string): YearMonth {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) {
    throw new RangeError(`Invalid year-month "${key}". Expected YYYY-MM.`);
  }
  return { year: Number(match[1]), month: Number(match[2]) };
}

/**
 * Échéance mensuelle « YYYY-MM-DD » pour un mois donné : jour demandé
 * clampe au dernier jour du mois. `dayOfMonth` attendu entre 1 et 31.
 */
export function monthlyDueDate(
  yearMonth: YearMonth,
  dayOfMonth: number,
): string {
  const day = clampDayOfMonth(yearMonth.year, yearMonth.month, dayOfMonth);
  return `${yearMonth.year}-${String(yearMonth.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Ajoute `days` jours à une date calendaire (purement arithmétique UTC).
 */
export function addDaysISO(date: string, days: number): string {
  const { year, month, day } = parseISODate(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/**
 * « Aujourd'hui » du fuseau LOCAL du processus, au format YYYY-MM-DD.
 * Utilisé uniquement comme valeur de référence de maintenance (scheduler) ;
 * pour les rappels, le frontend transmet son propre jour local.
 */
export function localDateString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Série des échéances mensuelles d'une règle récurrente, du premier mois
 * pertinent jusqu'au mois de référence + 3 (mois courant + 3 suivants).
 *
 * - Un mois candidat est ignoré si son échéance précède `startDate` (la
 *   première échéance utile démarre donc au mois suivant) ;
 * - `endDate` (si fournie) borne la série ;
 * - un mois sans échéance possible (jour 31 en avril) est clampé.
 *
 * Idempotent et déterministe : le même appel renvoie toujours le même
 * ensemble (l'horizon ne dépend que de `referenceDate`).
 */
export function generateMonthlyOccurrences(options: {
  startDate: string;
  endDate?: string | null;
  dayOfMonth: number;
  /** Date de référence « aujourd'hui » pour calculer l'horizon (mois + 3). */
  referenceDate: string;
}): string[] {
  const { startDate, endDate, dayOfMonth, referenceDate } = options;
  if (!isValidISODate(startDate) || !isValidISODate(referenceDate)) {
    throw new RangeError('Invalid calendar date in generateMonthlyOccurrences.');
  }
  if (endDate != null && !isValidISODate(endDate)) {
    throw new RangeError('Invalid endDate in generateMonthlyOccurrences.');
  }
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
    throw new RangeError('dayOfMonth must be an integer between 1 and 31.');
  }

  const startMonth = keyToMonth(startDate.slice(0, 7));
  const referenceMonth = keyToMonth(referenceDate.slice(0, 7));
  const horizonEnd = addMonths(referenceMonth, 3);

  const occurrences: string[] = [];
  let cursor: YearMonth = startMonth;
  // Sécurité anti-boucle infinie (au plus la durée calendaire parcourue).
  let guard = 0;
  while (guard < 1200) {
    guard += 1;
    const due = monthlyDueDate(cursor, dayOfMonth);
    if (due >= startDate) {
      if (endDate == null || due <= endDate) {
        occurrences.push(due);
      }
    }
    if (cursor.year === horizonEnd.year && cursor.month === horizonEnd.month) {
      break;
    }
    cursor = addMonths(cursor, 1);
  }
  return occurrences;
}

/** Catégorie temporelle d'une échéance PENDING, dérivée de dueDate + today. */
export type DueBucket = 'overdue' | 'due' | 'upcoming' | 'later';

/**
 * Classe une échéance par rapport au jour local (YYYY-MM-DD) transmis :
 * - overdue : échéance < today ;
 * - due     : échéance == today ;
 * - upcoming: today < échéance <= today + upcomingWindowDays (7 par défaut) ;
 * - later   : au-delà de la fenêtre « bientôt due ».
 */
export function dueBucket(
  dueDate: string,
  today: string,
  upcomingWindowDays = 7,
): DueBucket {
  if (dueDate < today) {
    return 'overdue';
  }
  if (dueDate === today) {
    return 'due';
  }
  if (dueDate <= addDaysISO(today, upcomingWindowDays)) {
    return 'upcoming';
  }
  return 'later';
}

/**
 * Catégorie temporelle d'une échéance PENDING, dérivée de dueDate + today.
 * Une dépense non PENDING (PAID / CANCELED / SKIPPED) n'est jamais un rappel
 * actif : la fonction renvoie alors null.
 */
export function classifyPlannedReminder(
  dueDate: string,
  today: string,
  status: string,
  upcomingWindowDays = 7,
): DueBucket | null {
  if (status !== 'PENDING') {
    return null;
  }
  return dueBucket(dueDate, today, upcomingWindowDays);
}

/** Tri chronologique croissant de dates ISO (le plus ancien d'abord). */
export function compareISO(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}


