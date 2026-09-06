import { assistantConfig, isAssistantConfigured } from './config.js';

/**
 * Abstraction PROVIDER IA (étape 13) — découplée du métier.
 *
 * Une API « compatible OpenAI » (POST /chat/completions) est le format
 * cible : le fournisseur est configurable via AI_BASE_URL / AI_API_KEY /
 * AI_MODEL sans modifier le métier. Aucun SDK lourd : fetch + timeout.
 *
 * Sécurité :
 *  - la clé n'est JAMAIS renvoyée au frontend ni loggée ;
 *  - timeout raisonnable + UNE seule retry technique (réseau), jamais de
 *    boucle infinie ; une panne fournisseur ne modifie aucune donnée.
 */

export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  role: ChatRole;
  content: string;
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
      const status = res.status;
      // Ne jamais logguer le corps complet (peut contenir des données).
      throw new ProviderError(`Provider responded with HTTP ${status}.`);
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

/** Fournisseur compatible OpenAI, configuré via l'environnement. */
export function createOpenAICompatibleProvider(): AssistantProvider {
  return {
    name: 'openai-compatible',
    model: assistantConfig.model,
    async complete(messages) {
      const url = buildUrl(assistantConfig.baseUrl);
      try {
        return await postOnce(
          url,
          assistantConfig.apiKey,
          assistantConfig.model,
          messages,
          assistantConfig.timeoutMs,
        );
      } catch (error) {
        // UNE retry technique (panne réseau transitoire) — jamais plus.
        if (
          error instanceof ProviderError &&
          error.message === 'Provider request failed.'
        ) {
          return postOnce(
            url,
            assistantConfig.apiKey,
            assistantConfig.model,
            messages,
            assistantConfig.timeoutMs,
          );
        }
        throw error;
      }
    },
  };
}

/** Provider actif ou null si l'assistant n'est pas configuré (mode dégradé). */
export function createConfiguredProvider(): AssistantProvider | null {
  if (!isAssistantConfigured()) {
    return null;
  }
  return createOpenAICompatibleProvider();
}
