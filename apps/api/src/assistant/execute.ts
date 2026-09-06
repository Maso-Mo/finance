import type {
  AssistantAction,
  AssistantExpectedIncomeIntent,
  AssistantTransactionIntent,
  AssistantTransferIntent,
  DebtSettlementCreate,
  ExpectedIncomeConfirmReceived,
  ExpectedIncomeUpsert,
  PlannedExpenseConfirmPaid,
  PlannedExpenseCreate,
  PlannedExpenseUpdate,
  TransactionUpsert,
  TransferUpsert,
} from '@finance/shared-types';
import { ApiError } from '../http-error.js';
import { createTransaction, updateTransaction, deleteTransaction } from '../transactions/transactions.service.js';
import { createTransfer, updateTransfer, deleteTransfer } from '../transfers/transfers.service.js';
import {
  createPlannedExpense,
  updatePlannedExpense,
  confirmPaidPlannedExpense,
  cancelPlannedExpense,
} from '../planned-expenses/planned-expenses.service.js';
import {
  createExpectedIncome,
  updateExpectedIncome,
  cancelExpectedIncome,
  confirmReceivedExpectedIncome,
} from '../expected-incomes/expected-incomes.service.js';
import {
  createMonthlyBudget,
  updateMonthlyBudgetAmount,
  deleteMonthlyBudget,
} from '../budgets/budgets.service.js';
import {
  createSavingsPlan,
  updateSavingsPlan,
  deleteSavingsPlan,
  createSavingsContribution,
} from '../savings/savings.service.js';
import { createDebt, createSettlement, deleteDebt } from '../debts/debts.service.js';
import { resolveAccountId, resolveCategory, userCurrency } from './refs.js';

/**
 * EXÉCUTEURS DÉTERMINISTES (étape 13).
 *
 * Une proposition CONFIRMÉE est TOUJOURS ré-exécutée par ces fonctions qui :
 *  - re-résolvent les références (type de compte → id réel actuel) ;
 *  - re-valident contre l'état DB courant (les services métier existants
 *    refusent toute opération devenue invalide) ;
 *  - n'appellent QUE les services métier de l'application (jamais Prisma en
 *    direct, jamais une ré-implémentation de la finance).
 */

export interface ExecutionOutcome {
  /** Message simple d'après exécution (ex. « Dépense enregistrée. »). */
  message: string;
  resourceType: string | null;
  resourceId: string | null;
}

const DONE_MESSAGES: Record<string, string> = {
  TRANSACTION_CREATE: 'Opération enregistrée.',
  TRANSACTION_UPDATE: 'Opération modifiée.',
  TRANSACTION_DELETE: 'Opération supprimée.',
  TRANSFER_CREATE: 'Transfert enregistré.',
  TRANSFER_UPDATE: 'Transfert modifié.',
  TRANSFER_DELETE: 'Transfert supprimé.',
  PLANNED_EXPENSE_CREATE: 'Dépense planifiée.',
  PLANNED_EXPENSE_UPDATE: 'Dépense planifiée modifiée.',
  PLANNED_EXPENSE_CONFIRM_PAID: 'Dépense confirmée comme payée.',
  PLANNED_EXPENSE_CANCEL: 'Dépense planifiée annulée.',
  EXPECTED_INCOME_CREATE: 'Revenu attendu enregistré.',
  EXPECTED_INCOME_UPDATE: 'Revenu attendu modifié.',
  EXPECTED_INCOME_CONFIRM_RECEIVED: 'Revenu confirmé comme reçu.',
  EXPECTED_INCOME_CANCEL: 'Revenu attendu annulé.',
  BUDGET_CREATE: 'Budget créé.',
  BUDGET_UPDATE: 'Budget modifié.',
  BUDGET_DELETE: 'Budget supprimé.',
  DEBT_CREATE: 'Dette enregistrée.',
  DEBT_SETTLEMENT_CREATE: 'Règlement enregistré.',
  SAVINGS_PLAN_CREATE: 'Plan d’épargne créé.',
  SAVINGS_PLAN_UPDATE: 'Plan d’épargne modifié.',
  SAVINGS_PLAN_DELETE: 'Plan d’épargne supprimé.',
};

export function doneMessageFor(actionType: string): string {
  return DONE_MESSAGES[actionType] ?? 'Action exécutée.';
}

/** Erreur de cohérence interne (proposal devenue incomplète/invalide). */
function incoherent(): ApiError {
  return new ApiError(409, 'Cette proposition n’est plus valide. Merci de reformuler.');
}

async function currencyOf(userId: string): Promise<string | null> {
  return userCurrency(userId);
}

/** Compte requis par l'action (unknown flag exclus déjà par la proposition). */
async function requireAccountId(
  userId: string,
  accountType: string | undefined,
  accountUnknown: boolean | undefined,
): Promise<string> {
  if (accountUnknown === true) {
    throw incoherent();
  }
  if (!accountType) {
    throw incoherent();
  }
  const id = await resolveAccountId(userId, accountType as never);
  if (!id) {
    throw new ApiError(400, `Le compte ${accountType} n’existe pas (ou n’appartient pas à votre espace).`);
  }
  return id;
}

/** Intention transfert → TransferUpsert du service (étape 9). */
async function toTransferUpsert(
  userId: string,
  tr: AssistantTransferIntent,
): Promise<TransferUpsert> {
  const sourceAccountId = await requireAccountId(userId, tr.sourceAccountType, false);
  const destinationAccountId = await requireAccountId(userId, tr.destinationAccountType, false);
  if (sourceAccountId === destinationAccountId) {
    throw new ApiError(400, 'Les comptes source et destination doivent être différents.');
  }
  const input: TransferUpsert = {
    sourceAccountId,
    destinationAccountId,
    amount: tr.amount,
  };
  if (tr.feeAmount !== undefined) input.feeAmount = tr.feeAmount;
  if (tr.description) input.description = tr.description;
  if (tr.dateUnknown === true) {
    input.dateUnknown = true;
  } else if (tr.occurredAt) {
    input.occurredAt = tr.occurredAt;
  } else {
    throw incoherent();
  }
  return input;
}

async function requireCategoryId(
  categoryRef: string | undefined,
  categoryUnknown: boolean | undefined,
): Promise<string | null> {
  if (categoryUnknown === true) {
    return null;
  }
  if (!categoryRef) {
    throw incoherent();
  }
  const resolved = await resolveCategory(categoryRef);
  if (!resolved) {
    throw new ApiError(400, `Catégorie inconnue : ${categoryRef}.`);
  }
  return resolved.id;
}

/** Intention transaction → TransactionUpsert du service journal (étape 5). */
async function toTransactionUpsert(
  userId: string,
  t: AssistantTransactionIntent,
): Promise<TransactionUpsert> {
  const input: TransactionUpsert = { type: t.type, amount: t.amount };
  if (t.description) input.description = t.description;
  if (t.dateUnknown === true) {
    input.dateUnknown = true;
  } else if (t.occurredAt) {
    input.occurredAt = t.occurredAt;
  } else {
    throw incoherent();
  }
  if (t.accountUnknown === true) {
    input.accountUnknown = true;
  } else if (t.accountType) {
    const accountId = await requireAccountId(userId, t.accountType, false);
    input.allocations = [{ accountId, amount: t.amount }];
  } else {
    throw incoherent();
  }
  if (t.type === 'EXPENSE') {
    if (t.categoryUnknown === true) {
      input.categoryUnknown = true;
    } else if (t.categoryRef) {
      const categoryId = await requireCategoryId(t.categoryRef, false);
      if (categoryId) input.categoryId = categoryId;
    } else {
      throw incoherent();
    }
  }
  return input;
}

/** Confirmation « payé » d'une dépense planifiée → corps du service (étape 6). */
async function toPlannedConfirmBody(
  userId: string,
  confirmation: {
    amount: string;
    description?: string;
    occurredAt?: string;
    dateUnknown?: boolean;
    accountType?: string;
    accountUnknown?: boolean;
    categoryRef?: string;
    categoryUnknown?: boolean;
  },
): Promise<PlannedExpenseConfirmPaid> {
  const body: PlannedExpenseConfirmPaid = { amount: confirmation.amount };
  if (confirmation.description) body.description = confirmation.description;
  if (confirmation.dateUnknown === true) {
    body.dateUnknown = true;
  } else if (confirmation.occurredAt) {
    body.occurredAt = confirmation.occurredAt;
  } else {
    throw incoherent();
  }
  if (confirmation.accountUnknown === true) {
    body.accountUnknown = true;
  } else if (confirmation.accountType) {
    const accountId = await requireAccountId(userId, confirmation.accountType, false);
    body.allocations = [{ accountId, amount: confirmation.amount }];
  } else {
    throw incoherent();
  }
  if (confirmation.categoryUnknown === true) {
    body.categoryUnknown = true;
  } else if (confirmation.categoryRef) {
    const categoryId = await requireCategoryId(confirmation.categoryRef, false);
    if (categoryId) body.categoryId = categoryId;
  } else {
    throw incoherent();
  }
  return body;
}

/** Confirmation « reçu » d'un revenu futur → corps du service (étape 7). */
async function toExpectedConfirmBody(
  userId: string,
  confirmation: {
    amount: string;
    description?: string;
    occurredAt?: string;
    dateUnknown?: boolean;
    accountType?: string;
    accountUnknown?: boolean;
  },
): Promise<ExpectedIncomeConfirmReceived> {
  const body: ExpectedIncomeConfirmReceived = { amount: confirmation.amount };
  if (confirmation.description) body.description = confirmation.description;
  if (confirmation.dateUnknown === true) {
    body.dateUnknown = true;
  } else if (confirmation.occurredAt) {
    body.occurredAt = confirmation.occurredAt;
  } else {
    throw incoherent();
  }
  if (confirmation.accountUnknown === true) {
    body.accountUnknown = true;
  } else if (confirmation.accountType) {
    const accountId = await requireAccountId(userId, confirmation.accountType, false);
    body.allocations = [{ accountId, amount: confirmation.amount }];
  } else {
    throw incoherent();
  }
  return body;
}

/** Règlement d'une dette → corps DebtSettlementCreate du service (étape 11). */
async function toDebtSettlementInput(
  userId: string,
  s: {
    amount: string;
    description?: string;
    occurredAt?: string;
    dateUnknown?: boolean;
    accountType?: string;
    accountUnknown?: boolean;
  },
): Promise<DebtSettlementCreate> {
  const input: DebtSettlementCreate = { amount: s.amount };
  if (s.description) input.description = s.description;
  if (s.dateUnknown === true) {
    input.dateUnknown = true;
  } else if (s.occurredAt) {
    input.occurredAt = s.occurredAt;
  } else {
    throw incoherent();
  }
  if (s.accountUnknown === true) {
    input.accountUnknown = true;
  } else if (s.accountType) {
    input.accountId = await requireAccountId(userId, s.accountType, false);
  } else {
    throw incoherent();
  }
  return input;
}

/** Intention revenu futur → ExpectedIncomeUpsert du service (étape 7). */
function toExpectedIncomeUpsert(e: AssistantExpectedIncomeIntent): ExpectedIncomeUpsert {
  const input: ExpectedIncomeUpsert = { amount: e.amount, certainty: e.certainty };
  if (e.description) input.description = e.description;
  if (e.expectedDate) {
    input.expectedDate = e.expectedDate;
  } else if (e.windowStart && e.windowEnd) {
    input.windowStart = e.windowStart;
    input.windowEnd = e.windowEnd;
  } else {
    throw incoherent();
  }
  return input;
}

/**
 * Exécute une action complète confirmée via les services métier existants.
 * Ne JAMAIS appeler directement en dehors du confirm d'une proposition.
 */
export async function executeAction(
  userId: string,
  action: AssistantAction,
): Promise<ExecutionOutcome> {
  const message = doneMessageFor(action.actionType);

  switch (action.actionType) {
    case 'TRANSACTION_CREATE': {
      const input = await toTransactionUpsert(userId, action.transaction);
      const created = await createTransaction(userId, input);
      return { message, resourceType: 'TRANSACTION', resourceId: created.id };
    }
    case 'TRANSACTION_UPDATE': {
      const input = await toTransactionUpsert(userId, action.transaction);
      await updateTransaction(userId, action.transactionId, input);
      return { message, resourceType: 'TRANSACTION', resourceId: action.transactionId };
    }
    case 'TRANSACTION_DELETE': {
      await deleteTransaction(userId, action.transactionId);
      return { message, resourceType: 'TRANSACTION', resourceId: null };
    }
    case 'TRANSFER_CREATE': {
      const tr = action.transfer;
      if (tr.savingsPlanId) {
        if (tr.destinationAccountType !== 'SAVINGS') {
          throw new ApiError(400, 'Une contribution d’épargne doit cibler le compte Épargne.');
        }
        const sourceAccountId = await requireAccountId(userId, tr.sourceAccountType, false);
        const result = await createSavingsContribution(userId, tr.savingsPlanId, {
          sourceAccountId,
          amount: tr.amount,
          feeAmount: tr.feeAmount,
          occurredAt: tr.occurredAt,
          dateUnknown: tr.dateUnknown,
          description: tr.description,
        });
        return { message, resourceType: 'SAVINGS_CONTRIBUTION', resourceId: result.contribution.id };
      }
      const input = await toTransferUpsert(userId, tr);
      const created = await createTransfer(userId, input);
      return { message, resourceType: 'ACCOUNT_TRANSFER', resourceId: created.id };
    }
    case 'TRANSFER_UPDATE': {
      const tr = action.transfer;
      if (tr.savingsPlanId) {
        throw new ApiError(400, 'Le lien avec un plan d’épargne ne se modifie pas ici : annulez puis recréez.');
      }
      const input = await toTransferUpsert(userId, tr);
      await updateTransfer(userId, action.transferId, input);
      return { message, resourceType: 'ACCOUNT_TRANSFER', resourceId: action.transferId };
    }
    case 'TRANSFER_DELETE': {
      await deleteTransfer(userId, action.transferId);
      return { message, resourceType: 'ACCOUNT_TRANSFER', resourceId: null };
    }
    case 'PLANNED_EXPENSE_CREATE': {
      const p = action.plannedExpense;
      const input: PlannedExpenseCreate = { amount: p.amount, dueDate: p.dueDate };
      if (p.description) input.description = p.description;
      if (p.categoryUnknown === true) {
        input.categoryUnknown = true;
      } else if (p.categoryRef) {
        const categoryId = await requireCategoryId(p.categoryRef, false);
        if (categoryId) input.categoryId = categoryId;
      }
      const created = await createPlannedExpense(userId, input);
      return { message, resourceType: 'PLANNED_EXPENSE', resourceId: created.id };
    }
    case 'PLANNED_EXPENSE_UPDATE': {
      const patch = action.patch;
      const input: PlannedExpenseUpdate = {};
      if (patch.amount !== undefined) input.amount = patch.amount;
      if (patch.dueDate !== undefined) input.dueDate = patch.dueDate;
      if (patch.description !== undefined) input.description = patch.description;
      if (patch.categoryUnknown === true) {
        input.categoryUnknown = true;
      } else if (patch.categoryRef) {
        const categoryId = await requireCategoryId(patch.categoryRef, false);
        if (categoryId) input.categoryId = categoryId;
      }
      await updatePlannedExpense(userId, action.plannedExpenseId, input);
      return { message, resourceType: 'PLANNED_EXPENSE', resourceId: action.plannedExpenseId };
    }
    case 'PLANNED_EXPENSE_CONFIRM_PAID': {
      const body = await toPlannedConfirmBody(userId, action.confirmation);
      const result = await confirmPaidPlannedExpense(userId, action.confirmation.plannedExpenseId, body);
      return { message, resourceType: 'PLANNED_EXPENSE', resourceId: result.plannedExpense.id };
    }
    case 'PLANNED_EXPENSE_CANCEL': {
      await cancelPlannedExpense(userId, action.plannedExpenseId);
      return { message, resourceType: 'PLANNED_EXPENSE', resourceId: action.plannedExpenseId };
    }
    case 'EXPECTED_INCOME_CREATE': {
      const input = toExpectedIncomeUpsert(action.expectedIncome);
      const created = await createExpectedIncome(userId, input);
      return { message, resourceType: 'EXPECTED_INCOME', resourceId: created.id };
    }
    case 'EXPECTED_INCOME_UPDATE': {
      const input = toExpectedIncomeUpsert(action.expectedIncome);
      await updateExpectedIncome(userId, action.expectedIncomeId, input);
      return { message, resourceType: 'EXPECTED_INCOME', resourceId: action.expectedIncomeId };
    }
    case 'EXPECTED_INCOME_CONFIRM_RECEIVED': {
      const body = await toExpectedConfirmBody(userId, action.confirmation);
      const result = await confirmReceivedExpectedIncome(userId, action.confirmation.expectedIncomeId, body);
      return { message, resourceType: 'EXPECTED_INCOME', resourceId: result.expectedIncome.id };
    }
    case 'EXPECTED_INCOME_CANCEL': {
      await cancelExpectedIncome(userId, action.expectedIncomeId);
      return { message, resourceType: 'EXPECTED_INCOME', resourceId: action.expectedIncomeId };
    }
    case 'BUDGET_CREATE': {
      const b = action.budget;
      const input: { month: string; amount: string; categoryId?: string } = {
        month: b.month,
        amount: b.amount,
      };
      if (b.categoryRef) {
        const categoryId = await requireCategoryId(b.categoryRef, false);
        if (categoryId) input.categoryId = categoryId;
      }
      const created = await createMonthlyBudget(userId, input);
      return { message, resourceType: 'MONTHLY_BUDGET', resourceId: created.id };
    }
    case 'BUDGET_UPDATE': {
      await updateMonthlyBudgetAmount(userId, action.budgetId, { amount: action.amount });
      return { message, resourceType: 'MONTHLY_BUDGET', resourceId: action.budgetId };
    }
    case 'BUDGET_DELETE': {
      await deleteMonthlyBudget(userId, action.budgetId);
      return { message, resourceType: 'MONTHLY_BUDGET', resourceId: action.budgetId };
    }
    case 'DEBT_CREATE': {
      const d = action.debt;
      const created = await createDebt(userId, {
        direction: d.direction,
        kind: d.kind,
        originalAmount: d.originalAmount,
        counterpartyName: d.counterpartyName,
        description: d.description,
        dueDate: d.dueDate,
        dueDateUnknown: d.dueDateUnknown,
      });
      if (d.initialSettlement) {
        try {
          const settlementInput = await toDebtSettlementInput(userId, d.initialSettlement);
          await createSettlement(userId, created.id, settlementInput);
        } catch (error) {
          await deleteDebt(userId, created.id).catch(() => undefined);
          throw error;
        }
      }
      return { message, resourceType: 'DEBT', resourceId: created.id };
    }
    case 'DEBT_SETTLEMENT_CREATE': {
      const settlementInput = await toDebtSettlementInput(userId, action.settlement);
      await createSettlement(userId, action.settlement.debtId, settlementInput);
      return { message, resourceType: 'DEBT', resourceId: action.settlement.debtId };
    }
    case 'SAVINGS_PLAN_CREATE': {
      const created = await createSavingsPlan(userId, {
        month: action.savingsPlan.month,
        mode: action.savingsPlan.mode,
        fixedAmount: action.savingsPlan.fixedAmount,
        percentage: action.savingsPlan.percentage,
      });
      return { message, resourceType: 'SAVINGS_PLAN', resourceId: created.id };
    }
    case 'SAVINGS_PLAN_UPDATE': {
      await updateSavingsPlan(userId, action.savingsPlanId, {
        month: action.savingsPlan.month,
        mode: action.savingsPlan.mode,
        fixedAmount: action.savingsPlan.fixedAmount,
        percentage: action.savingsPlan.percentage,
      });
      return { message, resourceType: 'SAVINGS_PLAN', resourceId: action.savingsPlanId };
    }
    case 'SAVINGS_PLAN_DELETE': {
      await deleteSavingsPlan(userId, action.savingsPlanId);
      return { message, resourceType: 'SAVINGS_PLAN', resourceId: action.savingsPlanId };
    }
    default:
      throw incoherent();
  }
}

