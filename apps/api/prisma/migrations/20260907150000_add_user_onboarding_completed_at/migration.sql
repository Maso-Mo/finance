-- Additif : état persistant de la prise en main guidée (onboarding).
-- Aucune donnée existante n'est touchée ; la colonne reste NULL tant que
-- l'utilisateur n'a pas explicitement terminé le parcours.
ALTER TABLE "users" ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3);
