import type {
  AccountLedgerResponse,
  AccountUpdateResponse,
  AuthResponse,
  Currency,
  DashboardResponse,
  PublicUser,
  TransactionCreate,
  TransactionCreatedResponse,
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

export async function apiUpdateInitialBalance(
  accountId: string,
  initialBalance: string,
): Promise<AccountUpdateResponse> {
  return request<AccountUpdateResponse>(`/accounts/${accountId}`, {
    method: 'PATCH',
    body: { initialBalance },
  });
}

export async function apiSetCurrency(currency: Currency): Promise<void> {
  await request<void>('/me/preferences', {
    method: 'PATCH',
    body: { currency },
  });
}

// --- Journal de transactions d'un compte ---

/** Journal complet d'un compte : compte (solde dérivé) + opérations + totaux. */
export async function apiGetAccountLedger(
  accountId: string,
): Promise<AccountLedgerResponse> {
  return request<AccountLedgerResponse>(
    `/accounts/${accountId}/transactions`,
  );
}

/** Enregistre une dépense ou un revenu sur le compte (dépense/revenu). */
export async function apiCreateTransaction(
  accountId: string,
  input: TransactionCreate,
): Promise<TransactionCreatedResponse> {
  return request<TransactionCreatedResponse>(
    `/accounts/${accountId}/transactions`,
    { method: 'POST', body: input },
  );
}

/** Supprime une opération (correction d'une saisie erronée). */
export async function apiDeleteTransaction(
  accountId: string,
  transactionId: string,
): Promise<void> {
  await request<void>(`/accounts/${accountId}/transactions/${transactionId}`, {
    method: 'DELETE',
  });
}
