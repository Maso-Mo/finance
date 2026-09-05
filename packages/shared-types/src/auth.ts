import { z } from 'zod';

/**
 * Contrats d'authentification partagés entre web et api.
 * La validation n'est jamais dupliquée : le backend parse les requêtes avec
 * ces schémas, le frontend type ses formulaires avec les types inférés.
 *
 * Aucun secret n'y figure (pas de passwordHash, pas de refresh token brut,
 * pas de types Prisma).
 */

// --- Email ---
// Normalisé en minuscules (comparaison cohérente), trim, puis validation.
export const emailSchema = z.string().trim().toLowerCase().email().max(254);

// --- Mot de passe ---
// Règle minimale : longueur suffisante, sans limite artificielle absurde.
export const passwordSchema = z.string().min(8).max(128);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

// --- Réponses ---
export const publicUserSchema = z.object({
  id: z.string().uuid(),
  email: emailSchema,
});

export const authResponseSchema = z.object({
  accessToken: z.string().min(1),
  user: publicUserSchema,
});

export const meResponseSchema = z.object({
  user: publicUserSchema,
});

export const errorResponseSchema = z.object({
  error: z.string().min(1),
});

// --- Types inférés ---
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type PublicUser = z.infer<typeof publicUserSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
