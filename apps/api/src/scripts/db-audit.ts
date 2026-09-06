import 'dotenv/config';
import pg from 'pg';

/**
 * db:audit — AUDIT D'INTÉGRITÉ READ-ONLY (jamais une écriture).
 *
 * Vérifie les invariants critiques de la base sans la modifier :
 *   pnpm --filter @finance/api db:audit
 *
 * Cible : base de .env (DATABASE_URL) par défaut, ou surcharge via :
 *   DATABASE_URL=postgresql://... pnpm --filter @finance/api db:audit
 *
 * Sortie : une ligne par contrôle (OK / VIOLATION + échantillon), puis un
 * résumé. Code de sortie : 0 si tout passe, 1 si une violation est trouvée.
 */

const checks: { name: string; sql: string }[] = [
  {
    name: 'Chaque utilisateur possède exactement les 6 comptes standards (aucun doublon)',
    sql: `SELECT u.id, u.email, count(a.id) AS account_count, count(DISTINCT a.type) AS type_count
          FROM users u LEFT JOIN accounts a ON a."userId" = u.id
          GROUP BY u.id, u.email
          HAVING count(a.id) <> 6 OR count(DISTINCT a.type) <> 6`,
  },
  {
    name: 'Aucun type de compte dupliqué par utilisateur',
    sql: `SELECT "userId", type, count(*) AS c FROM accounts GROUP BY "userId", type HAVING count(*) > 1`,
  },
  {
    name: 'Aucune allocation orpheline (transaction ou compte supprimé physiquement)',
    sql: `SELECT al.id
          FROM transaction_account_allocations al
          LEFT JOIN transactions t ON t.id = al."transactionId"
          LEFT JOIN accounts a ON a.id = al."accountId"
          WHERE t.id IS NULL OR a.id IS NULL`,
  },
  {
    name: 'Aucune allocation dont le compte appartient à un autre utilisateur',
    sql: `SELECT al.id, t."userId" AS transaction_user, a."userId" AS account_user
          FROM transaction_account_allocations al
          JOIN transactions t ON t.id = al."transactionId"
          JOIN accounts a ON a.id = al."accountId"
          WHERE t."userId" <> a."userId"`,
  },
  {
    name: 'Somme des allocations = montant de la transaction (compte connu, active)',
    sql: `SELECT t.id, t.amount::text, coalesce(sum(al.amount), 0)::text AS allocated
          FROM transactions t
          LEFT JOIN transaction_account_allocations al ON al."transactionId" = t.id
          WHERE t."deletedAt" IS NULL AND t."accountUnknown" = false
          GROUP BY t.id
          HAVING coalesce(sum(al.amount), 0) <> t.amount`,
  },
  {
    name: 'Compte inconnu ⇒ aucune allocation',
    sql: `SELECT t.id FROM transactions t
          WHERE t."accountUnknown" = true AND EXISTS (
            SELECT 1 FROM transaction_account_allocations al WHERE al."transactionId" = t.id
          )`,
  },
  {
    name: 'Compte connu (active) ⇒ au moins une allocation',
    sql: `SELECT t.id FROM transactions t
          WHERE t."deletedAt" IS NULL AND t."accountUnknown" = false AND NOT EXISTS (
            SELECT 1 FROM transaction_account_allocations al WHERE al."transactionId" = t.id
          )`,
  },
  {
    name: 'Catégorie inconnue ⇒ aucun "categoryId" (transactions / planned / recurring)',
    sql: `SELECT id FROM transactions WHERE "categoryUnknown" = true AND "categoryId" IS NOT NULL
          UNION ALL SELECT id FROM planned_expenses WHERE "categoryUnknown" = true AND "categoryId" IS NOT NULL
          UNION ALL SELECT id FROM recurring_expense_rules WHERE "categoryUnknown" = true AND "categoryId" IS NOT NULL`,
  },
  {
    name: 'Références de catégorie toujours existantes (transactions / planned / recurring)',
    sql: `SELECT 'transaction', t.id FROM transactions t LEFT JOIN categories c ON c.id = t."categoryId"
          WHERE t."categoryId" IS NOT NULL AND c.id IS NULL
          UNION ALL SELECT 'planned', t.id FROM planned_expenses t LEFT JOIN categories c ON c.id = t."categoryId"
          WHERE t."categoryId" IS NOT NULL AND c.id IS NULL
          UNION ALL SELECT 'recurring', t.id FROM recurring_expense_rules t LEFT JOIN categories c ON c.id = t."categoryId"
          WHERE t."categoryId" IS NOT NULL AND c.id IS NULL`,
  },
  {
    name: 'Transfert actif : montant > 0, frais >= 0, source ≠ destination',
    sql: `SELECT id FROM account_transfers
          WHERE "deletedAt" IS NULL AND (amount <= 0 OR "feeAmount" < 0 OR "sourceAccountId" = "destinationAccountId")`,
  },
  {
    name: 'Transfert : source et destination appartiennent à l’utilisateur',
    sql: `SELECT at.id FROM account_transfers at
          JOIN accounts src ON src.id = at."sourceAccountId"
          JOIN accounts dst ON dst.id = at."destinationAccountId"
          WHERE at."userId" <> src."userId" OR at."userId" <> dst."userId"`,
  },
  {
    name: 'Date inconnue cohérente (transfert / règlement / dette)',
    sql: `SELECT 'transfer', id FROM account_transfers WHERE ("dateUnknown" = true AND "occurredAt" IS NOT NULL) OR ("dateUnknown" = false AND "occurredAt" IS NULL)
          UNION ALL SELECT 'settlement', id FROM debt_settlements WHERE ("dateUnknown" = true AND "occurredAt" IS NOT NULL) OR ("dateUnknown" = false AND "occurredAt" IS NULL)
          UNION ALL SELECT 'debt', id FROM debts WHERE ("dueDateUnknown" = true AND "dueDate" IS NOT NULL) OR ("dueDateUnknown" = false AND "dueDate" IS NULL)`,
  },
  {
    name: 'Contribution épargne : transfer lié, destination SAVINGS, même utilisateur',
    sql: `SELECT sc.id, at."userId", p."userId" AS plan_user, a.type AS dest_type
          FROM savings_contributions sc
          JOIN account_transfers at ON at.id = sc."transferId"
          JOIN monthly_savings_plans p ON p.id = sc."savingsPlanId"
          JOIN accounts a ON a.id = at."destinationAccountId"
          WHERE a.type <> 'SAVINGS' OR at."userId" <> p."userId"`,
  },
  {
    name: 'Contribution épargne : aucune référence orpheline',
    sql: `SELECT sc.id FROM savings_contributions sc
          LEFT JOIN monthly_savings_plans p ON p.id = sc."savingsPlanId"
          LEFT JOIN account_transfers at ON at.id = sc."transferId"
          WHERE p.id IS NULL OR at.id IS NULL`,
  },
  {
    name: 'Aucune dette réglée au-delà de son montant initial (règlements actifs)',
    sql: `SELECT d.id, d."originalAmount"::text AS original, coalesce(sum(ds.amount), 0)::text AS settled
          FROM debts d
          LEFT JOIN debt_settlements ds ON ds."debtId" = d.id AND ds."deletedAt" IS NULL
          GROUP BY d.id
          HAVING coalesce(sum(ds.amount), 0) > d."originalAmount"`,
  },
  {
    name: 'Règlement : dette et compte du même utilisateur, montant > 0',
    sql: `SELECT ds.id FROM debt_settlements ds
          JOIN debts d ON d.id = ds."debtId"
          LEFT JOIN accounts a ON a.id = ds."accountId"
          WHERE d."userId" <> ds."userId"
             OR (a.id IS NOT NULL AND a."userId" <> ds."userId")
             OR ds.amount <= 0`,
  },
  {
    name: 'PlannedExpense PAYÉE : transaction de paiement liée, EXPENSE, même utilisateur',
    sql: `SELECT pe.id FROM planned_expenses pe
          LEFT JOIN transactions t ON t.id = pe."confirmedTransactionId"
          WHERE pe.status = 'PAID' AND (t.id IS NULL OR t.type <> 'EXPENSE' OR t."userId" <> pe."userId" OR t."deletedAt" IS NOT NULL)`,
  },
  {
    name: 'PlannedExpense non payée : aucune transaction confirmée',
    sql: `SELECT id FROM planned_expenses WHERE status <> 'PAID' AND "confirmedTransactionId" IS NOT NULL`,
  },
  {
    name: 'ExpectedIncome REÇU : transaction de réception liée, INCOME, même utilisateur',
    sql: `SELECT ei.id FROM expected_incomes ei
          LEFT JOIN transactions t ON t.id = ei."receivedTransactionId"
          WHERE ei.status = 'RECEIVED' AND (t.id IS NULL OR t.type <> 'INCOME' OR t."userId" <> ei."userId" OR t."deletedAt" IS NOT NULL)`,
  },
  {
    name: 'ExpectedIncome non reçu : aucune transaction liée',
    sql: `SELECT id FROM expected_incomes WHERE status <> 'RECEIVED' AND "receivedTransactionId" IS NOT NULL`,
  },
  {
    name: 'Pas de doublon de budget mensuel (global ou par catégorie)',
    sql: `SELECT "userId", month, count(*) AS c FROM monthly_budgets WHERE "categoryId" IS NULL
          GROUP BY "userId", month HAVING count(*) > 1
          UNION ALL SELECT "userId", month, count(*) FROM monthly_budgets WHERE "categoryId" IS NOT NULL
          GROUP BY "userId", month, "categoryId" HAVING count(*) > 1`,
  },
  {
    name: 'Pas de doublon de plan d’épargne actif pour un même mois',
    sql: `SELECT "userId", month, count(*) AS c FROM monthly_savings_plans
          WHERE "deletedAt" IS NULL GROUP BY "userId", month HAVING count(*) > 1`,
  },
  {
    name: 'Notifications : clé de dédup unique (aucun doublon)',
    sql: `SELECT "dedupeKey", count(*) AS c FROM app_notifications GROUP BY "dedupeKey" HAVING count(*) > 1`,
  },
  {
    name: 'Propositions assistant : jamais exécutée ET annulée/expirée simultanément',
    sql: `SELECT id FROM assistant_action_proposals
          WHERE "executedAt" IS NOT NULL AND ("canceledAt" IS NOT NULL OR status = 'CANCELED')`,
  },
];

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? '' });
  try {
    // Session PostgreSQL strictement READ ONLY : toute écriture accidentelle est refusée.
    await pool.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');

    const db = await pool.query('SELECT current_database() AS db');
    console.log(`[db:audit] base lue : ${db.rows[0].db} (session READ ONLY)`);

    let violations = 0;
    for (const check of checks) {
      const result = await pool.query(check.sql);
      const rows = result.rows as Record<string, unknown>[];
      if (rows.length === 0) {
        console.log(`  OK    ${check.name}`);
      } else {
        violations += 1;
        console.log(`  ✗ ${check.name} — ${rows.length} violation(s)`);
        for (const row of rows.slice(0, 3)) {
          console.log(`      ${JSON.stringify(row)}`);
        }
      }
    }

    console.log('---');
    if (violations === 0) {
      console.log(`[db:audit] SUCCÈS : ${checks.length} contrôles, 0 violation.`);
    } else {
      console.log(
        `[db:audit] ÉCHEC : ${violations}/${checks.length} contrôle(s) en échec.`,
      );
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[db:audit] failed:', error);
  process.exitCode = 1;
});
