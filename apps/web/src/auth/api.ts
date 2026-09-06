import type {
  AccountUpdateResponse,
  AuthResponse,
  CategoriesResponse,
  Currency,
  DashboardResponse,
  ExpectedIncomeConfirmReceived,
  ExpectedIncomeConfirmReceivedResponse,
  ExpectedIncomeCreate,
  ExpectedIncomeMutationResponse,
  ExpectedIncomePublic,
  ExpectedIncomesResponse,
  ExpectedIncomeUpdate,
  FinancialForecastResponse,
  IncomeRemindersResponse,
  MonthlyBudgetCreate,
  MonthlyBudgetMutationResponse,
  MonthlyBudgetsResponse,
  PlannedExpenseConfirmPaid,
  PlannedExpenseConfirmPaidResponse,
  PlannedExpenseCreate,
  PlannedExpenseMutationResponse,
  PlannedExpensePublic,
  PlannedExpensesResponse,
  PlannedExpenseUpdate,
  PublicUser,
  RecurringExpenseCreate,
  RecurringExpenseMutationResponse,
  RecurringExpensePublic,
  RecurringExpenseUpdate,
  RecurringExpensesResponse,
  RemindersResponse,
  SavingsContributionCreate,
  SavingsContributionMutationResponse,
  SavingsMonthView,
  SavingsPlanCreate,
  SavingsPlanMutationResponse,
  SavingsPlanUpdate,
  TransactionMutationResponse,
  TransactionsResponse,
  TransactionUpsert,
  TransferCreate,
  TransferMutationResponse,
  TransfersResponse,
  TransferUpdate,
} from '@finance/shared-types';

/**
 * Client API minimal pour l'authentification.
 *
 * L'access token est conservé UNIQUEMENT en mémoire (variable module, jamais
 * localStorage/sessionStorage/cookie). Une actualisation le perd : la
 * restauration passe par /auth/refresh (cookie HttpOnly) au chargement.
 */

const API_BASE: string = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    // Nécessaire pour que le navigateur envoie le cookie refresh (HttpOnly).
    credentials: 'include',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 204) {
    return undefined as T;
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // corps non JSON (rare) : on ignore.
  }

  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed with status ${res.status}.`;
    throw new ApiError(res.status, message);
  }

  return body as T;
}

function toUser(auth: AuthResponse): PublicUser {
  return auth.user;
}

export async function apiRegister(
  email: string,
  password: string,
): Promise<PublicUser> {
  const result = await request<AuthResponse>('/auth/register', {
    method: 'POST',
    body: { email, password },
  });
  setAccessToken(result.accessToken);
  return toUser(result);
}

export async function apiLogin(
  email: string,
  password: string,
): Promise<PublicUser> {
  const result = await request<AuthResponse>('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  setAccessToken(result.accessToken);
  return toUser(result);
}

let refreshInFlight: Promise<PublicUser> | null = null;

async function doRefresh(): Promise<PublicUser> {
  const result = await request<AuthResponse>('/auth/refresh', {
    method: 'POST',
  });
  setAccessToken(result.accessToken);
  return toUser(result);
}

/**
 * Restauration silencieuse : échange le refresh cookie contre un access token.
 * Dédupliqué (une seule requête même en StrictMode / double montage), pour
 * éviter une double rotation du refresh token.
 */
export function apiRefresh(): Promise<PublicUser> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export async function apiMe(): Promise<PublicUser> {
  const result = await request<{ user: PublicUser }>('/auth/me');
  return result.user;
}

export async function apiLogout(): Promise<void> {
  await request<void>('/auth/logout', { method: 'POST' });
  setAccessToken(null);
}

// --- Comptes financiers ---

export async function apiGetAccounts(): Promise<DashboardResponse> {
  return request<DashboardResponse>('/accounts');
}

/** « Je veux que le solde connu devienne targetBalance » (backend décide). */
export async function apiSetTargetBalance(
  accountId: string,
  targetBalance: string,
): Promise<AccountUpdateResponse> {
  return request<AccountUpdateResponse>(`/accounts/${accountId}`, {
    method: 'PATCH',
    body: { targetBalance },
  });
}

export async function apiSetCurrency(currency: Currency): Promise<void> {
  await request<void>('/me/preferences', {
    method: 'PATCH',
    body: { currency },
  });
}

// --- Catégories système ---

export async function apiGetCategories(): Promise<CategoriesResponse> {
  return request<CategoriesResponse>('/categories');
}

// --- Journal GLOBAL de transactions ---

/** Historique global paginé (transactions actives uniquement). */
export async function apiGetTransactions(
  page = 1,
  limit = 20,
): Promise<TransactionsResponse> {
  return request<TransactionsResponse>(
    `/transactions?page=${page}&limit=${limit}`,
  );
}

/** Crée une dépense ou un revenu (allocations multi-comptes possibles). */
export async function apiCreateTransaction(
  input: TransactionUpsert,
): Promise<TransactionMutationResponse> {
  return request<TransactionMutationResponse>('/transactions', {
    method: 'POST',
    body: input,
  });
}

/** Modifie une transaction (remplacement atomique complet). */
export async function apiUpdateTransaction(
  transactionId: string,
  input: TransactionUpsert,
): Promise<TransactionMutationResponse> {
  return request<TransactionMutationResponse>(
    `/transactions/${transactionId}`,
    { method: 'PATCH', body: input },
  );
}

/** Supprime logiquement une transaction (disparaît de l’historique). */
export async function apiDeleteTransaction(
  transactionId: string,
): Promise<void> {
  await request<void>(`/transactions/${transactionId}`, {
    method: 'DELETE',
  });
}

// --- Dépenses futures planifiées (étape 6) ---

/** Toutes les dépenses futures (PENDING + résolues), bucket dérivé. */
export async function apiGetPlannedExpenses(
  today?: string,
): Promise<PlannedExpensesResponse> {
  const query = today ? `?today=${today}` : '';
  return request<PlannedExpensesResponse>(`/planned-expenses${query}`);
}

/** Crée une dépense future ponctuelle (PENDING : aucun impact sur les soldes). */
export async function apiCreatePlannedExpense(
  input: PlannedExpenseCreate,
): Promise<PlannedExpenseMutationResponse> {
  return request<PlannedExpenseMutationResponse>('/planned-expenses', {
    method: 'POST',
    body: input,
  });
}

/** Modifie une dépense planifiée encore PENDING. */
export async function apiUpdatePlannedExpense(
  plannedExpenseId: string,
  input: PlannedExpenseUpdate,
): Promise<PlannedExpenseMutationResponse> {
  return request<PlannedExpenseMutationResponse>(
    `/planned-expenses/${plannedExpenseId}`,
    { method: 'PATCH', body: input },
  );
}

/** Annule (ponctuelle → CANCELED) ou ignore (occurrence → SKIPPED). */
export async function apiCancelPlannedExpense(
  plannedExpenseId: string,
): Promise<PlannedExpenseMutationResponse> {
  return request<PlannedExpenseMutationResponse>(
    `/planned-expenses/${plannedExpenseId}`,
    { method: 'DELETE' },
  );
}

/** « Oui, payé » : crée la vraie Transaction EXPENSE (atomique). */
export async function apiConfirmPlannedExpensePaid(
  plannedExpenseId: string,
  input: PlannedExpenseConfirmPaid,
): Promise<PlannedExpenseConfirmPaidResponse> {
  return request<PlannedExpenseConfirmPaidResponse>(
    `/planned-expenses/${plannedExpenseId}/confirm-paid`,
    { method: 'POST', body: input },
  );
}

/** « Pas encore » = aucune écriture. Ignorer CETTE occurrence récurrente. */
export async function apiSkipPlannedExpense(
  plannedExpenseId: string,
): Promise<PlannedExpenseMutationResponse> {
  return request<PlannedExpenseMutationResponse>(
    `/planned-expenses/${plannedExpenseId}/skip`,
    { method: 'POST' },
  );
}

// --- Dépenses mensuelles récurrentes (étape 6) ---

export async function apiGetRecurringExpenses(): Promise<RecurringExpensesResponse> {
  return request<RecurringExpensesResponse>('/recurring-expenses');
}

export async function apiCreateRecurringExpense(
  input: RecurringExpenseCreate,
): Promise<RecurringExpenseMutationResponse> {
  return request<RecurringExpenseMutationResponse>('/recurring-expenses', {
    method: 'POST',
    body: input,
  });
}

export async function apiUpdateRecurringExpense(
  ruleId: string,
  input: Partial<RecurringExpenseUpdate>,
): Promise<RecurringExpenseMutationResponse> {
  return request<RecurringExpenseMutationResponse>(
    `/recurring-expenses/${ruleId}`,
    { method: 'PATCH', body: input },
  );
}

export async function apiDeleteRecurringExpense(ruleId: string): Promise<void> {
  await request<void>(`/recurring-expenses/${ruleId}`, { method: 'DELETE' });
}

// --- Rappels internes « Payé ? » (read-only) ---

/** today = jour local du navigateur (YYYY-MM-DD). */
export async function apiGetReminders(
  today: string,
): Promise<RemindersResponse> {
  return request<RemindersResponse>(`/reminders?today=${today}`);
}

// --- Revenus futurs (étape 7) ---

/** Tous les revenus futurs de l'utilisateur (PENDING + résolus), bucket dérivé. */
export async function apiGetExpectedIncomes(
  today: string,
): Promise<ExpectedIncomesResponse> {
  return request<ExpectedIncomesResponse>(`/expected-incomes?today=${today}`);
}

/** Crée un revenu futur PENDING (CONFIRMED/UNCERTAIN, date exacte ou plage). */
export async function apiCreateExpectedIncome(
  input: ExpectedIncomeCreate,
): Promise<ExpectedIncomeMutationResponse> {
  return request<ExpectedIncomeMutationResponse>('/expected-incomes', {
    method: 'POST',
    body: input,
  });
}

/** Modifie un revenu futur encore PENDING. */
export async function apiUpdateExpectedIncome(
  expectedIncomeId: string,
  input: ExpectedIncomeUpdate,
): Promise<ExpectedIncomeMutationResponse> {
  return request<ExpectedIncomeMutationResponse>(
    `/expected-incomes/${expectedIncomeId}`,
    { method: 'PATCH', body: input },
  );
}

/** Annule un revenu futur PENDING (CANCELED). */
export async function apiCancelExpectedIncome(
  expectedIncomeId: string,
): Promise<ExpectedIncomeMutationResponse> {
  return request<ExpectedIncomeMutationResponse>(
    `/expected-incomes/${expectedIncomeId}`,
    { method: 'DELETE' },
  );
}

/** « Oui, je l'ai reçu » : crée la vraie Transaction INCOME (atomique). */
export async function apiConfirmExpectedIncomeReceived(
  expectedIncomeId: string,
  input: ExpectedIncomeConfirmReceived,
): Promise<ExpectedIncomeConfirmReceivedResponse> {
  return request<ExpectedIncomeConfirmReceivedResponse>(
    `/expected-incomes/${expectedIncomeId}/confirm-received`,
    { method: 'POST', body: input },
  );
}

/** Rappels « Reçu ? » (read-only) : today = jour local (YYYY-MM-DD). */
export async function apiGetIncomeReminders(
  today: string,
): Promise<IncomeRemindersResponse> {
  return request<IncomeRemindersResponse>(`/income-reminders?today=${today}`);
}

// --- Budgets mensuels (étape 8) ---

/** Vue analytique read-only d'un mois : budgets + dépensé + restant + statut + prévision. */
export async function apiGetBudgets(
  month: string,
  today: string,
): Promise<MonthlyBudgetsResponse> {
  return request<MonthlyBudgetsResponse>(`/budgets?month=${month}&today=${today}`);
}

/** Crée un budget global (sans categoryId) ou par catégorie. */
export async function apiCreateBudget(
  input: MonthlyBudgetCreate,
): Promise<MonthlyBudgetMutationResponse> {
  return request<MonthlyBudgetMutationResponse>('/budgets', {
    method: 'POST',
    body: input,
  });
}

/** Modifie la LIMITE d'un budget (jamais une Transaction). */
export async function apiUpdateBudget(
  budgetId: string,
  amount: string,
): Promise<MonthlyBudgetMutationResponse> {
  return request<MonthlyBudgetMutationResponse>(`/budgets/${budgetId}`, {
    method: 'PATCH',
    body: { amount },
  });
}

/** Supprime un budget (aucune Transaction supprimée). */
export async function apiDeleteBudget(budgetId: string): Promise<void> {
  await request<void>(`/budgets/${budgetId}`, { method: 'DELETE' });
}

// --- Prévision financière de fin de mois (correctif 8.1) ---

/**
 * Prévision FINANCIÈRE du MOIS COURANT (mois contenant `today`), read-only.
 * À distinguer de `apiGetBudgets().spendingForecast` (projection des dépenses) :
 * ce bloc calcule la prévision de solde disponible en fin de mois
 * (disponible actuel − dépenses planifiées restantes + revenus confirmés
 * attendus). Les revenus incertains restent séparés (`uncertainIncomePotential`).
 */
export async function apiGetForecast(
  today: string,
): Promise<FinancialForecastResponse> {
  return request<FinancialForecastResponse>(`/forecast?today=${today}`);
}

// --- Transferts internes réels (étape 9) ---

/**
 * Historique paginé des transferts ACTIFS de l'utilisateur. STRICTEMENT
 * read-only côté API : aucun transfert n'est créé par un GET.
 */
export async function apiGetTransfers(
  page = 1,
  limit = 20,
): Promise<TransfersResponse> {
  return request<TransfersResponse>(`/transfers?page=${page}&limit=${limit}`);
}

/**
 * Enregistre un transfert RÉEL déjà effectué entre deux comptes de
 * l'utilisateur. Aucune Transaction EXPENSE/INCOME n'est créée : seul le
 * solde courant dérivé des comptes en tient compte.
 */
export async function apiCreateTransfer(
  input: TransferCreate,
): Promise<TransferMutationResponse> {
  return request<TransferMutationResponse>('/transfers', {
    method: 'POST',
    body: input,
  });
}

/** Modifie un transfert existant (remplacement atomique complet). */
export async function apiUpdateTransfer(
  transferId: string,
  input: TransferUpdate,
): Promise<TransferMutationResponse> {
  return request<TransferMutationResponse>(`/transfers/${transferId}`, {
    method: 'PATCH',
    body: input,
  });
}

/** Supprime logiquement un transfert (deletedAt) : les soldes reviennent. */
export async function apiDeleteTransfer(transferId: string): Promise<void> {
  await request<void>(`/transfers/${transferId}`, { method: 'DELETE' });
}

// --- Plans d'épargne mensuels + contributions (étape 10) ---

/**
 * Vue analytique read-only d'un mois : plan ACTIF éventuel + cible et
 * contribution DÉRIVÉES + solde réel du compte Épargne. Le GET est
 * strictement sans effet de bord (aucun transfert créé).
 */
export async function apiGetSavingsMonth(
  month: string,
): Promise<SavingsMonthView> {
  return request<SavingsMonthView>(`/savings-plans?month=${month}`);
}

/** Crée un plan d'épargne ACTIF (FIXED ou PERCENTAGE). Jamais de l'argent. */
export async function apiCreateSavingsPlan(
  input: SavingsPlanCreate,
): Promise<SavingsPlanMutationResponse> {
  return request<SavingsPlanMutationResponse>('/savings-plans', {
    method: 'POST',
    body: input,
  });
}

/** Modifie un plan ACTIF (mode + cible). Les Transfers réels sont intouchés. */
export async function apiUpdateSavingsPlan(
  planId: string,
  input: SavingsPlanUpdate,
): Promise<SavingsPlanMutationResponse> {
  return request<SavingsPlanMutationResponse>(`/savings-plans/${planId}`, {
    method: 'PATCH',
    body: input,
  });
}

/** Supprime logiquement un plan : ses Transfers réels restent (argent épargné). */
export async function apiDeleteSavingsPlan(planId: string): Promise<void> {
  await request<void>(`/savings-plans/${planId}`, { method: 'DELETE' });
}

/**
 * Enregistre une contribution RÉELLE : crée l'AccountTransfer vers SAVINGS et
 * le lie au plan (atomique côté backend). Aucune Transaction EXPENSE/INCOME.
 */
export async function apiAddSavingsContribution(
  planId: string,
  input: SavingsContributionCreate,
): Promise<SavingsContributionMutationResponse> {
  return request<SavingsContributionMutationResponse>(
    `/savings-plans/${planId}/contributions`,
    { method: 'POST', body: input },
  );
}

export type {
  ExpectedIncomePublic,
  PlannedExpensePublic,
  RecurringExpensePublic,
};


