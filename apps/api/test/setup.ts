import { config as loadEnv } from 'dotenv';

/**
 * Charge l'environnement de test (.env.test, ignoré par Git) AVANT
 * l'import de l'application, afin que Prisma (adapter) et la config JWT
 * utilisent la base de test et les secrets de test.
 */
loadEnv({ path: new URL('../.env.test', import.meta.url).pathname });
