import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, THEME_STORAGE_KEY } from '../theme';
import { ThemeToggle } from './ThemeToggle';

type SetSystemDark = (d: boolean) => void;

/**
 * Harness : fournit un ThemeProvider (qui lit localStorage + matchMedia).
 * Le setup (test/setup.ts) fournit window.__setSystemDark(dark) et un
 * matchMedia simulé ; afterEach nettoie le DOM et localStorage.
 */
function renderToggle(systemDark = false, stored: string | null = null) {
  window.localStorage.clear();
  if (stored !== null) {
    window.localStorage.setItem(THEME_STORAGE_KEY, stored);
  }
  (window as unknown as { __setSystemDark: SetSystemDark }).__setSystemDark(
    systemDark,
  );
  return render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

function getSwitch() {
  return screen.getByRole('switch');
}

beforeEach(() => {
  document.documentElement.classList.remove('dark');
  window.localStorage.clear();
});

describe('ThemeToggle — résolution initiale (premier lancement)', () => {
  it('aucune préférence mémorisée + système sombre → thème sombre', () => {
    renderToggle(true, null);
    expect(getSwitch().getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('aucune préférence mémorisée + système clair → thème clair', () => {
    renderToggle(false, null);
    expect(getSwitch().getAttribute('aria-checked')).toBe('false');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('choix light mémorisé + système sombre → light (priorité au choix)', () => {
    renderToggle(true, 'light');
    expect(getSwitch().getAttribute('aria-checked')).toBe('false');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('choix dark mémorisé + système clair → dark (priorité au choix)', () => {
    renderToggle(false, 'dark');
    expect(getSwitch().getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

describe('ThemeToggle — interactions', () => {
  it('aucune option « Système » visible dans l’interface', () => {
    renderToggle(false, null);
    expect(screen.queryByText(/système/i)).toBeNull();
    const toggle = screen.getByTestId('theme-toggle');
    expect(within(toggle).queryByText(/système/i)).toBeNull();
    // Seuls Clair / Sombre sont des libellés possibles.
    expect(within(toggle).getByText(/clair|sombre/i)).toBeTruthy();
  });

  it('clic sur le switch → bascule le thème', async () => {
    const user = userEvent.setup();
    renderToggle(false, null); // démarre clair
    expect(getSwitch().getAttribute('aria-checked')).toBe('false');

    await user.click(getSwitch());

    expect(getSwitch().getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('préférence mémorisée après un clic', async () => {
    const user = userEvent.setup();
    renderToggle(false, null);
    await user.click(getSwitch());
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('le clic simple ne change le thème qu’une seule fois', async () => {
    const user = userEvent.setup();
    renderToggle(false, null);
    await user.click(getSwitch());
    // Après un seul clic, on est passé exactement une fois (sinon ce serait light).
    expect(getSwitch().getAttribute('aria-checked')).toBe('true');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('drag du bouton vers l’autre côté → bascule le thème', () => {
    renderToggle(false, null); // clair
    expect(getSwitch().getAttribute('aria-checked')).toBe('false');

    fireEvent.pointerDown(getSwitch(), {
      pointerId: 1,
      clientX: 0,
      button: 0,
      pointerType: 'mouse',
    });
    fireEvent.pointerMove(getSwitch(), {
      pointerId: 1,
      clientX: 60,
      button: 0,
      pointerType: 'mouse',
    });
    fireEvent.pointerUp(getSwitch(), {
      pointerId: 1,
      clientX: 60,
      button: 0,
      pointerType: 'mouse',
    });

    expect(getSwitch().getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('préférence mémorisée après un drag', () => {
    renderToggle(false, null);
    fireEvent.pointerDown(getSwitch(), { pointerId: 1, clientX: 0, button: 0 });
    fireEvent.pointerMove(getSwitch(), { pointerId: 1, clientX: 60, button: 0 });
    fireEvent.pointerUp(getSwitch(), { pointerId: 1, clientX: 60, button: 0 });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('interaction clavier (espace) → bascule le thème', async () => {
    const user = userEvent.setup();
    renderToggle(false, null);
    getSwitch().focus();
    await user.keyboard(' ');
    expect(getSwitch().getAttribute('aria-checked')).toBe('true');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('le thème résolu reste stable quand le système change après un choix manuel', () => {
    // Choix explicite dark, système clair.
    renderToggle(false, 'dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    // L'OS passe en sombre : le choix explicite (dark) reste dark.
    (window as unknown as { __setSystemDark: SetSystemDark }).__setSystemDark(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    // L'OS repasse en clair : toujours dark.
    (window as unknown as { __setSystemDark: SetSystemDark }).__setSystemDark(false);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

