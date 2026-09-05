import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

/**
 * Point d'accès central au Prisma Client (Prisma 7).
 *
 * Un unique PrismaClient est créé et partagé par toute l'application
 * (à importer via `prisma`). Il est branché sur PostgreSQL via le driver
 * adapter `PrismaPg` (@prisma/adapter-pg + pg), qui reçoit directement la
 * chaîne de connexion DATABASE_URL (définie dans apps/api/.env).
 *
 * Le client est importé depuis le répertoire généré (src/generated/prisma),
 * produit par `prisma generate` (voir prisma/schema.prisma).
 */
const connectionString = process.env.DATABASE_URL ?? '';
const adapter = new PrismaPg({ connectionString });

export const prisma = new PrismaClient({ adapter });
