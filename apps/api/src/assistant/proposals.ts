import {
  assistantActionSchema,
  assistantProposalPublicSchema,
  type AssistantAction,
  type AssistantActionType,
  type AssistantProposalPublic,
  type AssistantProposalSummary,
} from '@finance/shared-types';
import { prisma } from '../db.js';
import { ApiError } from '../http-error.js';
import { assistantConfig } from './config.js';
import { executeAction, doneMessageFor, type ExecutionOutcome } from './execute.js';

/**
 * PROPOSITIONS D'ACTION (étape 13).
 *
 * Une proposition n'est JAMAIS une écriture financière : seule la
 * confirmation explicite de SON propriétaire déclenche l'exécution
 * déterministe par les services métier existants.
 *
 * Garanties de la confirmation :
 *  - ownership (userId du JWT) ;
 *  - statut PENDING + non expirée (expiration 30 min) ;
 *  - réservation ATOMIQUE (updateMany conditionnel PENDING → EXECUTED) :
 *    deux confirmations simultanées → une seule action financière ;
 *  - le payload est RELU et revalidé depuis la base (le frontend ne peut
 *    jamais remplacer montant/compte/cible au moment du confirm) ;
 *  - l'état métier est RÉÉVALUÉ à l'exécution (les services existants
 *    refusent toute opération devenue invalide entre-temps).
 */

// Nombre de millisecondes de vie d'une proposition PENDING.
export function proposalTtlMs(): number {
  return assistantConfig.proposalTtlMinutes * 60 * 1000;
}

type ProposalRow = {
  id: string;
  userId: string;
  actionType: string;
  payload: unknown;
  summary: unknown;
  status: string;
  expiresAt: Date;
  confirmedAt: Date | null;
  executedAt: Date | null;
  canceledAt: Date | null;
  failureReason: string | null;
  resultingResourceType: string | null;
  resultingResourceId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Range ligne Prisma → DTO public (le payload n'est JAMAIS exposé). */
function toPublic(row: ProposalRow): AssistantProposalPublic {
  return {
    id: row.id,
    actionType: row.actionType as AssistantActionType,
    summary: row.summary as AssistantProposalSummary,
    status: row.status as AssistantProposalPublic['status'],
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
    executedAt: row.executedAt ? row.executedAt.toISOString() : null,
    canceledAt: row.canceledAt ? row.canceledAt.toISOString() : null,
    failureReason: row.failureReason,
    resultingResourceType: row.resultingResourceType,
    resultingResourceId: row.resultingResourceId,
  };
}

/** Persiste une proposition PENDING validée (payload + résumé sûrs). */
export async function createProposal(
  userId: string,
  action: AssistantAction,
  summary: AssistantProposalSummary,
): Promise<AssistantProposalPublic> {
  const now = new Date();
  const row = await prisma.assistantActionProposal.create({
    data: {
      userId,
      actionType: action.actionType,
      payload: JSON.parse(JSON.stringify(action)) as object,
      summary: JSON.parse(JSON.stringify(summary)) as object,
      status: 'PENDING',
      expiresAt: new Date(now.getTime() + proposalTtlMs()),
    },
  });
  return toPublic(row as unknown as ProposalRow);
}

/** Lecture par id (ownership) — marque EXPIRED si le délai est dépassé. */
export async function getProposal(
  userId: string,
  proposalId: string,
): Promise<AssistantProposalPublic> {
  const row = await prisma.assistantActionProposal.findFirst({
    where: { id: proposalId, userId },
  });
  if (!row) {
    throw new ApiError(404, 'Proposal not found.');
  }
  if (row.status === 'PENDING' && row.expiresAt.getTime() <= Date.now()) {
    const updated = await prisma.assistantActionProposal.update({
      where: { id: row.id },
      data: { status: 'EXPIRED' },
    });
    return toPublic(updated as unknown as ProposalRow);
  }
  return toPublic(row as unknown as ProposalRow);
}

/** Annulation : aucun effet financier, la proposition passe CANCELED. */
export async function cancelProposal(
  userId: string,
  proposalId: string,
): Promise<AssistantProposalPublic> {
  const now = new Date();
  const result = await prisma.assistantActionProposal.updateMany({
    where: { id: proposalId, userId, status: 'PENDING', expiresAt: { gt: now } },
    data: { status: 'CANCELED', canceledAt: now },
  });
  if (result.count === 0) {
    const row = await prisma.assistantActionProposal.findFirst({
      where: { id: proposalId, userId },
    });
    if (!row) {
      throw new ApiError(404, 'Proposal not found.');
    }
    if (row.status === 'PENDING') {
      // Expirée (statut PENDING mais expiresAt dépassé).
      await prisma.assistantActionProposal.update({
        where: { id: row.id },
        data: { status: 'EXPIRED' },
      });
      throw new ApiError(409, 'Cette proposition a expiré et ne peut plus être annulée.');
    }
    throw new ApiError(409, 'Cette proposition a déjà été traitée (status: ' + row.status + ').');
  }
  const updated = await prisma.assistantActionProposal.findUniqueOrThrow({
    where: { id: proposalId },
  });
  return toPublic(updated as unknown as ProposalRow);
}

export interface ProposalConfirmResult {
  proposal: AssistantProposalPublic;
  result: {
    message: string;
    resourceType: string | null;
    resourceId: string | null;
  };
}

/**
 * CONFIRMATION ATOMIQUE ET IDEMPOTENTE.
 *
 * Le frontend envoie uniquement { proposalId } : aucune donnée financière du
 * corps de la requête n'est acceptée — le payload provient TOUJOURS de la
 * ligne persistée et est revalidé ici.
 */
export async function confirmProposal(
  userId: string,
  proposalId: string,
): Promise<ProposalConfirmResult> {
  const now = new Date();

  // 1. Réservation atomique : PENDING + non expirée → EXECUTED.
  //    Deux confirmations simultanées : une seule gagne (count = 1).
  const claim = await prisma.assistantActionProposal.updateMany({
    where: { id: proposalId, userId, status: 'PENDING', expiresAt: { gt: now } },
    data: { status: 'EXECUTED', confirmedAt: now, executedAt: now },
  });

  if (claim.count !== 1) {
    const existing = await prisma.assistantActionProposal.findFirst({
      where: { id: proposalId, userId },
    });
    if (!existing) {
      throw new ApiError(404, 'Proposal not found.');
    }
    if (existing.status === 'PENDING') {
      // Expirée (statut encore PENDING mais expiresAt dépassé).
      await prisma.assistantActionProposal.update({
        where: { id: existing.id },
        data: { status: 'EXPIRED' },
      });
      throw new ApiError(409, 'Cette proposition a expiré. Merci de reformuler la demande.');
    }
    throw new ApiError(409, `Cette proposition a déjà été traitée (${existing.status}).`);
  }

  const row = await prisma.assistantActionProposal.findUniqueOrThrow({
    where: { id: proposalId },
  });

  // 2. Revalidation stricte du payload persisté (la DB est la seule source).
  let action: AssistantAction;
  try {
    const raw = JSON.parse(JSON.stringify(row.payload));
    action = assistantActionSchema.parse(raw);
  } catch {
    await prisma.assistantActionProposal.update({
      where: { id: proposalId },
      data: { status: 'FAILED', failureReason: 'Payload de proposition invalide.' },
    });
    throw new ApiError(409, 'Cette proposition n’est plus valide. Merci de reformuler la demande.');
  }

  // 3. Exécution déterministe par les services métier existants (l'état DB
  //    actuel est TOUJOURS réévalué : une opération devenue impossible est
  //    refusée par le service, sans jamais forcer l'action).
  let outcome: ExecutionOutcome;
  try {
    outcome = await executeAction(userId, action);
  } catch (error) {
    const isApi = error instanceof ApiError;
    const status = isApi ? error.status : 500;
    const message = isApi
      ? error.message
      : 'Une erreur interne est survenue pendant l’exécution.';
    if (!isApi) {
      // Log technique nettoyé : jamais de données financières ni de secrets.
      console.error('[assistant] proposal execution failed', { proposalId, userId });
    }
    await prisma.assistantActionProposal.update({
      where: { id: proposalId },
      data: { status: 'FAILED', failureReason: message.slice(0, 500) },
    });
    throw new ApiError(status, message);
  }

  // 4. Audit minimal d'une exécution réussie.
  await prisma.assistantActionProposal.update({
    where: { id: proposalId },
    data: {
      resultingResourceType: outcome.resourceType,
      resultingResourceId: outcome.resourceId,
    },
  });

  const finalRow = await prisma.assistantActionProposal.findUniqueOrThrow({
    where: { id: proposalId },
  });

  return {
    proposal: toPublic(finalRow as unknown as ProposalRow),
    result: {
      message: outcome.message || doneMessageFor(finalRow.actionType),
      resourceType: outcome.resourceType,
      resourceId: outcome.resourceId,
    },
  };
}

