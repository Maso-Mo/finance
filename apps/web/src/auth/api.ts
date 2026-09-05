import type {
  AccountUpdateResponse,
  AuthResponse,
  CategoriesResponse,
  Currency,
  DashboardResponse,
  PublicUser,
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
