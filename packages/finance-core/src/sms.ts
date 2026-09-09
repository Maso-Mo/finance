/**
 * Parsing SMS « mobile money » — finance-core (socle PUR, aucune I/O).
 * V1 : fondation d'une future ingestion SMS. Fonctions pures et
 * déterministes : même message → même résultat, sans LLM, sans réseau,
 * sans effet de bord, sans base de données.
 *
 * SÉMANTIQUE : un SMS décrit un ÉVÉNEMENT TECHNIQUE, pas un mouvement
 * comptable. MONEY_RECEIVED ≠ INCOME, MONEY_SENT ≠ EXPENSE,
 * CASH_DEPOSIT ≠ INCOME, CASH_WITHDRAWAL ≠ EXPENSE. Un SMS reste un
 * CANDIDAT à confirmer humainement ; on n'invente jamais une valeur
 * (champ absent = null). `occurredAt` n'est proposé que si une date est
 * lisible dans le corps ; `receivedAt` (métadonnée de réception) reste
 * séparé. `confidence` = force des indices (high/medium/low).
 */

/** Opérateur « mobile money » reconnu (expéditeur normalisé). */
export type MobileMoneyProvider = 'MVOLA' | 'ORANGE_MONEY' | 'AIRTEL_MONEY';

/** Événement TECHNIQUE décrit par le SMS (jamais une écriture comptable). */
export type SmsEventType =
  | 'MONEY_RECEIVED'
  | 'MONEY_SENT'
  | 'CASH_WITHDRAWAL'
  | 'CASH_DEPOSIT'
  | 'PAYMENT'
  | 'UNKNOWN';

export type SmsConfidence = 'high' | 'medium' | 'low';

/** Forme minimale d'un message entrant (source : relais mobile futur). */
export interface SmsMessageInput {
  sender: string;
  body: string;
  /** Reçu à (ISO). Métadonnée — JAMAIS une date d'occurrence. */
  receivedAt?: string;
}

/** Résultat de parsing d'un SMS (candidat technique, jamais une écriture). */
export interface ParsedSms {
  provider: MobileMoneyProvider | null;
  type: SmsEventType;
  /** Montant en chaîne décimale exacte (« 100000.00 »), ou null. */
  amount: string | null;
  /** Frais explicitement lus (« Frais : … »), ou null. */
  fee: string | null;
  /** Solde après opération explicitement lu, ou null. */
  balanceAfter: string | null;
  /** Nom de la contrepartie lisible, ou null. */
  counterpartyName: string | null;
  /** Numéro de la contrepartie lisible, ou null. */
  counterpartyNumber: string | null;
  /** Référence de transaction (« Ref … »), ou null. */
  reference: string | null;
  /** Lieu de l'opération si réellement lisible, sinon null. */
  location: string | null;
  /** Date du JOUR lisible dans le corps (« YYYY-MM-DD »), ou null. */
  occurredAt: string | null;
  /** Force des indices détectés. */
  confidence: SmsConfidence;
  /** Métadonnée de réception (séparée de la date du message). */
  receivedAt: string | null;
  sender: string;
  raw: string;
}

const PROVIDER_PATTERNS: { provider: MobileMoneyProvider; needles: string[] }[] = [
  { provider: 'MVOLA', needles: ['MVOLA'] },
  { provider: 'ORANGE_MONEY', needles: ['ORANGE'] },
  { provider: 'AIRTEL_MONEY', needles: ['AIRTEL'] },
];

/** Expéditeur → opérateur (normalisation naïve, sans ambiguïté). */
export function providerFromSender(sender: string): MobileMoneyProvider | null {
  const normalized = sender.toUpperCase();
  for (const { provider, needles } of PROVIDER_PATTERNS) {
    if (needles.some((needle) => normalized.includes(needle))) {
      return provider;
    }
  }
  return null;
}

/** Clé de déduplication stable (espace/casse normalisés). */
export function smsDedupeKey(sender: string, body: string): string {
  return `sms|${sender.toUpperCase()}|${body.replace(/\s+/g, ' ').trim().toUpperCase()}`;
}

/** Normalise un texte (minuscules, accents retirés). */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Normalise un candidat numérique en chaîne décimale exacte. Le DERNIER
 * séparateur (« . » ou « , ») est la décimale (1-2 chiffres) ; les autres
 * séparateurs sont des milliers et sont retirés.
 */
export function normalizeAmountCandidate(raw: string): string | null {
  const clean = raw.replace(/\s/g, '');
  if (!/^\d+(?:[.,]\d+)*$/.test(clean)) return null;
  const comma = clean.lastIndexOf(',');
  const dot = clean.lastIndexOf('.');
  if (comma === -1 && dot === -1) {
    return clean.length >= 3 ? `${clean}.00` : null;
  }
  const sep = comma > dot ? ',' : '.';
  const sepAt = comma > dot ? comma : dot;
  const frac = clean.slice(sepAt + 1);
  if (frac.length === 0 || frac.length > 2) return null;
  const intPart = clean.slice(0, sepAt).replace(/[.,]/g, '');
  if (!/^\d+$/.test(intPart) || !/^\d+$/.test(frac)) return null;
  return `${intPart}.${frac.padStart(2, '0')}`;
}

/** Première valeur monétaire crédible du corps, ou null. */
export function extractSmsAmount(body: string): string | null {
  const sliceAround = (at: number, before: number, after: number) =>
    body.slice(Math.max(0, at - before), at + after);
  const units = ['ar', 'mga', 'ariary'];
  const spots: number[] = [];
  for (const unit of units) {
    let at = -1;
    for (;;) {
      at = body.toLowerCase().indexOf(unit, at + 1);
      if (at === -1) break;
      spots.push(at);
    }
  }
  const windows = spots.length > 0 ? spots : [body.length];
  const requiresFraction = spots.length === 0;
  for (const spot of windows) {
    const win = spots.length > 0 ? sliceAround(spot, 60, 60) : body;
    const numbers = win.match(/[0-9]+(?:[ .,][0-9]+)*/g);
    if (!numbers) continue;
    for (const raw of numbers) {
      const hasDecimal = /[.,]\d{1,2}$/.test(raw.replace(/\s/g, ''));
      const tooShort = raw.replace(/[^0-9]/g, '').length < 3 && !hasDecimal;
      if (tooShort || (requiresFraction && !hasDecimal)) continue;
      const normalized = normalizeAmountCandidate(raw);
      if (normalized) return normalized;
    }
  }
  return null;
}

/** Date « 25/12/2026 » ou « 2026-12-25 » dans le corps → « YYYY-MM-DD ». */
export function extractSmsDate(body: string): string | null {
  const dmy = body.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (dmy) {
    const [, day, month, year] = dmy;
    const dd = day!.padStart(2, '0');
    const mm = month!.padStart(2, '0');
    if (Number(month) > 12 || Number(day) > 31) return null;
    return `${year}-${mm}-${dd}`;
  }
  const iso = body.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  return iso ? iso[0] : null;
}

/** Montant situé APRÈS un libellé (« Frais : 250,00 Ar »), ou null. */
function amountAfterLabel(body: string, label: string): string | null {
  const index = body.toLowerCase().indexOf(label);
  if (index === -1) return null;
  const after = body.slice(index + label.length, index + label.length + 60);
  return extractSmsAmount(after);
}

/** Frais explicitement lus (« frais »/« fee »), ou null. */
export function extractSmsFee(body: string): string | null {
  return amountAfterLabel(body, 'frais') ?? amountAfterLabel(body, 'fee');
}

/** Solde après opération (« solde »/« balance »), ou null. */
export function extractSmsBalanceAfter(body: string): string | null {
  return amountAfterLabel(body, 'solde') ?? amountAfterLabel(body, 'balance');
}

/** Nom de contrepartie (« de/vers/à/from/to <nom> »), ou null. */
export function extractCounterpartyName(body: string): string | null {
  const match = body.match(
    /(?:de|vers|\ba\b|from|to)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .'-]{2,40})/i,
  );
  if (!match) return null;
  const rawName = match[1] ?? '';
  const name = rawName.trim();
  if (/^\d/.test(name)) return null; // c'est un numéro, pas un nom
  return name;
}

/** Numéro de contrepartie (0… / +261…, 9 à 11 chiffres), ou null. */
export function extractCounterpartyNumber(body: string): string | null {
  const match = body.match(/(?:0\d{9}|\+261\d{9})/);
  return match ? match[0] : null;
}

/** Référence (« Ref 1234 / Reference : ABC »), ou null. */
export function extractSmsReference(body: string): string | null {
  const match = body.match(
    /ref(?:erence)?\.?\s*:?\s*([0-9A-Za-z-]{4,20})/i,
  );
  return match?.[1] ?? null;
}

/** Lieu réellement lisible (agence/guichet/distributeur…), sinon null. */
export function extractSmsLocation(body: string): string | null {
  const match = body.match(
    /(?:agence|guichet|distributeur|boutique|chez)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ '-]{2,40})/i,
  );
  return match?.[1]?.trim() ?? null;
}

// --- Classification de l'ÉVÉNEMENT TECHNIQUE (jamais comptable) ---
// Chaque liste opère sur le corps normalisé (minuscules, accents retirés).
// L'ordre est choisi du plus spécifique au plus général : un retrait/dépôt
// agent ou un paiement marchand prime sur un simple MONEY_SENT/RECEIVED.

const WITHDRAWAL_MARKERS = [
  'retrait',
  'retire',
  'retirer',
  'cash out',
  'withdrawal',
  'distributeur',
];

const DEPOSIT_MARKERS = [
  'depot',
  'depose',
  'deposer',
  'cash in',
  'versement especes',
  'versement en especes',
];

const PAYMENT_MARKERS = [
  'paiement',
  'paye',
  'payer',
  'achat',
  'facture',
  'payment',
  'marche',
  'boutique',
];

const RECEIVED_MARKERS = [
  'vous avez recu',
  'vous avez ete credite',
  'a recu',
  'reception',
  'credit de',
  'received',
  'credited',
];

const SENT_MARKERS = [
  'vous avez envoye',
  'a envoye',
  'envoye a',
  'debit de',
  'transfert a',
  'vous avez transfere',
  'sent',
  'debited',
];

/** Marqueurs génériques (debit/credit seuls) → confiance moyenne. */
const GENERIC_DEBIT_MARKERS = ['debit', 'debite', 'sortie'];
const GENERIC_CREDIT_MARKERS = ['credit', 'credite', 'entree'];

/**
 * Classe l'événement technique décrit par un SMS. Retourne UNIQUEMENT le type
 * et la confiance : aucune classification comptable (income/expense) ici.
 */
function classifySmsEvent(
  normalized: string,
): { type: SmsEventType; confidence: SmsConfidence } {
  const has = (markers: string[]) =>
    markers.some((marker) => normalized.includes(marker));

  const explicitEvent = (markers: string[]) =>
    markers.some((marker) => normalized.includes(marker));

  if (explicitEvent(WITHDRAWAL_MARKERS)) {
    return { type: 'CASH_WITHDRAWAL', confidence: 'high' };
  }
  if (explicitEvent(DEPOSIT_MARKERS)) {
    return { type: 'CASH_DEPOSIT', confidence: 'high' };
  }
  if (explicitEvent(PAYMENT_MARKERS)) {
    return { type: 'PAYMENT', confidence: 'high' };
  }
  const received = has(RECEIVED_MARKERS);
  const sent = has(SENT_MARKERS);
  if (received && !sent) {
    return { type: 'MONEY_RECEIVED', confidence: 'high' };
  }
  if (sent && !received) {
    return { type: 'MONEY_SENT', confidence: 'high' };
  }
  if (received && sent) {
    // Direction contradictoire : on ne devine pas.
    return { type: 'UNKNOWN', confidence: 'low' };
  }
  const genericDebit = has(GENERIC_DEBIT_MARKERS);
  const genericCredit = has(GENERIC_CREDIT_MARKERS);
  if (genericCredit && !genericDebit) {
    return { type: 'MONEY_RECEIVED', confidence: 'medium' };
  }
  if (genericDebit && !genericCredit) {
    return { type: 'MONEY_SENT', confidence: 'medium' };
  }
  return { type: 'UNKNOWN', confidence: 'low' };
}

/**
 * Parse un SMS « mobile money » de façon PURE et déterministe.
 *
 * Retourne toujours un objet `ParsedSms` (jamais d'exception) : les champs non
 * reconnus sont null et `type` vaut UNKNOWN dès que l'événement est ambigu.
 * Aucune classification comptable automatique (income/expense) n'est émise.
 */
export function parseMoneySms(message: SmsMessageInput): ParsedSms {
  const provider = providerFromSender(message.sender);
  const body = message.body;
  const normalized = normalize(body);
  const amount = extractSmsAmount(body);
  const { type, confidence } = classifySmsEvent(normalized);
  const occurredAt = extractSmsDate(body);

  return {
    provider,
    type,
    amount,
    fee: extractSmsFee(body),
    balanceAfter: extractSmsBalanceAfter(body),
    counterpartyName: extractCounterpartyName(body),
    counterpartyNumber: extractCounterpartyNumber(body),
    reference: extractSmsReference(body),
    location: extractSmsLocation(body),
    occurredAt,
    confidence,
    receivedAt: message.receivedAt ?? null,
    sender: message.sender,
    raw: body,
  };
}


