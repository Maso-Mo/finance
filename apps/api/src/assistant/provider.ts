import {
  assistantConfig,
  isAssistantConfigured,
  type ReasoningEffort,
} from './config.js';

/**
 * PROVIDER IA (étape 13) — abstraction découplée du métier Finance.
 *
 * Le métier ne connaît QUE cette interface (AssistantProvider). Groq est
 * simplement un ADAPTER au-dessus d'un transport HTTP « compatible OpenAI »
 * (POST /chat/completions) ; un modèle local LAN ou un autre endpoint
 * compatible s'ajoutera via le même `createProvider` sans réécrire Finance.
 *
 * Sécurité :
 *  - la clé n'est JAMAIS renvoyée au frontend ni loggée ;
 *  - timeout raisonnable + UNE seule retry technique (réseau), jamais de
 *    boucle infinie ; une panne fournisseur ne modifie aucune donnée ;
 *  - aucun SDK lourd : fetch + AbortController ;
 *  - `message.reasoning` (chaîne de raisonnement GPT-OSS) n'est JAMAIS la
 *    réponse utilisateur : seul `choices[0].message.content` fait foi.
 */

export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * Champs techniques SÛRS d'un échec fournisseur — jamais de clé, jamais de
 * prompt, jamais de contexte financier (uniquement des métadonnées).
 */
export interface CompletionDiagnostics {
  provider: string;
  model: string;
  httpStatus: number | null;
  choicesCount: number | null;
  finishReason: string | null;
  contentPresent: boolean;
  reasoningPresent: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
}

/** Réglages techniques d'un fournisseur (résolus par la config, testables). */
export interface ProviderSettings {
  /** Nom technique exposé publiquement (ex. 'groq', 'openai-compatible'). */
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Budget de sortie en tokens (défaut : 2048). */
  tokenLimit?: number;
  /**
   * true → `max_completion_tokens` (Groq / OpenAI récent : les tokens de
   * raisonnement en font partie) ; false → `max_tokens` (endpoints hérités).
   */
  useMaxCompletionTokens?: boolean;
  /** Effort de raisonnement : envoyé UNIQUEMENT si le modèle le supporte. */
  reasoningEffort?: ReasoningEffort;
  /** Inclure `message.reasoning` dans la réponse (défaut false). */
  includeReasoning?: boolean;
}

/** Connexion à un fournisseur ; l'adapter choisit la forme des paramètres. */
export type ProviderConnection = Omit<
  ProviderSettings,
  'name' | 'useMaxCompletionTokens'
>;

export interface AssistantProvider {
  readonly name: string;
  readonly model: string;
  /** Envoie la conversation complète du tour (messages), renvoie le texte. */
  complete(messages: ChatMessage[]): Promise<string>;
}

/** Diagnostic de repli (échec hors réponse HTTP : réseau, timeout, test). */
const UNKNOWN_DIAGNOSTICS: CompletionDiagnostics = {
  provider: 'unknown',
  model: 'unknown',
  httpStatus: null,
  choicesCount: null,
  finishReason: null,
  contentPresent: false,
  reasoningPresent: false,
  promptTokens: null,
  completionTokens: null,
  reasoningTokens: null,
};

/** Erreur technique contrôlée d'un appel fournisseur (message nettoyé). */
export class ProviderError extends Error {
  /** Diagnostic sûr (métadonnées uniquement) — pour l'exploitation. */
  readonly diagnostics: CompletionDiagnostics;
  /** true uniquement pour une panne réseau transitoire (UNE retry). */
  readonly retryable: boolean;

  constructor(
    message: string,
    diagnostics: CompletionDiagnostics = UNKNOWN_DIAGNOSTICS,
    retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
    this.diagnostics = diagnostics;
    this.retryable = retryable;
  }
}

/** Réponse JSON d'un endpoint compatible OpenAI (champs utiles seulement). */
type ChatCompletionResponse = {
  choices?: {
    finish_reason?: unknown;
    message?: { content?: unknown; reasoning?: unknown } | null;
  }[];
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown } | null;
  } | null;
};

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function buildUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  // Compatible OpenAI : /v1/chat/completions ou /chat/completions.
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`;
}

/**
 * Corps de requête envoyé au fournisseur : même forme pour tous les adapters,
 * seuls les paramètres supportés diffèrent (Groq vs endpoint hérité).
 */
function buildRequestBody(
  settings: ProviderSettings,
  messages: ChatMessage[],
): Record<string, unknown> {
  const tokenLimit = settings.tokenLimit ?? 2048;
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    temperature: 0,
    stream: false,
    ...(settings.useMaxCompletionTokens
      ? { max_completion_tokens: tokenLimit }
      : { max_tokens: tokenLimit }),
  };
  // Paramètres de raisonnement (GPT-OSS, Qwen3, MiniMax M) : uniquement quand
  // le modèle les supporte — les envoyer à un modèle classique = HTTP 400.
  if (settings.reasoningEffort) {
    body.reasoning_effort = settings.reasoningEffort;
    body.include_reasoning = settings.includeReasoning ?? false;
  }
  return body;
}

/** Diagnostic sûr construit à partir de la réponse HTTP (jamais de contenu). */
function buildDiagnostics(
  settings: Pick<ProviderSettings, 'name' | 'model'>,
  httpStatus: number | null,
  body?: ChatCompletionResponse | null,
): CompletionDiagnostics {
  const choices = Array.isArray(body?.choices) ? body.choices : null;
  const choice = choices?.[0] ?? null;
  const message = choice?.message ?? null;
  const usage = body?.usage ?? null;
  return {
    provider: settings.name,
    model: settings.model,
    httpStatus,
    choicesCount: choices ? choices.length : null,
    finishReason: asText(choice?.finish_reason),
    contentPresent: asText(message?.content) !== null,
    reasoningPresent: asText(message?.reasoning) !== null,
    promptTokens: asNumber(usage?.prompt_tokens),
    completionTokens: asNumber(usage?.completion_tokens),
    reasoningTokens: asNumber(usage?.completion_tokens_details?.reasoning_tokens),
  };
}

async function postOnce(
  url: string,
  settings: ProviderSettings,
  messages: ChatMessage[],
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(buildRequestBody(settings, messages)),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Rate limit fournisseur (429) et autres erreurs HTTP : jamais le corps
      // complet (peut contenir des données) ; pas de retry sur erreur HTTP.
      throw new ProviderError(
        `Provider responded with HTTP ${res.status}.`,
        buildDiagnostics(settings, res.status),
      );
    }
    let body: ChatCompletionResponse;
    try {
      body = (await res.json()) as ChatCompletionResponse;
    } catch {
      throw new ProviderError(
        'Provider returned a malformed JSON response.',
        buildDiagnostics(settings, res.status),
      );
    }
    const choices = Array.isArray(body?.choices) ? body.choices : [];
    if (choices.length === 0) {
      throw new ProviderError(
        'Provider returned no completion choices.',
        buildDiagnostics(settings, res.status, body),
      );
    }
    // SEUL `content` fait foi ; `reasoning` (GPT-OSS) n'est jamais la réponse.
    const content = asText(choices[0]?.message?.content);
    if (!content) {
      const diagnostics = buildDiagnostics(settings, res.status, body);
      throw new ProviderError(
        `Provider returned an empty completion (finish_reason=${diagnostics.finishReason ?? 'n/a'}, content_present=false, reasoning_present=${diagnostics.reasoningPresent}).`,
        diagnostics,
      );
    }
    return content;
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ProviderError(
        'Provider request timed out.',
        buildDiagnostics(settings, null),
      );
    }
    throw new ProviderError(
      'Provider request failed.',
      buildDiagnostics(settings, null),
      true, // panne réseau transitoire : UNE retry autorisée
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Endpoint Groq par défaut (API compatible OpenAI). */
const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

/**
 * Construit un fournisseur compatible OpenAI à partir de réglages explicites.
 * `name` distingue l'adapter (groq, endpoint LAN futur, …) — le transport
 * HTTP, le timeout, la forme des paramètres et la retry unique sont partagés.
 */
export function createProvider(settings: ProviderSettings): AssistantProvider {
  const url = buildUrl(settings.baseUrl);
  return {
    name: settings.name,
    model: settings.model,
    async complete(messages) {
      try {
        return await postOnce(url, settings, messages);
      } catch (error) {
        // UNE retry technique (panne réseau transitoire) — jamais plus.
        if (error instanceof ProviderError && error.retryable) {
          return postOnce(url, settings, messages);
        }
        throw error;
      }
    },
  };
}

/** Adapter Groq (endpoint OpenAI-compatible par défaut, modèle configurable). */
export function createGroqProvider(
  connection: ProviderConnection,
): AssistantProvider {
  return createProvider({
    ...connection,
    name: 'groq',
    baseUrl: connection.baseUrl || DEFAULT_GROQ_BASE_URL,
    // GPT-OSS : budget total via `max_completion_tokens` (raisonnement inclus),
    // `reasoning_effort`/`include_reasoning` seulement si le modèle les
    // supporte (résolus par la config).
    useMaxCompletionTokens: true,
    includeReasoning: connection.includeReasoning ?? false,
  });
}

/** Adapter générique « OpenAI-compatible » (endpoint quelconque, futur LAN). */
export function createOpenAICompatibleProvider(
  connection: ProviderConnection,
): AssistantProvider {
  return createProvider({
    ...connection,
    name: 'openai-compatible',
    // Endpoint hérité/inconnu : `max_tokens` uniquement, aucun paramètre de
    // raisonnement (il pourrait être rejeté).
    useMaxCompletionTokens: false,
    reasoningEffort: undefined,
    includeReasoning: undefined,
  });
}

/** Provider actif ou null si l'assistant n'est pas configuré (mode dégradé). */
export function createConfiguredProvider(): AssistantProvider | null {
  if (!isAssistantConfigured()) {
    return null;
  }
  const connection: ProviderConnection = {
    baseUrl: assistantConfig.baseUrl,
    apiKey: assistantConfig.apiKey,
    model: assistantConfig.model,
    timeoutMs: assistantConfig.timeoutMs,
    tokenLimit: assistantConfig.maxCompletionTokens,
    reasoningEffort: assistantConfig.reasoningEffort ?? undefined,
    includeReasoning: assistantConfig.includeReasoning,
  };
  // Le nom technique choisi vient de la config : 'groq' si GROQ_* renseigné,
  // 'openai-compatible' pour la configuration héritée AI_*.
  return assistantConfig.providerName === 'groq'
    ? createGroqProvider(connection)
    : createOpenAICompatibleProvider(connection);
}

