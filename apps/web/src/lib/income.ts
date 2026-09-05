import type {
  AccountPublic,
  ExpectedIncomeCertainty,
  ExpectedIncomeConfirmReceived,
  ExpectedIncomeCreate,
  ExpectedIncomePublic,
  ExpectedIncomeStatus,
  ExpectedIncomeUpdate,
} from '@finance/shared-types';

const MONEY_RE = /^\d+(\.\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cents(value: string): bigint | null {
  if (!MONEY_RE.test(value)) return null;
  const [int = '0', frac = ''] = value.split('.');
  return BigInt(int) * 100n + BigInt(frac.padEnd(2, '0'));
}

/** Libellés d'affichage (certitude et statut d'un revenu futur). */
export const CERTAINTY_LABELS: Record<ExpectedIncomeCertainty, string> = {
  CONFIRMED: 'Confirmé',
  UNCERTAIN: 'Incertain',
};

export const INCOME_STATUS_LABELS: Record<ExpectedIncomeStatus, string> = {
  PENDING: 'En attente',
  RECEIVED: 'Reçu',
  CANCELED: 'Annulé',
};

export const INCOME_BUCKET_LABELS: Record<
  NonNullable<ExpectedIncomePublic['reminderBucket']>,
  string
> = {
  upcoming: 'À venir',
  dueToday: "Aujourd'hui",
  inWindow: 'Dans la période attendue',
  overdue: 'En retard',
};

/** Forme temporelle d'un revenu futur (exacte OU plage, jamais les deux). */
export function timingOf(item: {
  expectedDate: string | null;
  windowStart: string | null;
  windowEnd: string | null;
}): string {
  if (item.expectedDate) {
    return `le ${item.expectedDate}`;
  }
  if (item.windowStart && item.windowEnd) {
    return `entre le ${item.windowStart} et le ${item.windowEnd}`;
  }
  return 'période indéterminée';
}

/**
 * Payload de création OU de modification d'un revenu futur. Le formulaire
 * n'autorise qu'UNE forme temporelle active : date exacte OU plage. Aucune
 * date « inventée » : une plage reste toujours une plage.
 */
export function buildExpectedIncomePayload(values: {
  amount: string;
  certainty: ExpectedIncomeCertainty;
  description: string;
  dateMode: 'exact' | 'range';
  expectedDate: string;
  windowStart: string;
  windowEnd: string;
}): { payload: ExpectedIncomeCreate | null; errors: string[] } {
  const errors: string[] = [];
  const amount = values.amount.trim();
  const amountCents = cents(amount);
  if (!amountCents || amountCents <= 0n) {
    errors.push('Montant invalide (positif, 2 décimales maximum).');
  }
  if (values.certainty !== 'CONFIRMED' && values.certainty !== 'UNCERTAIN') {
    errors.push('Précisez Confirmé ou Incertain.');
  }
  if (values.dateMode !== 'exact' && values.dateMode !== 'range') {
    errors.push('Choisissez une date exacte ou une période.');
  }

  const exact = values.expectedDate.trim();
  const start = values.windowStart.trim();
  const end = values.windowEnd.trim();
  if (values.dateMode === 'exact') {
    if (!DATE_RE.test(exact)) {
      errors.push('Indiquez une date exacte prévue (YYYY-MM-DD).');
    }
  } else {
    if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
      errors.push('Indiquez le début et la fin de la période (YYYY-MM-DD).');
    } else if (end < start) {
      errors.push('La fin de la période doit suivre son début.');
    }
  }
  if (errors.length > 0) return { payload: null, errors };

  const payload: ExpectedIncomeCreate = {
    amount,
    certainty: values.certainty,
  };
  if (values.description.trim()) payload.description = values.description.trim();
  if (values.dateMode === 'exact') {
    payload.expectedDate = exact;
  } else {
    payload.windowStart = start;
    payload.windowEnd = end;
  }
  return { payload, errors };
}

/** Payload complet pour la modification d'un revenu PENDING (PATCH = plein). */
export function buildExpectedIncomeUpdatePayload(
  values: Parameters<typeof buildExpectedIncomePayload>[0],
): { payload: ExpectedIncomeUpdate | null; errors: string[] } {
  return buildExpectedIncomePayload(values);
}

/**
 * Payload « Oui, je l'ai reçu » : le VRAI revenu (montant/date/comptes réels).
 * Pré-rempli avec l'attendu mais entièrement corrigeable — la répartition
 * multi-comptes doit couvrir exactement le montant réel (ou compte inconnu).
 */
export function buildIncomeReceivedPayload(values: {
  amount: string;
  date: string;
  dateUnknown: boolean;
  accountUnknown: boolean;
  allocations: Record<string, string>;
  description: string;
}, accounts: AccountPublic[]): {
  payload: ExpectedIncomeConfirmReceived | null;
  errors: string[];
} {
  const errors: string[] = [];
  const amount = values.amount.trim();
  const amountCents = cents(amount);
  if (!amountCents || amountCents <= 0n) {
    errors.push('Montant réel invalide (positif, 2 décimales maximum).');
  }
  if (!values.dateUnknown && !DATE_RE.test(values.date.trim())) {
    errors.push('Indiquez la date réelle ou cochez « Je ne sais plus ».');
  }

  const allocationRows: { accountId: string; amount: string }[] = [];
  if (!values.accountUnknown) {
    let allocated = 0n;
    for (const account of accounts) {
      const raw = (values.allocations[account.id] ?? '').trim();
      if (!raw) continue;
      const part = cents(raw);
      if (!part || part <= 0n) {
        errors.push(`Montant invalide pour ${account.type}.`);
        continue;
      }
      allocationRows.push({ accountId: account.id, amount: raw });
      allocated += part;
    }
    if (allocationRows.length === 0) {
      errors.push('Choisissez au moins un compte réel (ou « Compte ? »).');
    } else if (amountCents && allocated !== amountCents) {
      errors.push('La répartition réelle doit couvrir exactement le montant.');
    }
  }
  if (errors.length > 0) return { payload: null, errors };

  const payload: ExpectedIncomeConfirmReceived = { amount };
  if (values.dateUnknown) {
    payload.dateUnknown = true;
  } else {
    payload.occurredAt = values.date.trim();
  }
  if (values.accountUnknown) {
    payload.accountUnknown = true;
  } else {
    payload.allocations = allocationRows;
  }
  if (values.description.trim()) payload.description = values.description.trim();
  return { payload, errors };
}
