import { prisma } from '../db.js';
import { authConfig } from '../config.js';
import { ApiError } from '../http-error.js';
import { hashPassword, verifyPassword } from './password.js';
import { signAccessToken } from './jwt.js';
import {
  hashRefreshToken,
  issueRefreshToken,
  refreshExpiresAt,
} from './refresh-token.js';
import type { PublicUser } from '@finance/shared-types';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult extends AuthTokens {
  user: PublicUser;
}

type PublicUserRow = { id: string; email: string };

function toPublicUser(row: PublicUserRow): PublicUser {
  return { id: row.id, email: row.email };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}

/** Crée une session de refresh et signe l'access token pour un utilisateur. */
async function createSession(userId: string): Promise<AuthTokens> {
  const refresh = issueRefreshToken();
  await prisma.refreshSession.create({
    data: {
      userId,
      tokenHash: refresh.hash,
      expiresAt: refreshExpiresAt(),
    },
  });
  return {
    accessToken: signAccessToken(userId),
    refreshToken: refresh.token,
  };
}

/** Inscription. Refuse proprement un email déjà utilisé. */
export async function registerUser(
  email: string,
  password: string,
): Promise<AuthResult> {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new ApiError(409, 'An account with this email already exists.');
  }

  let user: PublicUserRow;
  try {
    user = await prisma.user.create({
      data: { email, passwordHash: await hashPassword(password) },
      select: { id: true, email: true },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, 'An account with this email already exists.');
    }
    throw error;
  }

  const tokens = await createSession(user.id);
  return { ...tokens, user: toPublicUser(user) };
}

/** Connexion. Réponse générique si les identifiants sont invalides. */
export async function loginUser(
  email: string,
  password: string,
): Promise<AuthResult> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await verifyPassword(user.passwordHash, password))) {
    // Réponse volontairement générique : on ne révèle pas si l'email existe.
    throw new ApiError(401, 'Invalid email or password.');
  }

  const tokens = await createSession(user.id);
  return { ...tokens, user: toPublicUser(user) };
}

/**
 * Rotation d'une session de refresh.
 * L'ancien refresh token est révoqué (jamais réutilisable ensuite) et un
 * nouveau est émis. Renvoie un nouvel access token + un nouveau refresh token.
 */
export async function refreshSession(rawToken: string): Promise<AuthResult> {
  if (!rawToken) {
    throw new ApiError(401, 'Refresh token missing.');
  }

  const tokenHash = hashRefreshToken(rawToken);
  const session = await prisma.refreshSession.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, email: true } } },
  });

  if (!session) {
    throw new ApiError(401, 'Invalid or expired refresh token.');
  }
  if (session.revokedAt !== null || session.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(401, 'Invalid or expired refresh token.');
  }

  const next = issueRefreshToken();
  const now = new Date();

  // Rotation atomique : on révoque l'ancienne session et on en crée une nouvelle.
  await prisma.$transaction(async (tx) => {
    await tx.refreshSession.update({
      where: { id: session.id },
      data: { revokedAt: now },
    });
    await tx.refreshSession.create({
      data: {
        userId: session.userId,
        tokenHash: next.hash,
        expiresAt: refreshExpiresAt(),
      },
    });
  });

  return {
    accessToken: signAccessToken(session.userId),
    refreshToken: next.token,
    user: toPublicUser(session.user),
  };
}

/** Révoque la session associée au refresh token (logout). */
export async function revokeSession(rawToken: string): Promise<void> {
  if (!rawToken) {
    return;
  }
  const tokenHash = hashRefreshToken(rawToken);
  await prisma.refreshSession.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Retourne l'utilisateur public pour un id authentifié, sinon 401. */
export async function getUserById(userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true },
  });
  if (!user) {
    throw new ApiError(401, 'User not found.');
  }
  return toPublicUser(user);
}

export { authConfig };
