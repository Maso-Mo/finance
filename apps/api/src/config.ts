/**
 * Configuration de l'API lue depuis l'environnement.
 * Aucun secret n'est codé en dur : tout provient des variables d'environnement
 * (définies dans apps/api/.env, ignoré par Git — voir .env.example).
 */

function readRequired(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable "${name}". Check apps/api/.env (see .env.example).`,
    );
  }
  return value;
}

const isProd = process.env.NODE_ENV === 'production';

export const appConfig = {
  isProd,
  port: Number(process.env.PORT ?? 4000),
};

export const authConfig = {
  jwt: {
    secret: readRequired('JWT_ACCESS_SECRET'),
    issuer: process.env.JWT_ISSUER ?? 'finance-api',
    audience: process.env.JWT_AUDIENCE ?? 'finance-web',
    expiresIn: process.env.ACCESS_TOKEN_TTL ?? '15m',
  },
  refresh: {
    cookieName: process.env.REFRESH_COOKIE_NAME ?? 'finance_refresh',
    cookiePath: '/auth',
    ttlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
    cookieSecure:
      process.env.COOKIE_SECURE === 'true' ||
      process.env.NODE_ENV === 'production',
  },
};

export const corsConfig = {
  // Frontend autorisé (origine explicite, jamais "*" avec credentials).
  origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
};
