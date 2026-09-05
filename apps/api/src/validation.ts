import type { ZodType } from 'zod';
import { ApiError } from './http-error.js';

/**
 * Parse un corps de requête avec un schéma Zod partagé (shared-types).
 * En cas d'échec, lève une ApiError 400 compréhensible pour le frontend.
 */
export function parseOrThrow<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const prefix =
      issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    throw new ApiError(400, `${prefix}${issue?.message ?? 'Invalid input.'}`);
  }
  return result.data;
}
