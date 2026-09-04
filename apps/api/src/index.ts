import express from 'express';

const app = express();

// Middleware de base : parsing JSON pour les futurs endpoints REST.
app.use(express.json());

/**
 * Endpoint technique de santé.
 * Sert uniquement à vérifier que le serveur Express démarre correctement.
 * Aucune logique métier, aucune base de données à ce stade.
 */
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: '@finance/api',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

const port = Number(process.env.PORT ?? 4000);

app.listen(port, () => {
  console.log(`[@finance/api] listening on http://localhost:${port}`);
});
