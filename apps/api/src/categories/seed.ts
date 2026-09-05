import { prisma } from '../db.js';

/**
 * Catégories SYSTÈME (étape 5).
 *
 * Uniquement ces catégories sont utilisables pour cette étape. Elles sont
 * initialisées de façon EXPLICITE, déterministe et idempotente via un seed
 * (apps/api/prisma/seed.ts ou la commande `pnpm db:seed`) — jamais à l'occasion
 * d'un GET.
 *
 * `code` : slug stable (indépendant de la langue) ; `name` : libellé affiché.
 */
export const SYSTEM_CATEGORIES = [
  { code: 'groceries', name: 'Courses' },
  { code: 'restaurant', name: 'Restaurant' },
  { code: 'transport', name: 'Transport' },
  { code: 'housing', name: 'Logement' },
  { code: 'internet', name: 'Internet' },
  { code: 'subscription', name: 'Abonnement' },
  { code: 'clothing', name: 'Vêtements' },
  { code: 'health', name: 'Santé' },
  { code: 'leisure', name: 'Loisirs' },
  { code: 'other', name: 'Autre' },
] as const satisfies readonly { code: string; name: string }[];

/**
 * Upsert idempotent des catégories système : peut être exécuté sans risque à
 * chaque démarrage d'une base de test ou via le script de seed (dev/prod).
 */
export async function seedSystemCategories(): Promise<void> {
  for (const category of SYSTEM_CATEGORIES) {
    await prisma.category.upsert({
      where: { code: category.code },
      update: { name: category.name, isSystem: true, userId: null },
      create: {
        code: category.code,
        name: category.name,
        isSystem: true,
        userId: null,
      },
    });
  }
}
