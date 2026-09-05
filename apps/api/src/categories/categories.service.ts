import { prisma } from '../db.js';
import type { CategoriesResponse } from '@finance/shared-types';

/**
 * Service des catégories (étape 5).
 *
 * Seules les catégories SYSTÈME sont exposées : elles ont été initialisées par
 * un seed explicite et idempotent (jamais créées à l'occasion d'un GET).
 * `userId` nullable prépare les futures catégories personnalisées.
 */
export async function listSystemCategories(): Promise<CategoriesResponse> {
  const rows = await prisma.category.findMany({
    where: { isSystem: true },
    orderBy: { name: 'asc' },
    select: { id: true, code: true, name: true, isSystem: true },
  });
  return { categories: rows };
}
