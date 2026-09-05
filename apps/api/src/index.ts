import { app, appConfig } from './app.js';
import { prisma } from './db.js';
import { startPlannedExpenseScheduler } from './scheduler.js';

/**
 * Point d'entrée de l'API : démarre le serveur HTTP.
 * La construction de l'application (routes, middlewares) vit dans app.ts,
 * ce qui permet de la réutiliser dans les tests sans écouter un port.
 */

// Maintenance idempotente des occurrences récurrentes (étape 6) : rattrapage
// immédiat + job quotidien. Ne paie rien, ne débite aucun compte.
startPlannedExpenseScheduler();

const server = app.listen(appConfig.port, () => {
  console.log(`[@finance/api] listening on http://localhost:${appConfig.port}`);
});

// Fermeture propre de Prisma à l'arrêt du processus.
function shutdown(): void {
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
