import { describe, expect, it } from 'vitest';
import {
  hhmmToMinutes,
  isDailyWindowReached,
  isValidHHMM,
  isValidTimeZone,
  zonedDateISO,
  zonedTimeHHMM,
  zonedTimeOf,
} from '../src/index.js';

/**
 * FUSEAUX HORAIRES (étape 12) — finance-core.
 *
 * Le moteur de notifications doit connaître le JOUR LOCAL d'un utilisateur
 * pour produire « une notification par jour local » sans jamais déduire
 * définitivement le fuseau du serveur. Les helpers sont PURS (Intl standard,
 * pas de table manuelle de timezones).
 *
 * Point de repère partagé : 2026-09-20T21:30:00.000Z est :
 *  - UTC                   → 2026-09-20 21:30 ;
 *  - Indian/Antananarivo   → 2026-09-21 00:30 (UTC+3, jour LOCAL DÉJÀ le 21) ;
 *  - America/Toronto       → 2026-09-20 17:30 (UTC−4).
 */

const INSTANT = '2026-09-20T21:30:00.000Z';

describe('isValidTimeZone', () => {
  it('accepte une timezone IANA réelle', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Indian/Antananarivo')).toBe(true);
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('America/Toronto')).toBe(true);
  });

  it('refuse une valeur inconnue / vide / non-chaîne', () => {
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('   ')).toBe(false);
    expect(isValidTimeZone('UTC+3')).toBe(false);
  });
});

describe('zonedDateISO — jour local par utilisateur', () => {
  it('UTC : l’instant reste le 20', () => {
    expect(zonedDateISO(INSTANT, 'UTC')).toBe('2026-09-20');
  });

  it('Indian/Antananarivo (UTC+3) : le jour local est déjà le 21', () => {
    expect(zonedDateISO(INSTANT, 'Indian/Antananarivo')).toBe('2026-09-21');
  });

  it('America/Toronto (UTC−4) : toujours le 20 local', () => {
    expect(zonedDateISO(INSTANT, 'America/Toronto')).toBe('2026-09-20');
  });

  it('accepte aussi un nombre (epoch ms) ou un Date', () => {
    const epoch = Date.parse(INSTANT);
    expect(zonedDateISO(epoch, 'UTC')).toBe('2026-09-20');
    expect(zonedDateISO(new Date(INSTANT), 'Indian/Antananarivo')).toBe(
      '2026-09-21',
    );
  });

  it('lève RangeError pour une timezone invalide', () => {
    expect(() => zonedDateISO(INSTANT, 'Pas/Une_Zone')).toThrow(RangeError);
  });
});

describe('zonedTimeHHMM / zonedTimeOf', () => {
  it('composantes zonées précises (Toronto 17:30)', () => {
    const t = zonedTimeOf(INSTANT, 'America/Toronto');
    expect(t).toEqual({ year: 2026, month: 9, day: 20, hour: 17, minute: 30, second: 0 });
  });

  it('Antananarivo : minuit passé → 00:30 locale', () => {
    expect(zonedTimeHHMM(INSTANT, 'Indian/Antananarivo')).toBe('00:30');
  });
});

describe('cadence quotidienne HH:MM', () => {
  it('valide ou refuse un format HH:MM', () => {
    expect(isValidHHMM('09:00')).toBe(true);
    expect(isValidHHMM('23:59')).toBe(true);
    expect(isValidHHMM('24:00')).toBe(false);
    expect(isValidHHMM('9:00')).toBe(false);
    expect(isValidHHMM('09:60')).toBe(false);
  });

  it('hhmmToMinutes', () => {
    expect(hhmmToMinutes('00:30')).toBe(30);
    expect(hhmmToMinutes('09:00')).toBe(540);
    expect(hhmmToMinutes('23:59')).toBe(1439);
    expect(() => hhmmToMinutes('9h')).toThrow(RangeError);
  });

  it('isDailyWindowReached — la fenêtre quotidienne est atteinte à partir de l’heure planifiée', () => {
    expect(isDailyWindowReached('09:00', '09:00')).toBe(true);
    expect(isDailyWindowReached('10:12', '09:00')).toBe(true);
    expect(isDailyWindowReached('08:59', '09:00')).toBe(false);
    expect(isDailyWindowReached('00:30', '09:00')).toBe(false);
    // Minuit passé à Antananarivo (00:30) < 09:00 : pas encore la passe.
    expect(isDailyWindowReached('00:30', '09:00')).toBe(false);
  });
});
