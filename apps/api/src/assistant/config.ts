/**
 * Configuration de l'assistant IA (étape 13).
 *
 * Aucune clé ne transite vers le frontend et aucune clé n'est loggée. Le mode
 * dégradé est la valeur par défaut : sans `AI_*` l'application financière
 * continue de fonctionner normalement et `GET /assistant/status` renvoie
 * `{ available: false }`.
 */
export const assistantConfig = {
  baseUrl: process.env.AI_BASE_URL ?? '',
  apiKey: process.env.AI_API_KEY ?? '',
  model: process.env.AI_MODEL ?? '',
  // Nombre maximal d'appels d'outils read-only par requête (anti-boucle).
  maxToolCalls: 4,
  // Timeout d'un appel fournisseur (provider panne ⇒ erreur propre, jamais
  // de blocage de l'API générale, aucune retry infinie).
  timeoutMs: Math.max(1000, Number(process.env.AI_TIMEOUT_MS ?? 30_000)),
  // Durée de vie d'un brouillon de clarification.
  draftTtlMinutes: 60,
  // Durée de vie d'une proposition d'action (expirée ⇒ non exécutable).
  proposalTtlMinutes: 30,
  // Rate limit dédié de POST /assistant/message (anti-spam / coûts).
  rateLimitWindowMs: 60_000,
  rateLimitMax: Number(process.env.ASSISTANT_RATE_LIMIT_MAX ?? 20),
};

export function isAssistantConfigured(): boolean {
  return Boolean(
    assistantConfig.baseUrl &&
      assistantConfig.apiKey &&
      assistantConfig.model,
  );
}

/** Nom technique du fournisseur (ne contient jamais la clé). */
export function assistantProviderName(): string | null {
  if (!isAssistantConfigured()) {
    return null;
  }
  try {
    const host = new URL(assistantConfig.baseUrl).host;
    return `openai-compatible:${host}`;
  } catch {
    return 'openai-compatible';
  }
}
