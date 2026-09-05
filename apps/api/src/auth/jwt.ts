import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { authConfig } from '../config.js';

/**
 * Signe et vérifie l'access token (JWT de courte durée).
 *  - sujet (sub) = id utilisateur ;
 *  - issuer/audience explicites pour limiter l'usage du jeton.
 */
export function signAccessToken(userId: string): string {
  const options: SignOptions = {
    subject: userId,
    issuer: authConfig.jwt.issuer,
    audience: authConfig.jwt.audience,
    expiresIn: authConfig.jwt.expiresIn as SignOptions['expiresIn'],
  };
  return jwt.sign({}, authConfig.jwt.secret, options);
}

export interface AccessTokenPayload {
  sub: string;
}

/** Retourne le payload si le jeton est valide, sinon null. */
export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, authConfig.jwt.secret, {
      issuer: authConfig.jwt.issuer,
      audience: authConfig.jwt.audience,
    });
    if (typeof decoded === 'object' && decoded !== null && decoded.sub) {
      return { sub: decoded.sub as string };
    }
    return null;
  } catch {
    return null;
  }
}

