import { prisma } from '../db.js';
import type { CategoriesResponse } from '@finance/shared-types';
import { ApiError } from '../http-error.js';

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

/**
 * Vérifie qu'une catégorie référencée existe parmi les catégories système.
 * Partagé par le journal (étape 5) et les dépenses planifiées (étape 6) :
 * UN seul système de catégories, jamais de second référentiel.
 */
export async function assertSystemCategory(
  categoryId: string | undefined | null,
): Promise<void> {
  if (!categoryId) {
    return;
  }
  const row = await prisma.category.findFirst({
    where: { id: categoryId, isSystem: true },
    select: { id: true },
  });
  if (!row) {
    throw new ApiError(400, 'Invalid category.');
  }
}

