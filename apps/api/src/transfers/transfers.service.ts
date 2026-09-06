import { prisma } from '../db.js';
import { ApiError } from '../http-error.js';
import type {
  AccountType,
  Currency,
  TransferPublic,
  TransfersResponse,
  TransferUpsert,
} from '@finance/shared-types';

/**
 * Service des TRANSFERTS INTERNES RÉELS (étape 9).
 *
 * ⚠ INVARIANT ABSOLU : un transfert interne n'est NI une Transaction EXPENSE
 * ni une Transaction INCOME. Créer/modifier/supprimer un Transfer ne touche
 * JAMAIS la table des transactions : seuls les soldes courants DÉRIVÉS des
 * comptes en tiennent compte (source −(amount + fee), destination +amount).
 *
 * L'application est un JOURNAL DE SUIVI, pas une banque : elle enregistre un
 * transfert déjà effectué par l'utilisateur. Elle ne contacte ni MVola, ni
 * une banque, ne déclenche aucun paiement et ne déplace aucun fonds.
 *
 * Règles défendues côté serveur (après validation Zod partagée) :
 *  - source ET destination appartiennent à l'utilisateur authentifié (sinon
 *    404 générique) ;
 *  - source <> destination (400, doublé par le CHECK en base) ;
 *  - devise V1 : celle de l'utilisateur, cohérente avec ses deux comptes ;
 *    aucune conversion ni taux de change ;
 *  - `amount` strictement positif, `feeAmount` >= 0 (frais TOUJOURS prélevés
 *    EN PLUS sur la source en V1) ;
 *  - PATCH = remplacement atomique complet ;
 *  - DELETE = suppression LOGIQUE (deletedAt) : plus aucun impact solde /
 *    Total disponible / forecast, mais la ligne reste en base.
 */

/** Inclusions systématiques pour sérialiser un transfert public. */
const includeTransfer = {
  sourceAccount: { select: { id: true, type: true } },
  destinationAccount: { select: { id: true, type: true } },
} as const;

/** Forme structurale d'une ligne de transfert avec ses relations. */
type TransferRow = {
  id: string;
  amount: { toString(): string };
  feeAmount: { toString(): string };
  currency: string;
  occurredAt: Date | null;
  dateUnknown: boolean;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  sourceAccount: { id: string; type: string };
  destinationAccount: { id: string; type: string };
};

/** Jour « YYYY-MM-DD » saisi par l'utilisateur → Date UTC à midi (neutre). */
function occurredAtToDate(value: string): Date {
  return new Date(`${value}T12:00:00.000Z`);
}

export function toPublicTransfer(row: TransferRow): TransferPublic {
  return {
    id: row.id,
    source: {
      id: row.sourceAccount.id,
      type: row.sourceAccount.type as AccountType,
    },
    destination: {
      id: row.destinationAccount.id,
      type: row.destinationAccount.type as AccountType,
    },
    amount: row.amount.toString(),
    feeAmount: row.feeAmount.toString(),
    currency: row.currency as Currency,
    occurredAt: row.occurredAt
      ? row.occurredAt.toISOString().slice(0, 10)
      : null,
    dateUnknown: row.dateUnknown,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Champs normalisés pour l'écriture (frais par défaut à 0). */
function transferData(input: TransferUpsert) {
  return {
    sourceAccountId: input.sourceAccountId,
    destinationAccountId: input.destinationAccountId,
    amount: input.amount,
    feeAmount: input.feeAmount ?? '0',
    occurredAt: input.occurredAt ? occurredAtToDate(input.occurredAt) : null,
    dateUnknown: input.dateUnknown ?? false,
    description: input.description?.trim() ? input.description.trim() : null,
  };
}


/**
 * Validation commune (création + modification) : source <> destination,
 * source ET destination possédées par l'utilisateur (404 générique sinon),
 * même devise que l'utilisateur (V1 mono-devise). Renvoie la devise.
 */
async function validateTransfer(
  userId: string,
  input: TransferUpsert,
): Promise<Currency> {
  if (input.sourceAccountId === input.destinationAccountId) {
    throw new ApiError(
      400,
      'Source and destination accounts must be different.',
    );
  }

  const rows = await prisma.account.findMany({
    where: {
      id: { in: [input.sourceAccountId, input.destinationAccountId] },
      userId,
    },
    select: { id: true, currency: true },
  });
  if (rows.length !== 2) {
    // Ni trouvé ni autorisé : réponse générique sans fuite d'existence.
    throw new ApiError(404, 'Account not found.');
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currency: true },
  });
  if (!user) {
    throw new ApiError(401, 'User not found.');
  }

  const source = rows.find((row) => row.id === input.sourceAccountId)!;
  const destination = rows.find(
    (row) => row.id === input.destinationAccountId,
  )!;
  if (
    source.currency !== user.currency ||
    destination.currency !== user.currency
  ) {
    throw new ApiError(
      400,
      'Transfer accounts must share the user’s main currency (V1).',
    );
  }
  return user.currency as Currency;
}

/**
 * Historique GLOBAL paginé de l'utilisateur (transfers ACTIFS uniquement).
 * Tri stable : date la plus récente d'abord, date inconnue en dernier
 * (`occurredAt` null), puis createdAt desc, puis id asc.
 */
export async function getTransferLedger(
  userId: string,
  page: number,
  limit: number,
): Promise<TransfersResponse> {
  const where = { userId, deletedAt: null };
  const [rows, total] = await Promise.all([
    prisma.accountTransfer.findMany({
      where,
      include: includeTransfer,
      orderBy: [
        { occurredAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
        { id: 'asc' },
      ],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.accountTransfer.count({ where }),
  ]);

  return {
    transfers: rows.map(toPublicTransfer),
    page,
    limit,
    hasMore: page * limit < total,
  };
}

/** Crée un Transfer (aucune Transaction créée — jamais). */
export async function createTransfer(
  userId: string,
  input: TransferUpsert,
): Promise<TransferPublic> {
  const currency = await validateTransfer(userId, input);
  const row = await prisma.accountTransfer.create({
    data: { ...transferData(input), userId, currency },
    include: includeTransfer,
  });
  return toPublicTransfer(row);
}

/**
 * Modifie un Transfer de façon ATOMIQUE (remplacement complet). Un Transfer
 * supprimé logiquement n'est plus modifiable (409).
 */
export async function updateTransfer(
  userId: string,
  transferId: string,
  input: TransferUpsert,
): Promise<TransferPublic> {
  const existing = await prisma.accountTransfer.findFirst({
    where: { id: transferId, userId },
    select: { id: true, deletedAt: true },
  });
  if (!existing) {
    throw new ApiError(404, 'Transfer not found.');
  }
  if (existing.deletedAt) {
    throw new ApiError(409, 'A deleted transfer cannot be modified.');
  }

  const currency = await validateTransfer(userId, input);
  await prisma.accountTransfer.update({
    where: { id: transferId },
    data: { ...transferData(input), userId, currency },
  });

  const row = await prisma.accountTransfer.findUniqueOrThrow({
    where: { id: transferId },
    include: includeTransfer,
  });
  return toPublicTransfer(row);
}

/**
 * Suppression LOGIQUE : la ligne reste en base (deletedAt), plus aucun impact
 * sur les soldes, le Total disponible ou le forecast financier. Aucune
 * Transaction n'est touchée.
 */
export async function deleteTransfer(
  userId: string,
  transferId: string,
): Promise<void> {
  const result = await prisma.accountTransfer.updateMany({
    where: { id: transferId, userId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  if (result.count === 0) {
    // Ni trouvé, ni autorisé, ni déjà supprimé : réponse générique.
    throw new ApiError(404, 'Transfer not found.');
  }
}
