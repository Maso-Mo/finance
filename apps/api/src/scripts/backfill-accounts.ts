import 'dotenv/config';
import { prisma } from '../db.js';
import { ACCOUNT_TYPES } from '@finance/shared-types';

/**
 * Script de backfill : crée les comptes standards manquants pour les
 * utilisateurs créés avant l'étape "comptes" (ils n'ont alors aucun compte).
 *
 * Idempotent : on ne crée que les types absents, dans la devise principale
 * de chaque utilisateur. À exécuter une seule fois après la migration :
 *   pnpm db:backfill-accounts
 */
async function main(): Promise<void> {
  const users = await prisma.user.findMany({
    select: { id: true, currency: true },
  });

  let created = 0;
  for (const user of users) {
    const existing = await prisma.account.findMany({
      where: { userId: user.id },
      select: { type: true },
    });
    const existingTypes = new Set(existing.map((row) => row.type));
    const missing = ACCOUNT_TYPES.filter((type) => !existingTypes.has(type));

    if (missing.length > 0) {
      await prisma.account.createMany({
        data: missing.map((type) => ({
          userId: user.id,
          type,
          currency: user.currency,
        })),
      });
      created += missing.length;
    }
  }

  console.log(
    `[backfill] ${users.length} utilisateur(s) traités, ${created} compte(s) créé(s).`,
  );
}

main()
  .catch((error) => {
    console.error('[backfill] failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
