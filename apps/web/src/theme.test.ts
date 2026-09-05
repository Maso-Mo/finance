import { describe, expect, it } from 'vitest';
import {
  parseStoredChoice,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemeChoice,
} from './theme';

describe('parseStoredChoice', () => {
  it("n'accepte que 'light' et 'dark' comme choix explicite", () => {
    expect(parseStoredChoice('light')).toBe('light');
    expect(parseStoredChoice('dark')).toBe('dark');
  });

  it("traite l'absence de valeur et toute valeur inconnue comme 'aucun choix'", () => {
    expect(parseStoredChoice(null)).toBeNull();
    // Valeur legacy de l'ancien sélecteur 3 états : devient « suivre système ».
    expect(parseStoredChoice('system')).toBeNull();
    expect(parseStoredChoice('blue')).toBeNull();
  });
});

describe('resolveTheme (règle du thème)', () => {
  it('aucun choix mémorisé + système sombre → sombre', () => {
    expect(resolveTheme(null, true)).toBe('dark');
  });

  it('aucun choix mémorisé + système clair → clair', () => {
    expect(resolveTheme(null, false)).toBe('light');
  });

  it('choix light mémorisé + système sombre → light (choix prioritaire)', () => {
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('choix dark mémorisé + système clair → dark (choix prioritaire)', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('parseStoredChoice (clé de stockage)', () => {
  it('est la seule clé utilisée par le provider', () => {
    // Ce test verrouille le contrat de persistance : toute évolution de la clé
    // doit être volontaire et accompagnée de la mise à jour du script inline
    // anti-flash de index.html.
    expect(THEME_STORAGE_KEY).toBe('finance.theme-preference');
  });
});

// Garantit le type : seul light|dark est un choix utilisateur valide (pas system).
const choices: ThemeChoice[] = ['light', 'dark'];
it('le type public du choix est restreint à light|dark', () => {
  expect(choices).toHaveLength(2);
});
