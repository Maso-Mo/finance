import { assistantConfig, isAssistantConfigured } from './config.js';

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
 *  - aucun SDK lourd : fetch + AbortController.
 */

export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Réglages techniques d'un fournisseur (résolus par la config, testables). */
export interface ProviderSettings {
  /** Nom technique exposé publiquement (ex. 'groq', 'openai-compatible'). */
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface AssistantProvider {
  readonly name: string;
  readonly model: string;
  /** Envoie la conversation complète du tour (messages), renvoie le texte. */
  complete(messages: ChatMessage[]): Promise<string>;
}

/** Erreur technique contrôlée d'un appel fournisseur (message nettoyé). */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Représentation du JSON renvoyé par un endpoint compatible OpenAI. */
type ChatCompletionResponse = {
  choices?: { message?: { content?: string | null } | null }[];
};

function buildUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  // Compatible OpenAI : /v1/chat/completions ou /chat/completions.
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`;
}

async function postOnce(
  url: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: 2000,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Rate limit fournisseur (429) et autres erreurs HTTP : jamais le corps
      // complet (peut contenir des données) ; pas de retry sur erreur HTTP.
      throw new ProviderError(`Provider responded with HTTP ${res.status}.`);
    }
    const body = (await res.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new ProviderError('Provider returned an empty completion.');
    }
    return content;
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ProviderError('Provider request timed out.');
    }
    throw new ProviderError('Provider request failed.');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Construit un fournisseur compatible OpenAI à partir de réglages explicites.
 * `name` distingue l'adapter (groq, endpoint LAN futur, …) — le transport
 * HTTP, le timeout et la retry unique restent partagés.
 */
export function createProvider(settings: ProviderSettings): AssistantProvider {
  const url = buildUrl(settings.baseUrl);
  return {
    name: settings.name,
    model: settings.model,
    async complete(messages) {
      try {
        return await postOnce(
          url,
          settings.apiKey,
          settings.model,
          messages,
          settings.timeoutMs,
        );
      } catch (error) {
        // UNE retry technique (panne réseau transitoire) — jamais plus.
        if (
          error instanceof ProviderError &&
          error.message === 'Provider request failed.'
        ) {
          return postOnce(
            url,
            settings.apiKey,
            settings.model,
            messages,
            settings.timeoutMs,
          );
        }
        throw error;
      }
    },
  };
}

/** Adapter Groq (endpoint OpenAI-compatible par défaut, modèle configurable). */
export function createGroqProvider(
  settings: Omit<ProviderSettings, 'name'>,
): AssistantProvider {
  return createProvider({
    ...settings,
    name: 'groq',
    baseUrl:
      settings.baseUrl || 'https://api.groq.com/openai/v1',
  });
}

/** Adapter générique « OpenAI-compatible » (endpoint quelconque, futur LAN). */
export function createOpenAICompatibleProvider(
  settings: Omit<ProviderSettings, 'name'>,
): AssistantProvider {
  return createProvider({
    ...settings,
    name: 'openai-compatible',
  });
}

/** Provider actif ou null si l'assistant n'est pas configuré (mode dégradé). */
export function createConfiguredProvider(): AssistantProvider | null {
  if (!isAssistantConfigured()) {
    return null;
  }
  const settings = {
    baseUrl: assistantConfig.baseUrl,
    apiKey: assistantConfig.apiKey,
    model: assistantConfig.model,
    timeoutMs: assistantConfig.timeoutMs,
  };
  // Le nom technique choisi vient de la config : 'groq' si GROQ_* renseigné,
  // 'openai-compatible' pour la configuration héritée AI_*.
  return assistantConfig.providerName === 'groq'
    ? createGroqProvider(settings)
    : createOpenAICompatibleProvider(settings);
}

