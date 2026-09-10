import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../theme';
import { AuthProvider } from '../auth/AuthContext';
import AssistantPage from './AssistantPage';
import type { AssistantProposalPublic, AssistantStatus } from '@finance/shared-types';
import {
  apiCancelAssistantProposal,
  apiConfirmAssistantProposal,
  apiGetAssistantStatus,
  apiGetNotifications,
  apiRefresh,
  apiSendAssistantMessage,
} from '../auth/api';

vi.mock('../auth/api', () => ({
  apiRefresh: vi.fn(),
  apiLogin: vi.fn(),
  apiLogout: vi.fn(),
  apiRegister: vi.fn(),
  setAccessToken: vi.fn(),
  apiGetNotifications: vi.fn(),
  apiGetAssistantStatus: vi.fn(),
  apiSendAssistantMessage: vi.fn(),
  apiConfirmAssistantProposal: vi.fn(),
  apiCancelAssistantProposal: vi.fn(),
}));

const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'a@example.com' };
const STATUS: AssistantStatus = {
  available: true,
  provider: 'openai',
  maxToolCalls: 6,
  timeoutMs: 45_000,
  draftTtlMinutes: 60,
  proposalTtlMinutes: 1440,
};

const PROPOSAL: AssistantProposalPublic = {
  id: '00000000-0000-4000-8000-0000000000a1',
  actionType: 'TRANSACTION_CREATE',
  summary: {
    title: 'Dépense à enregistrer',
    lines: [
      { label: 'Montant', value: '10 000 Ar' },
      { label: 'Compte', value: 'Cash' },
    ],
    confirmLabel: 'Confirmer la dépense',
    doneMessage: 'Dépense enregistrée.',
  },
  status: 'PENDING',
  expiresAt: '2026-09-10T10:00:00.000Z',
  createdAt: '2026-09-06T10:00:00.000Z',
  confirmedAt: null,
  executedAt: null,
  canceledAt: null,
  failureReason: null,
  resultingResourceType: null,
  resultingResourceId: null,
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/assistant']}>
        <ThemeProvider>
          <AuthProvider>
            <AssistantPage />
          </AuthProvider>
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function waitPage() {
  await screen.findByRole('heading', { name: 'Assistant IA' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiRefresh).mockResolvedValue(USER);
  vi.mocked(apiGetNotifications).mockResolvedValue({
    notifications: [],
    total: 0,
    page: 1,
    limit: 1,
    unreadCount: 0,
  });
  vi.mocked(apiGetAssistantStatus).mockResolvedValue(STATUS);
});

describe('AssistantPage — statut et mode dégradé', () => {
  it('affiche le formulaire de conversation quand l’assistant est disponible', async () => {
    renderPage();
    await waitPage();
    expect(await screen.findByLabelText('Votre message')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Envoyer' })).toBeTruthy();
    expect(screen.getAllByText(/lecture seule/).length).toBeGreaterThan(0);
  });

  it('affiche la mention de confidentialité (service IA en ligne, jamais SMS/relevés bruts)', async () => {
    renderPage();
    await waitPage();
    expect(
      await screen.findByText(
        /Seules les informations nécessaires à ta demande lui sont transmises/,
      ),
    ).toBeTruthy();
    expect(
      screen.getAllByText(
        /Les SMS et relevés bancaires bruts ne sont jamais envoyés/,
      ).length,
    ).toBeGreaterThan(0);
  });

  it('mode dégradé : pas de saisie quand le serveur n’a pas de fournisseur IA', async () => {
    vi.mocked(apiGetAssistantStatus).mockResolvedValue({
      ...STATUS,
      available: false,
      provider: null,
    });
    renderPage();
    await waitPage();
    expect(
      await screen.findByText('Assistant non configuré sur le serveur.'),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Votre message')).toBeNull();
  });
});

describe('AssistantPage — envoi d’un message', () => {
  it('réponse ANSWER : le message de l’assistant s’affiche', async () => {
    const user = userEvent.setup();
    vi.mocked(apiSendAssistantMessage).mockResolvedValue({
      kind: 'ANSWER',
      text: 'Votre total disponible est de 600 000 Ar.',
    });
    renderPage();
    await waitPage();
    await user.type(
      await screen.findByLabelText('Votre message'),
      'Quel est mon total disponible ?',
    );
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));

    expect(
      await screen.findByText('Votre total disponible est de 600 000 Ar.'),
    ).toBeTruthy();
    const firstCall = vi.mocked(apiSendAssistantMessage).mock.calls[0]!;
    expect(firstCall[0].message).toBe('Quel est mon total disponible ?');
    expect(firstCall[0].localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof firstCall[0].timezone).toBe('string');
  });

  it('ASK_CLARIFICATION : le brouillon est joint au message suivant', async () => {
    const user = userEvent.setup();
    const draftId = '00000000-0000-4000-8000-0000000000b2';
    vi.mocked(apiSendAssistantMessage)
      .mockResolvedValueOnce({
        kind: 'ASK_CLARIFICATION',
        text: 'Sur quel compte dois-je enregistrer cette dépense ?',
        draftId,
      })
      .mockResolvedValueOnce({
        kind: 'ANSWER',
        text: 'Dépense enregistrée sur Cash.',
      });
    renderPage();
    await waitPage();

    await user.type(
      await screen.findByLabelText('Votre message'),
      'Enregistre une dépense de 10 000 Ar',
    );
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    expect(
      await screen.findByText(
        'Sur quel compte dois-je enregistrer cette dépense ?',
      ),
    ).toBeTruthy();

    await user.type(screen.getByLabelText('Votre message'), 'en cash');
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));

    await waitFor(() =>
      expect(apiSendAssistantMessage).toHaveBeenCalledTimes(2),
    );
    const secondCall = vi.mocked(apiSendAssistantMessage).mock.calls[1]!;
    expect(secondCall[0].draftId).toBe(draftId);
  });

  it('échec réseau : le message optimiste est retiré et le texte restauré', async () => {
    const user = userEvent.setup();
    vi.mocked(apiSendAssistantMessage).mockRejectedValue(
      new Error('Service indisponible.'),
    );
    renderPage();
    await waitPage();

    await user.type(
      await screen.findByLabelText('Votre message'),
      'Bonjour',
    );
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));

    expect(
      await screen.findByText('Service indisponible.'),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText('Votre message') as HTMLTextAreaElement).value,
    ).toBe('Bonjour');
  });
});

describe('AssistantPage — propositions à confirmer', () => {
  it('PROPOSE_ACTION : carte affichée puis confirmation = exécution et message de fin', async () => {
    const user = userEvent.setup();
    vi.mocked(apiSendAssistantMessage).mockResolvedValue({
      kind: 'PROPOSE_ACTION',
      text: 'Voici la dépense que je propose.',
      proposal: PROPOSAL,
    });
    vi.mocked(apiConfirmAssistantProposal).mockResolvedValue({
      proposal: {
        ...PROPOSAL,
        status: 'EXECUTED',
        confirmedAt: '2026-09-06T10:05:00.000Z',
        executedAt: '2026-09-06T10:05:00.000Z',
        resultingResourceType: 'transaction',
        resultingResourceId: '00000000-0000-4000-8000-0000000000c3',
      },
      result: {
        message: 'Dépense enregistrée.',
        resourceType: 'transaction',
        resourceId: '00000000-0000-4000-8000-0000000000c3',
      },
    });
    renderPage();
    await waitPage();

    await user.type(
      await screen.findByLabelText('Votre message'),
      'Enregistre 10 000 Ar en cash',
    );
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));

    // La carte affiche le résumé sûr (jamais de payload financier brut).
    expect(await screen.findByText('Dépense à enregistrer')).toBeTruthy();
    expect(screen.getByText('Voici la dépense que je propose.')).toBeTruthy();
    expect(screen.getByText('10 000 Ar')).toBeTruthy();

    await user.click(
      screen.getByRole('button', { name: 'Confirmer la dépense' }),
    );
    await waitFor(() =>
      expect(apiConfirmAssistantProposal).toHaveBeenCalledWith(PROPOSAL.id),
    );
    expect(await screen.findByText('Exécutée')).toBeTruthy();
    expect(await screen.findByText('Dépense enregistrée.')).toBeTruthy();
    // Plus aucune confirmation possible après exécution.
    expect(
      screen.queryByRole('button', { name: 'Confirmer la dépense' }),
    ).toBeNull();
  });

  it('annulation : la proposition passe à « Annulée » sans appel de confirmation', async () => {
    const user = userEvent.setup();
    vi.mocked(apiSendAssistantMessage).mockResolvedValue({
      kind: 'PROPOSE_ACTION',
      text: null,
      proposal: PROPOSAL,
    });
    vi.mocked(apiCancelAssistantProposal).mockResolvedValue({
      proposal: {
        ...PROPOSAL,
        status: 'CANCELED',
        canceledAt: '2026-09-06T10:06:00.000Z',
      },
    });
    renderPage();
    await waitPage();

    await user.type(
      await screen.findByLabelText('Votre message'),
      'Ajoute une dépense',
    );
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));

    expect(await screen.findByText('Dépense à enregistrer')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Annuler' }));

    await waitFor(() =>
      expect(apiCancelAssistantProposal).toHaveBeenCalledWith(PROPOSAL.id),
    );
    expect(apiConfirmAssistantProposal).not.toHaveBeenCalled();
    expect(await screen.findByText('Annulée')).toBeTruthy();
  });
});


