import type {
  AccountUpdateResponse,
  AnalyticsOverviewResponse,
  AuthResponse,
  CategoriesResponse,
  Currency,
  DashboardResponse,
  DebtCreate,
  DebtMutationResponse,
  DebtPublic,
  DebtSettlementCreate,
  DebtSettlementMutationResponse,
  DebtSettlementUpdate,
  DebtsResponse,
  DebtUpdate,
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
  NotificationPreferencePatch,
  NotificationPreferencePublic,
  NotificationReadResponse,
  NotificationsListResponse,
  OnboardingCompleteResponse,
  OnboardingGetResponse,
  PlannedExpenseConfirmPaid,
  PlannedExpenseConfirmPaidResponse,
  PlannedExpenseCreate,
  PlannedExpenseMutationResponse,
  PlannedExpensePublic,
  PlannedExpensesResponse,
  PlannedExpenseUpdate,
  PublicUser,
  PushConfig,
  PushSubscriptionCreate,
  PushSubscriptionPublic,
  ReadAllNotificationsResponse,
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
  AssistantStatus,
  AssistantMessageResponse,
  AssistantProposalPublic,
  AssistantProposalConfirmResponse,
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

// --- Dettes et créances (étape 11) ---

/**
 * Toutes les dettes ACTIVES (« je dois » + « on me doit »), avec le restant
 * TOUJOURS dérivé et l'historique des règlements partiels. Read-only.
 */
export async function apiGetDebts(): Promise<DebtsResponse> {
  return request<DebtsResponse>('/debts');
}

/** Crée une dette/créance. Aucun impact comptable à la création. */
export async function apiCreateDebt(
  input: DebtCreate,
): Promise<DebtMutationResponse> {
  return request<DebtMutationResponse>('/debts', {
    method: 'POST',
    body: input,
  });
}

/** Modifie une dette active (montant, nom, échéance…). */
export async function apiUpdateDebt(
  debtId: string,
  input: DebtUpdate,
): Promise<DebtMutationResponse> {
  return request<DebtMutationResponse>(`/debts/${debtId}`, {
    method: 'PATCH',
    body: input,
  });
}

/** Supprime logiquement une dette : elle disparaît des vues. */
export async function apiDeleteDebt(debtId: string): Promise<void> {
  await request<void>(`/debts/${debtId}`, { method: 'DELETE' });
}

/**
 * Enregistre un règlement partiel/total réellement effectué. STANDARD :
 * n'impacte QUE le solde du compte (jamais une Transaction EXPENSE/INCOME).
 * Si la dette est une « avance » (OWED_TO_ME), la Transaction INCOME réelle
 * est créée atomiquement par le backend.
 */
export async function apiAddDebtSettlement(
  debtId: string,
  input: DebtSettlementCreate,
): Promise<DebtSettlementMutationResponse> {
  return request<DebtSettlementMutationResponse>(
    `/debts/${debtId}/settlements`,
    { method: 'POST', body: input },
  );
}

/** Corrige un règlement (montant, compte, date) — soldes recalculés. */
export async function apiUpdateDebtSettlement(
  debtId: string,
  settlementId: string,
  input: DebtSettlementUpdate,
): Promise<DebtSettlementMutationResponse> {
  return request<DebtSettlementMutationResponse>(
    `/debts/${debtId}/settlements/${settlementId}`,
    { method: 'PATCH', body: input },
  );
}

/** Annule logiquement un règlement : son impact comptable disparaît. */
export async function apiDeleteDebtSettlement(
  debtId: string,
  settlementId: string,
): Promise<void> {
  await request<void>(`/debts/${debtId}/settlements/${settlementId}`, {
    method: 'DELETE',
  });
}

// --- Notifications (étape 12) ----------------------------------------------

export interface GetNotificationsQuery {
  page?: number;
  limit?: number;
  unreadOnly?: boolean;
}

/** GET /notifications — centre interne paginé (read-only). */
export async function apiGetNotifications(
  query: GetNotificationsQuery = {},
): Promise<NotificationsListResponse> {
  const params = new URLSearchParams();
  if (query.page) params.set('page', String(query.page));
  if (query.limit) params.set('limit', String(query.limit));
  if (query.unreadOnly) params.set('unreadOnly', 'true');
  const qs = params.toString();
  return request<NotificationsListResponse>(
    `/notifications${qs ? `?${qs}` : ''}`,
  );
}

/** PATCH /notifications/:id/read — lu du centre uniquement. */
export async function apiMarkNotificationRead(
  notificationId: string,
): Promise<NotificationReadResponse> {
  return request<NotificationReadResponse>(
    `/notifications/${notificationId}/read`,
    { method: 'PATCH' },
  );
}

/** POST /notifications/read-all — tout marquer comme lu (centre). */
export async function apiReadAllNotifications(): Promise<ReadAllNotificationsResponse> {
  return request<ReadAllNotificationsResponse>('/notifications/read-all', {
    method: 'POST',
  });
}

/** GET /notification-preferences (read-only strict). */
export async function apiGetNotificationPreferences(): Promise<NotificationPreferencePublic> {
  return request<NotificationPreferencePublic>('/notification-preferences');
}

/** PATCH /notification-preferences (mutation EXPLICITE utilisateur). */
export async function apiUpdateNotificationPreferences(
  patch: NotificationPreferencePatch,
): Promise<NotificationPreferencePublic> {
  return request<NotificationPreferencePublic>('/notification-preferences', {
    method: 'PATCH',
    body: patch,
  });
}

/** GET /notifications/push-config — jamais de clé privée. */
export async function apiGetPushConfig(): Promise<PushConfig> {
  return request<PushConfig>('/notifications/push-config');
}

/** GET /push-subscriptions — appareils de l'utilisateur (aucune clé). */
export async function apiGetPushSubscriptions(): Promise<{
  subscriptions: PushSubscriptionPublic[];
}> {
  return request<{ subscriptions: PushSubscriptionPublic[] }>(
    '/push-subscriptions',
  );
}

/** POST /push-subscriptions — enregistre le PushSubscription navigateur. */
export async function apiCreatePushSubscription(
  input: PushSubscriptionCreate,
): Promise<{ subscription: PushSubscriptionPublic }> {
  return request<{ subscription: PushSubscriptionPublic }>(
    '/push-subscriptions',
    { method: 'POST', body: input },
  );
}

/** DELETE /push-subscriptions/:id — désactivation logique (own device). */
export async function apiDeletePushSubscription(
  subscriptionId: string,
): Promise<void> {
  await request<void>(`/push-subscriptions/${subscriptionId}`, {
    method: 'DELETE',
  });
}

// --- Assistant IA (étape 13) ----------------------------------------------

export interface AssistantMessageInput {
  message: string;
  draftId?: string;
  timezone?: string;
  localDate: string;
}

/** GET /assistant/status — public (available:false si non configuré). */
export async function apiGetAssistantStatus(): Promise<AssistantStatus> {
  return request<AssistantStatus>('/assistant/status');
}

/** POST /assistant/message — un tour (ne crée que Draft/Proposal). */
export async function apiSendAssistantMessage(
  input: AssistantMessageInput,
): Promise<AssistantMessageResponse> {
  return request<AssistantMessageResponse>('/assistant/message', {
    method: 'POST',
    body: input,
  });
}

/** POST /assistant/proposals/:id/confirm — exécution après confirmation. */
export async function apiConfirmAssistantProposal(
  proposalId: string,
): Promise<AssistantProposalConfirmResponse> {
  return request<AssistantProposalConfirmResponse>(
    `/assistant/proposals/${proposalId}/confirm`,
    { method: 'POST', body: {} },
  );
}

/** POST /assistant/proposals/:id/cancel — aucune donnée financière modifiée. */
export async function apiCancelAssistantProposal(
  proposalId: string,
): Promise<{ proposal: AssistantProposalPublic }> {
  return request<{ proposal: AssistantProposalPublic }>(
    `/assistant/proposals/${proposalId}/cancel`,
    { method: 'POST', body: {} },
  );
}

// --- Prise en main guidée (onboarding, étape 13) ---

/** Statut de la prise en main (lecture seule, ne modifie aucune donnée). */
export async function apiGetOnboarding(): Promise<OnboardingGetResponse> {
  return request<OnboardingGetResponse>('/me/onboarding');
}

/**
 * Termine la prise en main : le POST est idempotent et ne touche AUCUNE
 * donnée financière (il mémorise seulement la date de fin côté serveur).
 */
export async function apiCompleteOnboarding(): Promise<OnboardingCompleteResponse> {
  return request<OnboardingCompleteResponse>('/me/onboarding/complete', {
    method: 'POST',
  });
}

// --- Analytique lecture-seule (tableau de bord) ---

/**
 * Vue d'ensemble read-only : flux mensuels revenus/dépenses (`months`
 * points, 1–12) + dépenses du mois courant par catégorie. `today`
 * (YYYY-MM-DD) permet de tester de façon déterministe ; sans lui, le
 * serveur utilise la date du jour. Aucune écriture côté API.
 */
export async function apiGetAnalyticsOverview(
  months = 6,
  today?: string,
): Promise<AnalyticsOverviewResponse> {
  const params = new URLSearchParams({ months: String(months) });
  if (today) {
    params.set('today', today);
  }
  return request<AnalyticsOverviewResponse>(`/analytics/overview?${params.toString()}`);
}

export type {
  ExpectedIncomePublic,
  PlannedExpensePublic,
  RecurringExpensePublic,
  DebtPublic,
};


