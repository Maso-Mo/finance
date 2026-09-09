/**
 * Parsing SMS « mobile money » — finance-core (socle PUR, aucune I/O).
 *
 * V1 volontairement restreinte : ce module pose la FONDATION d'un futur
 * ingestion par SMS (MVola / Orange Money / Airtel Money). Il ne contient
 * QUE des fonctions pures et déterministes : même message → même résultat,
 * sans LLM, sans réseau, sans effet de bord.
 *
 * Règles de prudence (aucune fausse écriture financière) :
 *  - on ne crée JAMAIS de Transaction à partir d'un SMS : ce module produit
 *    un candidat SÛR (`kind` INCOME/EXPENSE) ou `null`/UNKNOWN ; la décision
 *    d'enregistrer reste toujours humaine et passe par les services existants ;
 *  - un montant reconnu doit être explicite ; un SMS ambigu reste UNKNOWN ;
 *  - l'horodatage du message (`receivedAt`) n'est JAMAIS utilisé comme date
 *    d'occurrence : seule une date lisible dans le corps est proposée, et
 *    l'utilisateur peut toujours la corriger (« je ne sais plus »).
 */

/** Opérateur « mobile money » reconnu (sender normalisé). */
export type MobileMoneyProvider = 'MVOLA' | 'ORANGE_MONEY' | 'AIRTEL_MONEY';

/** Sens proposé d'un SMS (jamais écrit en base directement). */
export type SmsParseKind = 'INCOME' | 'EXPENSE' | 'UNKNOWN';

/** Forme minimale d'un message entrant (source : relais mobile futur). */
export interface SmsMessageInput {
  /** Expéditeur tel que reçu (ex. « MVOLA », « ORANGE », « Airtel Money »). */
  sender: string;
  /** Corps du message, tel que reçu. */
  body: string;
  /** Reçu à (ISO). N'est PAS une date d'occurrence. */
  receivedAt?: string;
}

/** Résultat de parsing d'un SMS (candidat, jamais une écriture). */
export interface ParsedSms {
  provider: MobileMoneyProvider | null;
  kind: SmsParseKind;
  /** Montant en chaîne décimale exacte (« 100000.00 »), ou null. */
  amount: string | null;
  /** Frais éventuels explicitement lus, ou null. */
  feeAmount: string | null;
  /** Contrepartie / bénéficiaire lisible, ou null. */
  counterparty: string | null;
  /** Référence de transaction (ex. « Ref 1234 »), ou null. */
  reference: string | null;
  /** Date du JOUR lisible dans le corps (« YYYY-MM-DD »), ou null. */
  occurredAt: string | null;
  /** Expéditeur d'origine (pour l'audit et les tests). */
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

/** « Déjà-vu » du corps normalisé : clé stable pour dédupliquer les SMS. */
export function smsDedupeKey(sender: string, body: string): string {
  return `sms|${sender.toUpperCase()}|${body.replace(/\s+/g, ' ').trim().toUpperCase()}`;
}

/** Normalise un texte (minuscules, accents retirés) pour les tests de mots. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const INCOME_MARKERS = [
  'credit',
  'credite',
  'recu',
  'reception',
  'vous avez recu',
  'depot',
  'versement',
  'salaire',
  'paiement recu',
  'transfert recu',
];

const EXPENSE_MARKERS = [
  'debit',
  'debite',
  'paiement',
  'retrait',
  'achat',
  'facture',
  'envoye',
  'transfert envoye',
  'vous avez envoye',
];

/** Montant « … 1 000,00 Ar / MGA 1,000.00 / 10 000 Ar … » → décimal exact. */
export function extractSmsAmount(body: string): string | null {
  // Fenêtres autour d'une devise explicite (Ar/MGA/Ariary/EUR/€) : un nombre
  // adjacent à la devise est un montant quasi certain, même sans décimale.
  const currencySpots: string[] = [];
  const currencyRe = /(?:Ar|MGA|Ariary|ariary|EUR|€)/g;
  let spot: RegExpExecArray | null;
  while ((spot = currencyRe.exec(body)) !== null) {
    const at = spot.index;
    currencySpots.push(body.slice(Math.max(0, at - 60), at + 60));
  }
  const windows = currencySpots.length > 0 ? currencySpots : [body];
  const requiresFraction = currencySpots.length === 0;
  for (const window of windows) {
    const numbers = window.match(/[0-9]+(?:[ .,][0-9]+)*/g);
    if (!numbers) continue;
    for (const raw of numbers) {
      const hasDecimal = /[.,]\d{1,2}$/.test(raw.replace(/\s/g, ''));
      const tooShort = (raw.replace(/[^0-9]/g, '').length < 3) && !hasDecimal;
      if (tooShort || (requiresFraction && !hasDecimal)) continue;
      const normalized = normalizeAmountCandidate(raw);
      if (normalized) return normalized;
    }
  }
  return null;
}

/**
 * Normalise un candidat numérique en chaîne décimale exacte.
 * Règle : le DERNIER séparateur (« . » ou « , ») est la décimale (1 à 2
 * chiffres) ; les autres séparateurs sont des milliers et sont retirés.
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
  if (iso) return iso[0];
  return null;
}

/**
 * Parse un SMS « mobile money » de façon PURE et déterministe.
 *
 * Retourne toujours un objet `ParsedSms` (jamais d'exception) : les champs non
 * reconnus sont null et `kind` vaut UNKNOWN dès que la direction est ambiguë.
 */
export function parseMoneySms(message: SmsMessageInput): ParsedSms {
  const provider = providerFromSender(message.sender);
  const body = message.body;
  const normalized = normalize(body);
  const amount = extractSmsAmount(body);
  const occurredAt = extractSmsDate(body);

  let kind: SmsParseKind = 'UNKNOWN';
  if (amount) {
    const incomeHit = INCOME_MARKERS.some((marker) => normalized.includes(marker));
    const expenseHit = EXPENSE_MARKERS.some((marker) => normalized.includes(marker));
    if (incomeHit && !expenseHit) {
      kind = 'INCOME';
    } else if (expenseHit && !incomeHit) {
      kind = 'EXPENSE';
    }
  }

  const counterpartyMatch = body.match(
    /(?:de|vers|a|from|to)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .'-]{2,40})/i,
  );
  const referenceMatch = body.match(
    /ref(?:erence)?\.?\s*:?\s*([0-9A-Za-z-]{4,20})/i,
  );

  return {
    provider,
    kind,
    amount,
    feeAmount: null,
    counterparty: counterpartyMatch?.[1]?.trim() ?? null,
    reference: referenceMatch?.[1] ?? null,
    occurredAt,
    sender: message.sender,
    raw: body,
  };
}
