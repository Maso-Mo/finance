import type { TransferCreate, TransferUpdate } from '@finance/shared-types';

/**
 * Construit le payload d'un transfert interne RÉEL (étape 9) côté web.
 *
 * Règles miroirs du contrat partagé (le backend refuse de toute façon) :
 *  - montant crédité sur la destination STRICTEMENT positif (2 décimales max) ;
 *  - frais >= 0 (0 si l'utilisateur n'active pas « Frais ? »), TOUJOURS
 *    prélevés EN PLUS sur la source en V1 ;
 *  - source <> destination (jamais le même compte) ;
 *  - date : occurredAt OU « Je ne sais plus » explicite (jamais aujourd'hui
 *    automatiquement).
 * Aucune validation de balance : le backend calcule tout depuis le journal.
 */

const MONEY_RE = /^\d+(\.\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cents(value: string): bigint | null {
  if (!MONEY_RE.test(value)) return null;
  const [int = '0', frac = ''] = value.split('.');
  return BigInt(int) * 100n + BigInt(frac.padEnd(2, '0'));
}

export function buildTransferPayload(values: {
  sourceAccountId: string;
  destinationAccountId: string;
  amount: string;
  feeEnabled: boolean;
  feeAmount: string;
  date: string;
  dateUnknown: boolean;
  description: string;
}): { payload: TransferCreate | TransferUpdate | null; errors: string[] } {
  const errors: string[] = [];
  const amount = values.amount.trim();
  const amountCents = cents(amount);
  if (!amountCents || amountCents <= 0n) {
    errors.push('Montant invalide (positif, 2 décimales maximum).');
  }
  const fee = values.feeEnabled ? values.feeAmount.trim() : '';
  const feeCents = values.feeEnabled ? cents(fee) : 0n;
  if (values.feeEnabled && (feeCents === null || feeCents < 0n)) {
    errors.push('Montant des frais invalide (0 ou positif, 2 décimales max).');
  }
  if (!values.sourceAccountId || !values.destinationAccountId) {
    errors.push('Choisissez un compte source et un compte de destination.');
  } else if (values.sourceAccountId === values.destinationAccountId) {
    errors.push('Le compte source et le compte de destination doivent être différents.');
  }
  if (!values.dateUnknown && !DATE_RE.test(values.date.trim())) {
    errors.push('Indiquez la date réelle ou cochez « Je ne sais plus ».');
  }
  if (values.dateUnknown && values.date.trim() && DATE_RE.test(values.date.trim())) {
    // Date saisie ET « je ne sais plus » : refuse (contradictoire).
    errors.push('La date ne peut pas être à la fois connue et inconnue.');
  }
  if (errors.length > 0) return { payload: null, errors };

  const payload: TransferCreate | TransferUpdate = {
    sourceAccountId: values.sourceAccountId,
    destinationAccountId: values.destinationAccountId,
    amount,
    feeAmount: values.feeEnabled ? fee : '0',
    dateUnknown: values.dateUnknown,
    ...(values.dateUnknown
      ? {}
      : { occurredAt: values.date.trim() }),
  };
  if (values.description.trim()) payload.description = values.description.trim();
  return { payload, errors };
}
