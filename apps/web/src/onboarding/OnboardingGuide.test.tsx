import { describe, expect, it, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { OnboardingProvider, useOnboarding, OnboardingTour, ONBOARDING_TOTAL } from './index';
import { apiGetOnboarding, apiCompleteOnboarding } from '../auth/api';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: { id: 'user-1', username: 'test' },
  }),
}));

vi.mock('../auth/api', () => ({
  apiGetOnboarding: vi.fn(),
  apiCompleteOnboarding: vi.fn(),
}));

const mockedGetOnboarding = vi.mocked(apiGetOnboarding);
const mockedCompleteOnboarding = vi.mocked(apiCompleteOnboarding);

/** Bouton qui relance le guide manuellement (comme l'entrée « Plus »). */
function RelaunchButton() {
  const { start } = useOnboarding();
  return (
    <button type="button" onClick={start}>
      Relancer le guide
    </button>
  );
}

function renderGuide(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <OnboardingProvider>
        <RelaunchButton />
        <OnboardingTour />
      </OnboardingProvider>
    </MemoryRouter>,
  );
}

describe('Prise en main guidée — OnboardingProvider + Tour', () => {
  beforeEach(() => {
    mockedGetOnboarding.mockReset();
    mockedCompleteOnboarding.mockReset();
    mockedCompleteOnboarding.mockResolvedValue({ completed: true });
  });

  it('démarre automatiquement à l’accueil pour une première utilisation', async () => {
    mockedGetOnboarding.mockResolvedValue({ completed: false });
    renderGuide('/');

    const dialog = await screen.findByRole('dialog', { name: /Total disponible/ });
    expect(within(dialog).getByText('Étape 1 / 13')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Précédent' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /Suivant/ })).toBeInTheDocument();
  });

  it('parcourt les 13 étapes et termine via « J’ai compris » + confirmation', async () => {
    mockedGetOnboarding.mockResolvedValue({ completed: false });
    const user = userEvent.setup();
    renderGuide('/');

    await screen.findByRole('dialog', { name: /Total disponible/ });

    // 12 « Suivant » pour atteindre l'étape de récapitulation (13e).
    for (let i = 0; i < ONBOARDING_TOTAL - 1; i += 1) {
      await user.click(screen.getByRole('button', { name: /Suivant/ }));
    }

    const recap = screen.getByRole('dialog', { name: /Comptabilité/ });
    expect(within(recap).getByText('Étape 13 / 13')).toBeInTheDocument();
    expect(
      within(recap).getByText('Tu connais maintenant l’essentiel de Finance.'),
    ).toBeInTheDocument();

    // Rien n'est persisté avant confirmation.
    await user.click(within(recap).getByRole('button', { name: "J'ai compris, terminer le guide" }));
    const confirm = await screen.findByRole('dialog', { name: /Terminer le guide/ });
    expect(mockedCompleteOnboarding).not.toHaveBeenCalled();

    await user.click(within(confirm).getByRole('button', { name: 'Terminer' }));

    await waitFor(() => {
      expect(mockedCompleteOnboarding).toHaveBeenCalledTimes(1);
      expect(screen.queryAllByRole('dialog')).toHaveLength(0);
    });
  });

  it('fermer le guide ne persiste rien', async () => {
    mockedGetOnboarding.mockResolvedValue({ completed: false });
    const user = userEvent.setup();
    renderGuide('/');

    const dialog = await screen.findByRole('dialog', { name: /Total disponible/ });
    await user.click(
      within(dialog).getByRole('button', { name: 'Quitter le guide sans rien enregistrer' }),
    );

    await waitFor(() => {
      expect(screen.queryAllByRole('dialog')).toHaveLength(0);
    });
    expect(mockedCompleteOnboarding).not.toHaveBeenCalled();
  });

  it('ne s’ouvre pas automatiquement après complétion, mais reste relançable', async () => {
    mockedGetOnboarding.mockResolvedValue({ completed: true });
    const user = userEvent.setup();
    renderGuide('/');

    // Laisser le temps à un éventuel (faux) démarrage automatique.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryAllByRole('dialog')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Relancer le guide' }));
    const dialog = await screen.findByRole('dialog', { name: /Total disponible/ });
    expect(within(dialog).getByText('Étape 1 / 13')).toBeInTheDocument();
    expect(mockedCompleteOnboarding).not.toHaveBeenCalled();
  });
});

it('exposes a description, traps Tab and restores focus on Escape', async () => {
  mockedGetOnboarding.mockResolvedValue({ completed: true });
  const user = userEvent.setup(); renderGuide();
  const launch = screen.getByRole('button', { name: 'Relancer le guide' });
  await user.click(launch);
  const dialog = await screen.findByRole('dialog', { name: 'Total disponible' });
  expect(dialog).toHaveAccessibleDescription(/Banque/);
  expect(dialog.parentElement?.parentElement).toBe(document.body);
  const next = within(dialog).getByRole('button', { name: /Suivant/ });
  next.focus(); await user.tab();
  expect(dialog.contains(document.activeElement)).toBe(true);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(launch).toHaveFocus();
});
