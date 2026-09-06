/**
 * @finance/shared-types
 *
 * Contrats partagés entre le frontend (web) et le backend (api) :
 * schémas Zod, types TypeScript et enums métier. Source unique de validation.
 *
 * Règles : indépendant de Prisma, aucun secret (mot de passe, refresh token
 * brut, types Prisma internes) n'est partagé ici.
 */

export * from './auth.js';
export * from './account.js';
export * from './categories.js';
export * from './transaction.js';
export * from './planned.js';
export * from './income.js';
export * from './budget.js';
export * from './forecast.js';

