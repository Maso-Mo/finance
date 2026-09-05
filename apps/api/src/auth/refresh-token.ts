import { createHash, randomBytes } from 'node:crypto';
import { authConfig } from '../config.js';

/**
 * Refresh token opaque (aléatoire, haute entropie).
 * Il n'est jamais stocké en clair en base : seul son hash SHA-256 l'est.
 * Le client le reçoit uniquement via un cookie HttpOnly.
 */
export interface IssuedRefreshToken {
  token: string;
  hash: string;
}

export function issueRefreshToken(): IssuedRefreshToken {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function refreshExpiresAt(ttlDays: number = authConfig.refresh.ttlDays): Date {
  const date = new Date();
  date.setDate(date.getDate() + ttlDays);
  return date;
}
