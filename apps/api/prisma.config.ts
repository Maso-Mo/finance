import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Configuration Prisma CLI (Prisma 7).
 *
 * Fournit le chemin du schéma et l'URL de connexion à la base de
 * développement (PostgreSQL local). L'URL est lue depuis apps/api/.env
 * via la variable DATABASE_URL (ignoré par Git, cf. apps/api/.env.example).
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
