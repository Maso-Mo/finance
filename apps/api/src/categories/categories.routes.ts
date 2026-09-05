import { Router } from 'express';
import * as svc from './categories.service.js';

const router = Router();

// Les routes sont montées dans app.ts sous `/categories` APRÈS `requireAuth` :
// `req.userId` est donc toujours présent ici.

// GET /categories → catégories système (seed explicite, jamais créées ici).
router.get('/', async (_req, res) => {
  res.json(await svc.listSystemCategories());
});

export const categoriesRouter = router;
