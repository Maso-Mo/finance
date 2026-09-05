import { seedSystemCategories } from '../src/categories/seed.js';
import { prisma } from '../src/db.js';

/**
 * Seed explicite des catégories système (idempotent).
 * Usage : `pnpm db:seed` (depuis apps/api). Les catégories ne sont jamais
 * créées à l'occasion d'un GET.
 */
async function main(): Promise<void> {
  await seedSystemCategories();
  console.log('[seed] Catégories système initialisées.');
}

main()
  .catch((error) => {
    console.error('[seed] Erreur :', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
