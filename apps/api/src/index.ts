import 'dotenv/config';
import express from 'express';
import { prisma } from './db.js';

const app = express();

// Middleware de base : parsing JSON pour les futurs endpoints REST.
app.use(express.json());

/**
 * Endpoint technique de santé.
 *
 * Distingue deux choses :
 *  - l'API est fonctionnelle (le serveur Express répond) ;
 *  - la base de données est accessible (test de connexion PostgreSQL).
 *
 * Vérification minimale (SELECT 1), sans création de donnée métier.
 */
app.get('/health', async (_req, res) => {
  let database: { connected: boolean; latencyMs: number | null } = {
    connected: false,
    latencyMs: null,
  };

  try {
    const startedAt = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    database = { connected: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    // On logge le détail côté serveur, mais on ne renvoie pas l'erreur brute
    // au client (pas d'information interne exposée).
    console.error('[health] database check failed:', error);
    database = { connected: false, latencyMs: null };
  }

  res.status(database.connected ? 200 : 503).json({
    status: database.connected ? 'ok' : 'degraded',
    service: '@finance/api',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    database,
  });
});

const port = Number(process.env.PORT ?? 4000);

const server = app.listen(port, () => {
  console.log(`[@finance/api] listening on http://localhost:${port}`);
});

// Fermeture propre de Prisma à l'arrêt du processus.
function shutdown(): void {
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
