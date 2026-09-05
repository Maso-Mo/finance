import { PrismaClient } from '@prisma/client';

/**
 * Point d'accès central au Prisma Client.
 *
 * Un unique PrismaClient est créé et partagé par toute l'application
 * (à importer via `prisma`). Cela évite de créer une instance par route,
 * ce qui multiplierait les connexions. Prisma gère lui-même le pool.
 */
export const prisma = new PrismaClient();
