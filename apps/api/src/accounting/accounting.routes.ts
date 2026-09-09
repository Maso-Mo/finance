import { Router } from 'express';
import { z } from 'zod';
import { accountingKindSchema, monthKeySchema } from '@finance/shared-types';
import { parseOrThrow } from '../validation.js';
import { getAccountingOverview, getAccountingJournal, csvCell } from './accounting.service.js';

export const accountingRouter = Router();
const querySchema = z.object({ month: monthKeySchema, kind: accountingKindSchema.default('ALL'), page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) });
accountingRouter.get('/overview', async (req, res) => {
  const { month } = parseOrThrow(querySchema, req.query);
  res.json(await getAccountingOverview(req.userId as string, month));
});
accountingRouter.get('/journal', async (req, res) => {
  const { month, kind, page, limit } = parseOrThrow(querySchema, req.query);
  res.json(await getAccountingJournal(req.userId as string, month, kind, page, limit));
});
accountingRouter.get('/export', async (req, res) => {
  const { month } = parseOrThrow(querySchema, req.query);
  // The export is bounded to one requested month. No browser history download.
  let csv = '\uFEFFDate;Type;Description;Compte source;Compte destination;Catégorie;Entrée;Sortie;Frais\r\n';
  let page = 1;
  while (true) {
    const data = await getAccountingJournal(req.userId as string, month, 'ALL', page, 100);
    for (const row of data.rows) csv += [row.date.slice(0, 10), row.type, row.description, row.source, row.destination, row.category, row.incoming, row.outgoing, row.fees].map(csvCell).join(';') + '\r\n';
    if (page * 100 >= data.total) break;
    page++;
  }
  res.type('text/csv; charset=utf-8').attachment(`finance-${month}.csv`).send(csv);
});
