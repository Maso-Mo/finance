import { z } from 'zod';

/**
 * Contrats partagés des catégories (étape 5).
 *
 * Seules les catégories SYSTÈME sont exposées/utilisables pour cette étape.
 * Elles sont initialisées par un seed explicite et idempotent (jamais par un
 * GET). `code` est un slug stable ; `name` est le libellé affiché.
 */
export const categoryPublicSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  isSystem: z.boolean(),
});
export type CategoryPublic = z.infer<typeof categoryPublicSchema>;

export const categoriesResponseSchema = z.object({
  categories: z.array(categoryPublicSchema),
});
export type CategoriesResponse = z.infer<typeof categoriesResponseSchema>;
