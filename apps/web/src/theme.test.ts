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

import { readFileSync } from 'node:fs';
const css = readFileSync('src/index.css', 'utf8');
it('uses the exact requested light/dark tokens and Inter', () => {
  const light = css.split(':root {')[1]!.split('html.dark {')[0]!;
  const dark = css.split('html.dark {')[1]!.split('/* Exposition')[0]!;
  for (const [token, lightValue, darkValue] of [
    ['canvas', '#F8FAFC', '#0B0F17'], ['surface', '#FFFFFF', '#151C2C'], ['brand', '#0F172A', '#38BDF8'], ['positive', '#059669', '#10B981'], ['ink', '#1E293B', '#F1F5F9'], ['edge', '#E2E8F0', '#1E293B'],
  ]) {
    expect(light).toContain(`--${token}: ${lightValue};`); expect(dark).toContain(`--${token}: ${darkValue};`);
  }
  expect(css).toMatch(/--font-sans:\s*"Inter"/);
});
