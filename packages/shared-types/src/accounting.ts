import { z } from 'zod';
import { dashboardResponseSchema } from './account.js';

export const accountingKindSchema = z.enum(['ALL', 'INCOME', 'EXPENSE', 'TRANSFER', 'ADJUSTMENT', 'DEBT']);
export type AccountingKind = z.infer<typeof accountingKindSchema>;
export const accountingRowSchema = z.object({
  id: z.string(), date: z.string(), type: z.string(), description: z.string(),
  source: z.string(), destination: z.string(), category: z.string(),
  incoming: z.string(), outgoing: z.string(), fees: z.string(),
});
export type AccountingRow = z.infer<typeof accountingRowSchema>;
export const accountingOverviewSchema = dashboardResponseSchema.extend({
  month: z.string(), income: z.string(), expense: z.string(), result: z.string(), internal: z.string(),
});
export type AccountingOverview = z.infer<typeof accountingOverviewSchema>;
export const accountingJournalSchema = z.object({
  rows: z.array(accountingRowSchema), total: z.number(), page: z.number(), limit: z.number(),
});
export type AccountingJournal = z.infer<typeof accountingJournalSchema>;
