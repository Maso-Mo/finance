/**
 * Prise en main guidée — définition des 13 étapes.
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

/** 13 étapes chronologiques — le dernier index est la récapitulation. */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    title: 'Bienvenue dans Finance',
    body: "Votre argent au même endroit. Cette visite guidée de trente secondes vous montre l'essentiel pour démarrer sereinement — vous pouvez la quitter à tout moment et la relancer depuis le menu « Plus ».",
  },
  {
    title: 'Votre tableau de bord',
    target: '#guide-total',
    body: "Tout part d'ici : le Total disponible, les comptes reliés et les soldes dérivés, actualisés à chaque opération enregistrée.",
  },
  {
    title: 'Enregistrer une opération',
    target: '#guide-add',
    body: "Le bouton « Ajouter » ouvre la page Transactions : une dépense ou un revenu se saisit en quelques champs, avec catégorie et compte.",
  },
  {
    title: 'Dépensé ce mois',
    target: '#guide-spent',
    body: "Cette carte cumule vos dépenses réelles du mois. Elle sert de repère : votre budget global est mis à jour dans la foulée.",
  },
  {
    title: 'Budget global',
    target: '#guide-budget',
    body: 'Définissez une limite mensuelle, globale ou par catégorie. La jauge bascule sur la couleur d’alerte si vous la dépassez — un repère, jamais un blocage.',
  },
  {
    title: 'À vérifier',
    target: '#guide-todo',
    body: 'Les dépenses planifiées et revenus attendus arrivent ici quand leur échéance approche : vous confirmez le paiement réel, et seul ce paiement crée une opération.',
  },
  {
    title: 'Vos opérations récentes',
    target: '#guide-recent',
    body: 'Le journal liste chaque mouvement daté et classé par compte. Le détail se corrige à tout moment ; rien n’est définitif.',
  },
  {
    title: 'Analyse de vos finances',
    target: '#guide-analytics',
    body: 'Les graphiques comparent vos revenus et dépenses mois par mois, puis montrent où votre argent est parti ce mois-ci. Lecture seule : aucun calcul ne modifie vos données.',
  },
  {
    title: 'Naviguer',
    target: '[data-guide="nav"]',
    body: 'La colonne de gauche (ou la barre du bas sur mobile) organise votre espace : Mouvements, Planification, Patrimoine. Chaque entrée reste à un clic.',
  },
  {
    title: 'L’assistant',
    target: '[data-guide="assistant"]',
    body: 'L’assistant lit votre journal et propose des actions concrètes, comme sécuriser un mois ou planifier une épargne. Rien n’est appliqué sans votre confirmation.',
  },
  {
    title: 'Notifications',
    target: '[data-guide="bell"]',
    body: 'La cloche rassemble les rappels « Reçu ? / Payé ? », les fins de mois et les alertes utiles, avec un canal choisi pour chaque type de rappel.',
  },
  {
    title: 'Le menu « Plus »',
    target: '[data-guide="plus"]',
    body: 'Sur mobile, « Plus » regroupe transferts, épargne, dettes et notifications. C’est aussi ici que vous retrouverez ce guide après l’avoir terminé.',
  },
  {
    title: 'Et maintenant ?',
    body: "Vous connaissez l'essentiel. Une dernière confirmation et votre progression est sauvegardée : vous pourrez relancer ce guide à tout moment, sans rien défaire.",
  },
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
