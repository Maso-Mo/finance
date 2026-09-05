import type {
  AccountPublic,
  PlannedExpenseConfirmPaid,
  PlannedExpenseCreate,
  RecurringExpenseCreate,
} from '@finance/shared-types';

const MONEY_RE = /^\d+(\.\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cents(value: string): bigint | null {
  if (!MONEY_RE.test(value)) return null;
  const [int = '0', frac = ''] = value.split('.');
  return BigInt(int) * 100n + BigInt(frac.padEnd(2, '0'));
}

/** Payload d'une dépense FUTURE ponctuelle (aucun compte). */
export function buildPlannedExpensePayload(values: {
  amount: string;
  dueDate: string;
  categoryId: string;
  categoryUnknown: boolean;
  description: string;
}): { payload: PlannedExpenseCreate | null; errors: string[] } {
  const errors: string[] = [];
  const amount = values.amount.trim();
  if (!MONEY_RE.test(amount) || amount === '0') {
    errors.push('Montant invalide (positif, 2 décimales maximum).');
  }
  if (!DATE_RE.test(values.dueDate.trim())) {
    errors.push('Indiquez une date prévue (YYYY-MM-DD).');
  }
  if (values.categoryUnknown && values.categoryId) {
    errors.push('La catégorie ne peut pas être à la fois connue et inconnue.');
  }
  if (!values.categoryUnknown && !values.categoryId) {
    errors.push('Choisissez une catégorie ou « Je ne sais pas encore ».');
  }
  if (errors.length > 0) return { payload: null, errors };
  const payload: PlannedExpenseCreate = {
    amount,
    dueDate: values.dueDate.trim(),
    ...(values.categoryUnknown
      ? { categoryUnknown: true }
      : { categoryId: values.categoryId }),
  };
  if (values.description.trim()) payload.description = values.description.trim();
  return { payload, errors };
}

/** Payload d'une règle mensuelle (V1 : jour 1..31, clampé en fin de mois). */
export function buildRecurringExpensePayload(values: {
  amount: string;
  dayOfMonth: string;
  startDate: string;
  endDate: string;
  categoryId: string;
  categoryUnknown: boolean;
  description: string;
}): { payload: RecurringExpenseCreate | null; errors: string[] } {
  const errors: string[] = [];
  const amount = values.amount.trim();
  if (!MONEY_RE.test(amount) || amount === '0') {
    errors.push('Montant invalide (positif, 2 décimales maximum).');
  }
  const day = Number(values.dayOfMonth);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    errors.push('Jour du mois invalide (1 à 31).');
  }
  if (!DATE_RE.test(values.startDate.trim())) {
    errors.push('Indiquez une date de début (YYYY-MM-DD).');
  }
  if (values.endDate.trim() && !DATE_RE.test(values.endDate.trim())) {
    errors.push('Date de fin invalide (YYYY-MM-DD).');
  }
  if (values.endDate.trim() && values.startDate.trim() && values.endDate.trim() < values.startDate.trim()) {
    errors.push('La date de fin doit suivre la date de début.');
  }
  if (values.categoryUnknown && values.categoryId) {
    errors.push('La catégorie ne peut pas être à la fois connue et inconnue.');
  }
  if (!values.categoryUnknown && !values.categoryId) {
    errors.push('Choisissez une catégorie ou « Je ne sais pas encore ».');
  }
  if (errors.length > 0) return { payload: null, errors };
  const payload: RecurringExpenseCreate = {
    amount,
    dayOfMonth: day,
    startDate: values.startDate.trim(),
    ...(values.categoryUnknown
      ? { categoryUnknown: true }
      : { categoryId: values.categoryId }),
  };
  if (values.description.trim()) payload.description = values.description.trim();
  if (values.endDate.trim()) payload.endDate = values.endDate.trim();
  return { payload, errors };
}

/** Payload « Oui, payé » : la VRAIE dépense (montant/date/comptes réels). */
export function buildConfirmPaidPayload(values: {
  amount: string;
  date: string;
  dateUnknown: boolean;
  accountUnknown: boolean;
  allocations: Record<string, string>;
  categoryId: string;
  categoryUnknown: boolean;
  description: string;
}, accounts: AccountPublic[]): {
  payload: PlannedExpenseConfirmPaid | null;
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
  if (values.categoryUnknown && values.categoryId) {
    errors.push('La catégorie ne peut pas être à la fois connue et inconnue.');
  }
  if (!values.categoryUnknown && !values.categoryId) {
    errors.push('Choisissez une catégorie ou « Je ne sais plus ».');
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
  const payload: PlannedExpenseConfirmPaid = { amount };
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
  if (values.categoryUnknown) {
    payload.categoryUnknown = true;
  } else {
    payload.categoryId = values.categoryId;
  }
  if (values.description.trim()) payload.description = values.description.trim();
  return { payload, errors };
}
