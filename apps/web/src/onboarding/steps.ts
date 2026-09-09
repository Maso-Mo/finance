/**
 * Prise en main guidée — définition des 14 étapes.
 *
 * Chaque étape peut pointer un élément réel de l'interface (sélecteur CSS).
 * Le tour encadre cet élément quand il est présent et visible ; sinon il
 * affiche une carte simple (aucune étape ne bloque jamais l'application).
 *
 * Règle produit : quitter (X) ou sauter le guide ne persiste RIEN. Seul le
 * bouton « J'ai compris » + confirmation « Terminer » appelle le POST côté
 * serveur (voir Tour.tsx).
 */

export interface OnboardingStep {
  /** Titre court affiché dans la carte. */
  title: string;
  /** Explication d'une ou deux phrases, ton positif et concret. */
  body: string;
  /**
   * Sélecteur CSS de l'élément à encadrer (facultatif). S'il est absent ou
   * introuvable, la carte s'affiche sans anneau de surbrillance.
   */
  target?: string;
}

/** 14 étapes chronologiques — le dernier index est la récapitulation. */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    "title": "Total disponible",
    "target": "#guide-total",
    "body": "Le total réunit Banque, MVola, Orange Money, Airtel Money et Cash. L’épargne reste à part."
  },
  {
    "title": "Détails comptes",
    "target": "#guide-details",
    "body": "Ouvre les détails pour consulter le solde de chaque compte et déclarer un solde réel."
  },
  {
    "title": "Transactions",
    "target": "a[href=\"/transactions\"]",
    "body": "Enregistre tes revenus et dépenses réels, avec leur date, leur catégorie et le compte concerné."
  },
  {
    "title": "Graphiques",
    "target": "#guide-analytics",
    "body": "Compare revenus et dépenses sur six mois et consulte la répartition des dépenses du mois."
  },
  {
    "title": "Dépenses planifiées",
    "target": "a[href=\"/planned\"]",
    "body": "Prépare les dépenses à venir. Seule la confirmation d’un paiement réel crée une opération."
  },
  {
    "title": "Revenus attendus",
    "target": "a[href=\"/expected\"]",
    "body": "Prévois les rentrées à venir puis confirme leur réception réelle."
  },
  {
    "title": "Budget",
    "target": "#guide-budget",
    "body": "Suis tes dépenses par rapport à ta limite mensuelle, globale ou par catégorie."
  },
  {
    "title": "Prévision",
    "target": "#guide-forecast",
    "body": "Consulte une estimation du disponible en fin de mois, selon les mouvements et échéances connus."
  },
  {
    "title": "Transferts",
    "target": "a[href=\"/transfers\"]",
    "body": "Déplace de l’argent entre tes comptes sans créer un revenu ou une dépense."
  },
  {
    "title": "Épargne",
    "target": "a[href=\"/savings\"]",
    "body": "Suis tes objectifs et tes contributions réelles vers le compte Épargne."
  },
  {
    "title": "Dettes",
    "target": "a[href=\"/debts\"]",
    "body": "Retrouve ce que tu dois et ce qu’on te doit, puis enregistre les remboursements réels."
  },
  {
    "title": "Notifications",
    "target": "[data-guide=\"bell\"]",
    "body": "Retrouve les rappels utiles. Une notification ne confirme jamais une opération à ta place."
  },
  {
    "title": "Assistant",
    "target": "a[href=\"/assistant\"]",
    "body": "L’assistant propose des actions ; tu les vérifies et les confirmes avant leur application."
  },
  {
    "title": "Comptabilité",
    "target": "a[href=\"/accounting\"]",
    "body": "Cette vue te permet de contrôler l'ensemble de tes mouvements, de vérifier tes soldes et de comprendre le résultat de chaque période sans modifier les règles financières de Finance."
  }
];

/** Synthèse affichée sur l'étape de récapitulation (avant confirmation). */
export const ONBOARDING_RECAP = [
  'Ajoutez vos revenus et dépenses au fil de l’eau.',
  'Suivez le budget du mois et vos objectifs d’épargne.',
  'Confirmez les paiements planifiés quand ils arrivent.',
  'Lisez l’analyse revenus/dépenses pour décider.',
  'L’assistant propose, vous confirmez toujours.',
];

export const ONBOARDING_TOTAL = ONBOARDING_STEPS.length;
