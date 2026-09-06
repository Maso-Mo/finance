import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssistantMessageResponse,
  AssistantProposalPublic,
} from '@finance/shared-types';
import { useAuth } from '../auth/AuthContext';
import {
  apiCancelAssistantProposal,
  apiConfirmAssistantProposal,
  apiGetAssistantStatus,
  apiSendAssistantMessage,
} from '../auth/api';
import { NotificationsBell } from '../components/NotificationsBell';
import { ThemeToggle } from '../components/ThemeToggle';
import { toISODate } from '../lib/format';

/**
 * Assistant IA financier (étape 13) — page de conversation.
 *
 * Règles de sécurité affichées et appliquées par le frontend :
 *  - l'assistant est LECTURE SEULE : il ne peut jamais écrire une donnée
 *    financière directement ;
 *  - toute action passe par une proposition STRUCTURÉE que l'utilisateur doit
 *    confirmer explicitement (bouton sur la carte) ;
 *  - la confirmation part du seul `proposalId` : le frontend n'envoie jamais
 *    de montant/compte/catégorie « remplacés ».
 */

const SUGGESTIONS = [
  'Enregistre une dépense de 25 000 Ar chez un restaurant, payée en cash aujourd’hui',
  'Quel est mon total disponible ?',
  'Je dois recevoir 80 000 Ar la semaine prochaine',
  'Prévois 120 000 Ar de loyer le 5 du mois prochain',
  'J’ai prêté 50 000 Ar à Hery, à rembourser dans deux semaines',
];

const PROPOSAL_STATUS_LABEL: Record<AssistantProposalPublic['status'], string> = {
  PENDING: 'En attente de confirmation',
  EXECUTED: 'Exécutée',
  CANCELED: 'Annulée',
  EXPIRED: 'Expirée (délai dépassé)',
  FAILED: 'Échec de l’exécution',
};

type ChatContent =
  | { role: 'user' | 'assistant'; kind: 'message'; text: string }
  | {
      role: 'assistant';
      kind: 'proposal';
      text: string | null;
      proposal: AssistantProposalPublic;
    };

type ChatItem = { id: number } & ChatContent;

function detectedTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString('fr-FR', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
}

export default function AssistantPage() {
  const { status, user, signOut } = useAuth();
  const queryClient = useQueryClient();
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ['assistant-status'],
    queryFn: apiGetAssistantStatus,
    staleTime: 60_000,
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items, sending]);

  function push(item: ChatContent) {
    const id = nextId.current;
    nextId.current += 1;
    setItems((prev) => [...prev, { ...item, id }]);
  }

  function refreshFinancialData() {
    for (const key of [
      'dashboard',
      'reminders',
      'planned',
      'recurring',
      'expected',
      'budgets',
      'transfers',
      'savings',
      'debts',
      'notifications',
    ]) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  }

  function applyAssistantResponse(response: AssistantMessageResponse) {
    switch (response.kind) {
      case 'ANSWER':
        push({ role: 'assistant', kind: 'message', text: response.text });
        setDraftId(null);
        break;
      case 'ASK_CLARIFICATION':
        push({ role: 'assistant', kind: 'message', text: response.text });
        // Le brouillon garde la même intention : il sera joint au prochain envoi.
        setDraftId(response.draftId);
        break;
      case 'PROPOSE_ACTION':
        push({
          role: 'assistant',
          kind: 'proposal',
          text: response.text,
          proposal: response.proposal,
        });
        setDraftId(null);
        break;
      case 'UNSUPPORTED':
        push({ role: 'assistant', kind: 'message', text: response.text });
        setDraftId(null);
        break;
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || sending || !statusQuery.data?.available) {
      return;
    }
    const optimisticId = nextId.current;
    nextId.current += 1;
    setItems((prev) => [
      ...prev,
      { id: optimisticId, role: 'user', kind: 'message', text },
    ]);
    setInput('');
    setSending(true);
    setError(null);
    const pendingDraftId = draftId;
    try {
      const response = await apiSendAssistantMessage({
        message: text,
        draftId: pendingDraftId ?? undefined,
        timezone: detectedTimezone(),
        localDate: toISODate(new Date()),
      });
      applyAssistantResponse(response);
    } catch (err) {
      // La réponse n'est pas arrivée : on retire le message optimiste et on
      // restaure le texte pour que l'utilisateur puisse réessayer.
      setItems((prev) => prev.filter((item) => item.id !== optimisticId));
      setInput(text);
      setError(
        err instanceof Error
          ? err.message
          : 'L’assistant est indisponible. Réessaie dans un instant.',
      );
    } finally {
      setSending(false);
    }
  }

  function handleConfirm(proposal: AssistantProposalPublic) {
    setError(null);
    setBusyProposalId(proposal.id);
    apiConfirmAssistantProposal(proposal.id)
      .then(({ proposal: updated, result }) => {
        setItems((prev) =>
          prev.map((item) =>
            item.kind === 'proposal' && item.proposal.id === proposal.id
              ? { ...item, proposal: updated }
              : item,
          ),
        );
        const done = result?.message ?? updated.summary.doneMessage;
        if (done) {
          push({ role: 'assistant', kind: 'message', text: done });
        }
        refreshFinancialData();
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error
            ? err.message
            : 'La confirmation a échoué. Réessaie.',
        );
      })
      .finally(() => setBusyProposalId(null));
  }

  function handleCancel(proposal: AssistantProposalPublic) {
    setError(null);
    setBusyProposalId(proposal.id);
    apiCancelAssistantProposal(proposal.id)
      .then(({ proposal: updated }) => {
        setItems((prev) =>
          prev.map((item) =>
            item.kind === 'proposal' && item.proposal.id === proposal.id
              ? { ...item, proposal: updated }
              : item,
          ),
        );
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : 'L’annulation a échoué. Réessaie.',
        );
      })
      .finally(() => setBusyProposalId(null));
  }

  function resetConversation() {
    setItems([]);
    setDraftId(null);
    setError(null);
    setInput('');
  }

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-100 text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        Restauration de session…
      </div>
    );
  }

  if (status === 'guest') {
    return <Navigate to="/login" replace />;
  }

  const available = statusQuery.data?.available === true;
  const unavailableLoading = statusQuery.isLoading;

  return (
    <main className="min-h-screen bg-neutral-100 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/"
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            Accueil
          </Link>
          <h1 className="text-lg font-semibold">Assistant IA</h1>
          <span className="hidden text-xs text-neutral-500 sm:inline dark:text-neutral-400">
            {user?.email}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <NotificationsBell />
          <ThemeToggle />
          <button
            type="button"
            onClick={() => void signOut()}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            Déconnexion
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-8">
        <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold">
                Discuter avec votre assistant financier
              </h2>
              <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                L’assistant lit vos données et propose des actions — il
                n’exécute jamais rien sans votre confirmation explicite.
              </p>
            </div>
            {items.length > 0 && (
              <button
                type="button"
                onClick={resetConversation}
                className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                Effacer la conversation
              </button>
            )}
          </div>

          {error && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
            >
              {error}
            </p>
          )}

          {unavailableLoading ? (
            <div className="mt-6 flex h-64 items-center justify-center rounded-xl border border-dashed border-neutral-300 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
              Vérification de la configuration de l’assistant…
            </div>
          ) : !available ? (
            <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              <p className="font-medium">
                Assistant non configuré sur le serveur.
              </p>
              <p className="mt-1">
                Ajoutez la clé du fournisseur IA dans l’environnement de l’API
                {statusQuery.data?.provider
                  ? ` (fournisseur détecté : ${statusQuery.data.provider})`
                  : ' (aucun fournisseur détecté)'}{' '}
                puis redémarrez le serveur pour activer la conversation.
              </p>
            </div>
          ) : (
            <>
              <div
                ref={scrollRef}
                className="mt-4 flex h-96 flex-col gap-3 overflow-y-auto rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950/60"
                aria-live="polite"
              >
                {items.length === 0 ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
                    <p className="text-sm text-neutral-500 dark:text-neutral-400">
                      Demandez une information, une dépense à prévoir, un
                      budget…
                    </p>
                    <div className="flex max-w-md flex-wrap justify-center gap-2">
                      {SUGGESTIONS.map((suggestion) => (
                        <button
                          key={suggestion}
                          type="button"
                          onClick={() => setInput(suggestion)}
                          className="rounded-full border border-indigo-200 bg-white px-3 py-1.5 text-xs text-indigo-700 hover:bg-indigo-50 dark:border-indigo-800 dark:bg-neutral-900 dark:text-indigo-300 dark:hover:bg-indigo-950"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  items.map((item) => {
                    if (item.kind === 'proposal') {
                      return (
                        <ProposalCard
                          key={item.id}
                          text={item.text}
                          proposal={item.proposal}
                          busy={busyProposalId === item.proposal.id}
                          onConfirm={() => handleConfirm(item.proposal)}
                          onCancel={() => handleCancel(item.proposal)}
                        />
                      );
                    }
                    return (
                      <div
                        key={item.id}
                        className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                          item.role === 'user'
                            ? 'self-end rounded-br-sm bg-indigo-600 text-white'
                            : 'self-start rounded-bl-sm border border-neutral-200 bg-white text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100'
                        }`}
                      >
                        {item.text}
                      </div>
                    );
                  })
                )}
                {sending && (
                  <div className="self-start rounded-2xl rounded-bl-sm border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900">
                    L’assistant réfléchit…
                  </div>
                )}
              </div>
              <form onSubmit={handleSubmit} className="mt-4 flex items-end gap-2">
                <label htmlFor="assistant-message" className="sr-only">
                  Votre message
                </label>
                <textarea
                  id="assistant-message"
                  rows={2}
                  value={input}
                  maxLength={2000}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="Ex. : Enregistre une dépense de 10 000 Ar en cash aujourd’hui…"
                  className="min-h-11 flex-1 resize-none rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
                />
                <button
                  type="submit"
                  disabled={!input.trim() || sending}
                  className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  Envoyer
                </button>
              </form>
              <p className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
                {draftId
                  ? 'Une clarification est en cours : votre prochaine réponse complète la même demande. '
                  : ''}
                L’assistant répond à partir de vos données (lecture seule).
                Chaque action proposée doit être confirmée avant d’être
                enregistrée.
              </p>
            </>
          )}
        </section>
        <section className="mt-4 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <h2 className="text-sm font-semibold">Ce que l’assistant sait faire</h2>
          <ul className="mt-2 grid gap-x-6 gap-y-1 text-xs text-neutral-500 sm:grid-cols-2 dark:text-neutral-400">
            <li>• Lire vos soldes, transactions, budgets, échéances, dettes et épargne</li>
            <li>• Répondre à vos questions financières (lecture seule)</li>
            <li>• Proposer dépenses, revenus, transferts, budgets et échéances</li>
            <li>• Confirmer un paiement planifié ou un revenu reçu</li>
            <li>• Créer / régler une dette ou alimenter un plan d’épargne</li>
            <li>• Jamais écrire sans confirmation : tout passe par une carte à valider</li>
          </ul>
        </section>

        <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-500">
          L’assistant peut se tromper : relisez chaque proposition avant de la
          confirmer. Une proposition confirmée exécute la même opération que la
          page correspondante (avec ses règles comptables), sans jamais accepter
          un montant ou un compte modifié au dernier moment.
        </p>
      </div>
    </main>
  );
}
function ProposalCard({
  text,
  proposal,
  busy,
  onConfirm,
  onCancel,
}: {
  text: string | null;
  proposal: AssistantProposalPublic;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const pending = proposal.status === 'PENDING';
  return (
    <div className="max-w-[92%] self-start">
      {text && (
        <div className="mb-1 rounded-2xl rounded-bl-sm border border-neutral-200 bg-white px-3 py-2 text-sm leading-relaxed text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
          {text}
        </div>
      )}
      <div className="rounded-2xl border-2 border-indigo-200 bg-white p-4 dark:border-indigo-900 dark:bg-neutral-900">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-indigo-800 dark:text-indigo-200">
            {proposal.summary.title}
          </h3>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              pending
                ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                : proposal.status === 'EXECUTED'
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                  : 'bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
            }`}
          >
            {PROPOSAL_STATUS_LABEL[proposal.status]}
          </span>
        </div>
        <dl className="mt-3 space-y-1.5">
          {proposal.summary.lines.map((line) => (
            <div
              key={`${line.label}-${line.value}`}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <dt className="text-neutral-500 dark:text-neutral-400">
                {line.label}
              </dt>
              <dd className="text-right font-medium tabular-nums text-neutral-800 dark:text-neutral-100">
                {line.value}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {pending && (
            <button
              type="button"
              disabled={busy}
              onClick={onConfirm}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy ? 'Exécution…' : proposal.summary.confirmLabel}
            </button>
          )}
          {pending && (
            <button
              type="button"
              disabled={busy}
              onClick={onCancel}
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Annuler
            </button>
          )}
          {!pending && proposal.status === 'FAILED' && proposal.failureReason && (
            <p className="text-xs text-red-600 dark:text-red-400">
              {proposal.failureReason}
            </p>
          )}
        </div>

        <p className="mt-3 border-t border-neutral-100 pt-2 text-[10px] text-neutral-400 dark:border-neutral-800 dark:text-neutral-500">
          Proposition {proposal.id.slice(0, 8)}… ·{' '}
          {formatDateTime(proposal.createdAt)}
          {proposal.expiresAt
            ? ` · expire ${formatDateTime(proposal.expiresAt)}`
            : ''}
        </p>
      </div>
    </div>
  );
}







