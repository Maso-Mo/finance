import type {
  AccountUpdateResponse,
  AuthResponse,
  CategoriesResponse,
  Currency,
  DashboardResponse,
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
  TransactionMutationResponse,
  TransactionsResponse,
  TransactionUpsert,
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

export type { PlannedExpensePublic, RecurringExpensePublic };

