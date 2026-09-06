-- La FK savings_contributions.transferId → account_transfers est ajoutée ICI,
-- APRÈS la création de account_transfers (migration précédente 12:00), afin que
-- l'installation FROM SCRATCH (ordre lexicographique) réussisse.
--
-- IDEMPOTENT : les bases historiques (finance_dev / finance_test) ont déjà
-- cette contrainte (créée par l'ancienne migration 10:50) ; le DO block n'ajoute
-- rien pour elles. Vérifie uniquement l'existence par nom de contrainte.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'savings_contributions_transferId_fkey'
  ) THEN
    ALTER TABLE "savings_contributions"
      ADD CONSTRAINT "savings_contributions_transferId_fkey"
      FOREIGN KEY ("transferId") REFERENCES "account_transfers"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
