/**
 * Textes des notifications (étape 12) — fonctions pures.
 *
 * Deux registres distincts :
 *  - CENTRE INTERNE (authentifié) : peut montrer les montants, le détail et
 *    la date — l'utilisateur est devant son écran ;
 *  - PUSH NAVIGATEUR : texte générique PAR DÉFAUT (confidentialité : écran
 *    verrouillé, centre système, salle partagée). Les montants n'apparaissent
 *    qu'avec la préférence EXPLICITE `showAmountsInPush`.
 *
 * Aucune donnée métier n'est dupliquée : les montants sont des SNAPSHOTS de
 * texte d'un rappel (la source reste la vérité).
 */

export type MoneyCurrency = string;

const CURRENCY_SYMBOL: Record<string, string> = {
  MGA: 'Ar',
  EUR: '€',
  CAD: 'CA$',
};

/** 1234567.5 → « 1 234 567,50 » (groupes de milliers, sans flottant). */
export function formatMoneyForText(amount: string, currency: string): string {
  const raw = amount.trim();
  const [integerPart, decimalPart] = raw.includes('.')
    ? raw.split('.')
    : [raw, ''];
  const cleanInteger = (integerPart ?? '').replace(/^0+(?=\d)/, '') || '0';
  const grouped = cleanInteger.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const decimals =
    decimalPart && decimalPart.length > 0
      ? `.${decimalPart.replace(/0+$/, '') || ''}`
      : '';
  const numeric = decimals === '' ? grouped : `${grouped}${decimals}`;
  const symbol = CURRENCY_SYMBOL[currency] ?? currency;
  return `${numeric} ${symbol}`;
}

/** « YYYY-MM-DD » → « 20 sept. 2026 » (texte du centre, locale fr). */
export function formatDateForText(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) {
    return iso;
  }
  const monthName = new Date(Date.UTC(year, month - 1, 1))
    .toLocaleDateString('fr-FR', { month: 'short', timeZone: 'UTC' })
    .replace(/\.$/, '');
  return `${day} ${monthName} ${year}`;
}

// ---------------------------------------------------------------- CENTRE ---

export interface PlannedReminderMeta {
  amount: string;
  currency: string;
  description: string | null;
  dueDate: string;
}

export function plannedCenterTitle(
  type: 'PLANNED_EXPENSE_DUE' | 'PLANNED_EXPENSE_OVERDUE',
): string {
  return type === 'PLANNED_EXPENSE_DUE'
    ? 'Paiement à vérifier'
    : 'Paiement en retard';
}

export function plannedCenterBody(
  type: 'PLANNED_EXPENSE_DUE' | 'PLANNED_EXPENSE_OVERDUE',
  meta: PlannedReminderMeta,
): string {
  const when =
    type === 'PLANNED_EXPENSE_DUE'
      ? `prévue le ${formatDateForText(meta.dueDate)}`
      : `en retard depuis le ${formatDateForText(meta.dueDate)}`;
  const detail = meta.description ? ` — ${meta.description}` : '';
  return `Dépense ${when} : ${formatMoneyForText(meta.amount, meta.currency)}${detail}.`;
}

export interface IncomeReminderMeta {
  amount: string;
  currency: string;
  description: string | null;
  timingLabel: string;
}

export function incomeCenterTitle(
  type:
    | 'EXPECTED_INCOME_DUE'
    | 'EXPECTED_INCOME_WINDOW'
    | 'EXPECTED_INCOME_OVERDUE',
): string {
  if (type === 'EXPECTED_INCOME_DUE') {
    return 'Revenu attendu aujourd’hui';
  }
  if (type === 'EXPECTED_INCOME_WINDOW') {
    return 'Revenu attendu — reçu ?';
  }
  return 'Revenu attendu non confirmé';
}

export function incomeCenterBody(
  type:
    | 'EXPECTED_INCOME_DUE'
    | 'EXPECTED_INCOME_WINDOW'
    | 'EXPECTED_INCOME_OVERDUE',
  meta: IncomeReminderMeta,
): string {
  const lead =
    type === 'EXPECTED_INCOME_DUE'
      ? `Revenu attendu ${meta.timingLabel}`
      : type === 'EXPECTED_INCOME_WINDOW'
        ? `Revenu attendu (${meta.timingLabel}) — l’avez-vous reçu ?`
        : `Revenu attendu (${meta.timingLabel}) — toujours non confirmé`;
  const detail = meta.description ? ` — ${meta.description}` : '';
  return `${lead} : ${formatMoneyForText(meta.amount, meta.currency)}${detail}.`;
}

export type DebtReminderType = 'DEBT_DUE' | 'DEBT_OVERDUE';

export interface DebtReminderMeta {
  /** Montant RESTANT (jamais stocké — calculé au moment du rappel). */
  remaining: string;
  currency: string;
  direction: 'I_OWE' | 'OWED_TO_ME';
  kind: 'STANDARD' | 'INCOME_ADVANCE_RECEIVABLE';
  counterpartyName: string | null;
  dueDate: string;
}

export function debtCenterTitle(
  type: DebtReminderType,
  direction: string,
  kind: string,
): string {
  if (direction === 'OWED_TO_ME' && kind === 'INCOME_ADVANCE_RECEIVABLE') {
    return type === 'DEBT_DUE'
      ? 'Avance sur revenu à recevoir'
      : 'Avance sur revenu en retard';
  }
  const subject = direction === 'I_OWE' ? 'Remboursement' : 'Somme à recevoir';
  return type === 'DEBT_DUE'
    ? `${subject} à vérifier`
    : `${subject} en retard`;
}

export function debtCenterBody(type: DebtReminderType, meta: DebtReminderMeta): string {
  const when =
    type === 'DEBT_DUE'
      ? `échéance le ${formatDateForText(meta.dueDate)}`
      : `échéance dépassée depuis le ${formatDateForText(meta.dueDate)}`;
  const who = meta.counterpartyName ? ` (${meta.counterpartyName})` : '';
  const label =
    meta.direction === 'I_OWE'
      ? 'Reste à rembourser'
      : meta.kind === 'INCOME_ADVANCE_RECEIVABLE'
        ? 'Avance encore due'
        : 'Reste à recevoir';
  return `${label}${who}, ${when} : ${formatMoneyForText(meta.remaining, meta.currency)}.`;
}

// ------------------------------------------------------------------- PUSH ---

/**
 * Texte PUSH par défaut : générique, AUCUN montant, AUCUN nom de personne.
 * Textes affichables sur écran verrouillé / devant d'autres personnes.
 */
export function defaultPushBody(type: string): string {
  switch (type) {
    case 'PLANNED_EXPENSE_DUE':
      return 'Un paiement prévu nécessite votre attention.';
    case 'PLANNED_EXPENSE_OVERDUE':
      return 'Un paiement prévu est en retard.';
    case 'EXPECTED_INCOME_DUE':
    case 'EXPECTED_INCOME_WINDOW':
    case 'EXPECTED_INCOME_OVERDUE':
      return 'Un revenu attendu nécessite votre attention.';
    case 'DEBT_DUE':
      return 'Une échéance de dette nécessite votre attention.';
    case 'DEBT_OVERDUE':
      return 'Une échéance de dette est en retard.';
    default:
      return 'Vos rappels financiers nécessitent votre attention.';
  }
}

/**
 * Texte PUSH enrichi quand `showAmountsInPush` est EXPLICITEMENT activé.
 * Reste concis et sans information excessivement sensible (jamais le nom de
 * la contrepartie, jamais de description longue).
 */
export function detailedPushBody(
  type: string,
  amount: string,
  currency: string,
): string {
  const money = formatMoneyForText(amount, currency);
  switch (type) {
    case 'PLANNED_EXPENSE_DUE':
      return `Paiement prévu : ${money} à vérifier.`;
    case 'PLANNED_EXPENSE_OVERDUE':
      return `Paiement prévu en retard : ${money}.`;
    case 'EXPECTED_INCOME_DUE':
    case 'EXPECTED_INCOME_WINDOW':
    case 'EXPECTED_INCOME_OVERDUE':
      return `Revenu attendu : ${money}.`;
    case 'DEBT_DUE':
      return `Échéance de dette : ${money}.`;
    case 'DEBT_OVERDUE':
      return `Échéance de dette en retard : ${money}.`;
    default:
      return defaultPushBody(type);
  }
}

