/**
 * Fuseaux horaires IANA — finance-core.
 *
 * Helpers PURS autour de `Intl.DateTimeFormat` (API standard du moteur, aucun
 * répertoire manuel de timezones). Ils servent au moteur de notifications
 * (étape 12) pour connaître le JOUR LOCAL d'un utilisateur et son heure de
 * cadence quotidienne, sans jamais déduire définitivement le fuseau du
 * serveur.
 *
 * Toutes les fonctions sont pures : un même `instant` + `timeZone` renvoie
 * toujours le même résultat. Aucune I/O, aucun Prisma/Express/React.
 */

/** Composantes date/heure zonées (champ par champ, sans ambiguïté). */
export interface ZonedTime {
  year: number;
  /** 1..12 */
  month: number;
  day: number;
  /** 0..23 */
  hour: number;
  /** 0..59 */
  minute: number;
  /** 0..59 */
  second: number;
}

function readZoned(instant: Date | number | string, timeZone: string): ZonedTime {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(
    typeof instant === 'number' ? new Date(instant) : new Date(instant),
  );
  const read = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    const value = Number(part?.value);
    if (!Number.isInteger(value)) {
      throw new RangeError(`Intl did not expose a numeric "${type}" part.`);
    }
    return value;
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * Une timezone IANA est-elle exploitable par Intl ?
 * `Intl.DateTimeFormat` lève RangeError sur une valeur invalide/inconnue.
 */
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Composantes zonées d'un instant (pour les tests et la cadence). */
export function zonedTimeOf(
  instant: Date | number | string,
  timeZone: string,
): ZonedTime {
  if (!isValidTimeZone(timeZone)) {
    throw new RangeError(`Invalid IANA time zone: "${timeZone}".`);
  }
  return readZoned(instant, timeZone);
}

/** Jour LOCAL (« YYYY-MM-DD », format calendaire partagé) d'un instant. */
export function zonedDateISO(
  instant: Date | number | string,
  timeZone: string,
): string {
  const t = zonedTimeOf(instant, timeZone);
  return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
}

/** Heure locale « HH:MM » (cadence quotidienne) d'un instant. */
export function zonedTimeHHMM(
  instant: Date | number | string,
  timeZone: string,
): string {
  const t = zonedTimeOf(instant, timeZone);
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

/** Valide une heure « HH:MM » (chaîne de cadence). */
export function isValidHHMM(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** « HH:MM » → minutes depuis minuit (comparaison numérique fiable). */
export function hhmmToMinutes(value: string): number {
  if (!isValidHHMM(value)) {
    throw new RangeError(`Invalid "HH:MM" time: "${value}".`);
  }
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3, 5));
  return hour * 60 + minute;
}

/**
 * La cadence quotidienne d'un utilisateur est-elle atteinte ?
 * `nowHHMM` et `scheduledHHMM` sont des « HH:MM » (heure locale du même
 * fuseau) : la passe journalière est atteinte quand now >= scheduled.
 */
export function isDailyWindowReached(nowHHMM: string, scheduledHHMM: string): boolean {
  return hhmmToMinutes(nowHHMM) >= hhmmToMinutes(scheduledHHMM);
}
