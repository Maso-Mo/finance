import type { Request, RequestHandler } from 'express';
import { corsConfig } from '../config.js';
import { ApiError } from '../http-error.js';
import { verifyAccessToken } from './jwt.js';

// Étend les requêtes Express avec l'id utilisateur authentifié.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/**
 * Middleware de protection des routes :
 * Authorization: Bearer <accessToken> → validation JWT → req.userId.
 * Sinon HTTP 401.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new ApiError(401, 'Authentication required.');
  }
  const token = header.slice('Bearer '.length).trim();
  const payload = verifyAccessToken(token);
  if (!payload) {
    throw new ApiError(401, 'Invalid or expired token.');
  }
  req.userId = payload.sub;
  next();
};

/**
 * Protection CSRF pour les endpoints reposant sur le refresh cookie
 * (/auth/refresh, /auth/logout).
 *
 * Stratégie retenue : SameSite=Lax sur le cookie + vérification stricte de
 * l'en-tête Origin. Le frontend web (localhost:5173) et l'API
 * (localhost:4000) sont same-site (même hôte localhost) mais cross-origin :
 * seul l'Origin autorisé peut exploiter le cookie. Si un Origin est envoyé et
 * n'est pas autorisé, on refuse (403). L'absence d'Origin (clients non
 * navigateur / curl) reste autorisée.
 */
export const requireTrustedOrigin: RequestHandler = (req, _res, next) => {
  const origin = req.headers.origin;
  if (origin && !corsConfig.origin.includes(origin)) {
    throw new ApiError(403, 'Origin not allowed.');
  }
  next();
};

export type { Request };
