/**
 * Configuration de l'assistant IA (étape 13) — fournisseur GROQ par défaut.
 *
 * La clé ne transite jamais vers le frontend et n'est jamais loggée. Le mode
 * dégradé est la valeur par défaut : sans `GROQ_*` (ni `AI_*` hérité),
 * l'application financière continue de fonctionner normalement et
 * `GET /assistant/status` renvoie `{ available: false }`.
 *
 * Variables d'environnement (côté API uniquement) :
 *   GROQ_API_KEY   — clé d'API Groq (secret, jamais commité) ;
 *   GROQ_MODEL     — modèle Groq configurable (aucun nom hardcodé ici) ;
 *   GROQ_BASE_URL  — endpoint, défaut https://api.groq.com/openai/v1 ;
 *   GROQ_TIMEOUT_MS / AI_TIMEOUT_MS — timeout d'un appel fournisseur (ms).
 *
 * Compatibilité héritée : `AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL` restent
 * reconnus (endpoint OpenAI-compatible quelconque). Le futur mode local LAN
 * (modèle OpenAI-compatible) remplacera simplement ces variables.
 */

/** Endpoint chat/completions de Groq (API compatible OpenAI). */
const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

function firstNonEmpty(...values: (string | undefined)[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return '';
}

/** Résolution pure (testable) de la configuration depuis l'environnement. */
export function resolveAssistantConfig(env: NodeJS.ProcessEnv): {
  providerName: 'groq' | 'openai-compatible' | null;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxToolCalls: number;
  timeoutMs: number;
  draftTtlMinutes: number;
  proposalTtlMinutes: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
} {
  const groqKey = firstNonEmpty(env.GROQ_API_KEY);
  const groqModel = firstNonEmpty(env.GROQ_MODEL);
  const groqBase = firstNonEmpty(env.GROQ_BASE_URL);
  const legacyKey = firstNonEmpty(env.AI_API_KEY);
  const legacyModel = firstNonEmpty(env.AI_MODEL);
  const legacyBase = firstNonEmpty(env.AI_BASE_URL);

  // Groq est prioritaire dès qu'une variable GROQ_* est renseignée ; sinon on
  // retombe sur la configuration héritée AI_* (endpoint OpenAI-compatible).
  const groqDeclared = Boolean(groqKey || groqModel || groqBase);
  const legacyDeclared = Boolean(legacyKey || legacyModel || legacyBase);

  const providerName = groqDeclared
    ? 'groq'
    : legacyDeclared
      ? 'openai-compatible'
      : null;

  return {
    providerName,
    apiKey: groqDeclared ? groqKey : legacyKey,
    model: groqDeclared ? groqModel : legacyModel,
    baseUrl: groqDeclared
      ? groqBase || DEFAULT_GROQ_BASE_URL
      : legacyBase,
    // Nombre maximal d'appels d'outils read-only par requête (anti-boucle).
    maxToolCalls: 4,
    // Timeout d'un appel fournisseur (provider panne ⇒ erreur propre, jamais
    // de blocage de l'API générale, aucune retry infinie).
    timeoutMs: Math.max(
      1000,
      Number(env.GROQ_TIMEOUT_MS ?? env.AI_TIMEOUT_MS ?? 30_000) || 30_000,
    ),
    // Durée de vie d'un brouillon de clarification.
    draftTtlMinutes: 60,
    // Durée de vie d'une proposition d'action (expirée ⇒ non exécutable).
    proposalTtlMinutes: 30,
    // Rate limit dédié de POST /assistant/message (anti-spam / coûts).
    rateLimitWindowMs: 60_000,
    rateLimitMax: Number(env.ASSISTANT_RATE_LIMIT_MAX ?? 20),
  };
}

export const assistantConfig = resolveAssistantConfig(process.env);

export function isAssistantConfigured(): boolean {
  return Boolean(
    assistantConfig.baseUrl &&
      assistantConfig.apiKey &&
      assistantConfig.model,
  );
}
