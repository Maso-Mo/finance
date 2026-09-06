import Decimal from 'decimal.js';
import {
  SAVINGS_ACCOUNT_TYPE,
  toMoney,
  type Money,
  type MoneyInput,
} from './money.js';

/**
 * TRANSFERTS INTERNES RÉELS (étape 9) — finance-core.
 *
 * ⚠ INVARIANT ABSOLU : un transfert interne n'est NI une Transaction EXPENSE
 * sur le compte source NI une Transaction INCOME sur le compte destination.
 * Un tel doublon fausserait dépenses, revenus, budgets, `spendingForecast`,
 * catégories et statistiques. Un transfert est un MOUVEMENT DÉDIÉ qui
 * n'impacte QUE les soldes courants dérivés des comptes.
 *
 * Règle financière V1 (frais TOUJOURS prélevés EN PLUS sur la source) :
 *  - `amount`     = SOMME CRÉDITÉE sur le compte destination (strictement > 0) ;
 *  - `feeAmount`  = frais, >= 0 (0 = aucun frais) ;
 *  - impact SOURCE      : −(amount + feeAmount) ;
 *  - impact DESTINATION : +amount ;
 *  - le transfert n'est jamais appliqué ailleurs (aucune double écriture).
 *
 * Un transfert supprimé logiquement (`deletedAt` présent) est IGNORÉ :
 * il n'impacte plus aucun solde.
 *
 * Toutes les fonctions sont PURES : sans Prisma, PostgreSQL, Express ni React.
 * Les montants sont des decimal.js exacts (jamais de flottant).
 */

/** Forme minimale d'un transfert pour les calculs purs. */
export interface TransferLike {
  sourceAccountId: string;
  destinationAccountId: string;
  amount: MoneyInput;
  /** 0 (défaut) = aucun frais. */
  feeAmount?: MoneyInput;
  /** Date de suppression logique : si présente, le transfert est ignoré. */
  deletedAt?: unknown;
}

/** Un transfert n'est « actif » que s'il n'est pas supprimé. */
export function isActiveTransfer(
  transfer: { deletedAt?: unknown } | null | undefined,
): boolean {
  return transfer != null && transfer.deletedAt == null;
}

/** Délta porté par le compte SOURCE : −(amount + fee), toujours négatif. */
export function transferSourceDelta(
  amount: MoneyInput,
  feeAmount: MoneyInput = '0',
): Money {
  return toMoney(amount).plus(toMoney(feeAmount)).negated();
}

/** Délta porté par le compte DESTINATION : +amount, toujours positif. */
export function transferDestinationDelta(amount: MoneyInput): Money {
  return toMoney(amount);
}

/**
 * Impact EXACT d'un transfert ACTIF sur un compte donné :
 *  - le compte source  → −(amount + fee) ;
 *  - le compte destination → +amount ;
 *  - tout autre compte → 0.
 * Un transfert supprimé logiquement renvoie toujours 0.
 */
export function transferDeltaForAccount(
  transfer: TransferLike,
  accountId: string,
): Money {
  if (!isActiveTransfer(transfer)) {
    return new Decimal(0);
  }
  if (transfer.sourceAccountId === accountId) {
    return transferSourceDelta(transfer.amount, transfer.feeAmount ?? '0');
  }
  if (transfer.destinationAccountId === accountId) {
    return transferDestinationDelta(transfer.amount);
  }
  return new Decimal(0);
}

/** Σ des deltas des transferts ACTIFS qui concernent le compte `accountId`. */
export function netTransferFlow(
  transfers: readonly TransferLike[],
  accountId: string,
): Money {
  return transfers.reduce<Money>(
    (total, transfer) =>
      total.plus(transferDeltaForAccount(transfer, accountId)),
    new Decimal(0),
  );
}

/**
 * Effet net DÉJÀ AGRÉGÉ EN BASE (stratégie groupBy, sans charger tout
 * l'historique) pour UN compte : crédits reçus − débits sortis, où le débit
 * sorti inclut déjà les frais (amount + fee). `sourceTotalDebited` = 0 pour un
 * compte purement destinataire ; `destinationTotalCredited` = 0 pour un compte
 * purement source. Une même requête peut produire les deux si le compte est
 * à la fois source ET destination de transferts différents.
 */
export function transferNetFromTotals(
  sourceTotalDebited: MoneyInput,
  destinationTotalCredited: MoneyInput,
): Money {
  return toMoney(destinationTotalCredited).minus(toMoney(sourceTotalDebited));
}

/**
 * Solde courant complet d'un compte (dérivé, jamais stocké) :
 *   initialBalance + flux journal (revenus − dépenses) + ajustements
 *   + flux net des transferts actifs (source −(amount+fee), destination
 *   +amount).
 * `transfers` doit contenir les transferts ACTIFS concernant le compte (ou
 * l'ensemble des transferts de l'utilisateur : la fonction filtre elle-même
 * par `accountId`).
 */
export function currentBalanceWithTransfers(
  startingBalance: MoneyInput,
  transactionFlow: MoneyInput,
  adjustments: MoneyInput,
  transfers: readonly TransferLike[],
  accountId: string,
): Money {
  return toMoney(startingBalance)
    .plus(toMoney(transactionFlow))
    .plus(toMoney(adjustments))
    .plus(netTransferFlow(transfers, accountId));
}

/**
 * Impact d'un transfert sur le « Total disponible » (Épargne EXCLUE) —
 * fonction pure partagée (web + api + mobile), jamais recalculée en dur dans
 * un composant React. Types attendus : 'BANK' | 'MVOLA' | 'ORANGE_MONEY' |
 * 'AIRTEL_MONEY' | 'CASH' | 'SAVINGS'.
 *
 * Quatre scénarios (règle de la somme disponible = les 5 comptes hors
 * Épargne) :
 *  - disponible → disponible sans frais : 0 (simple déplacement interne) ;
 *  - disponible → disponible avec frais  : −fee (les frais quittent le total) ;
 *  - disponible → Épargne                : −amount (et −fee si présent) : cet
 *    argent quitte volontairement le disponible (il n'a pas disparu, il est
 *    épargné) ;
 *  - Épargne → disponible                : +amount (les frais, s'il y en a,
 *    restent prélevés sur l'Épargne et ne touchent donc PAS le total
 *    disponible — le patrimoine global perd néanmoins le fee).
 */
export function availableBalanceImpactOfTransfer(
  amount: MoneyInput,
  feeAmount: MoneyInput,
  sourceType: string,
  destinationType: string,
): Money {
  const value = toMoney(amount);
  const fee = toMoney(feeAmount);
  const sourceIsSavings = sourceType === SAVINGS_ACCOUNT_TYPE;
  const destinationIsSavings = destinationType === SAVINGS_ACCOUNT_TYPE;

  if (sourceIsSavings && destinationIsSavings) {
    // Impossible en V1 (un seul compte Épargne) : aucune création/destruction.
    return new Decimal(0);
  }
  if (sourceIsSavings) {
    // L'argent entre dans le disponible ; le fee est prélevé sur l'Épargne.
    return value;
  }
  if (destinationIsSavings) {
    // L'argent quitte le disponible ; le fee est aussi prélevé sur la source.
    return value.plus(fee).negated();
  }
  // Disponible → disponible : seul le fee sort du total disponible.
  return fee.negated();
}
