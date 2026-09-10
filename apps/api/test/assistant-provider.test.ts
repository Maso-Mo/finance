import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAssistantConfig } from '../src/assistant/config.js';
import {
  createGroqProvider,
  createOpenAICompatibleProvider,
  type ChatMessage,
} from '../src/assistant/provider.js';

/**
 * PROVIDER IA GROQ (étape 13) — tests unitaires SANS appel réel.
 *
 * Aucun réseau réel : `fetch` global est remplacé par un mock HTTP. On vérifie
 * la configuration GROQ_* (vs héritée AI_*), le transport OpenAI-compatible,
 * le timeout, l'absence de retry sur erreur HTTP / timeout, et l'UNIQUE retry
 * sur panne réseau transitoire. Aucune donnée financière, aucun secret réel.
 */

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'Sois bref.' },
  { role: 'user', content: 'Dis ok.' },
];

/** Réponse HTTP compatible OpenAI. */
function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

function httpError(status: number) {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveAssistantConfig — variables GROQ_* (et héritage AI_*)', () => {
  it('aucune variable → providerName null (mode dégradé)', () => {
    const cfg = resolveAssistantConfig({});
    expect(cfg.providerName).toBeNull();
    expect(cfg.baseUrl).toBe('');
    expect(cfg.apiKey).toBe('');
  });

  it('GROQ_API_KEY + GROQ_MODEL → groq, baseUrl Groq par défaut', () => {
    const cfg = resolveAssistantConfig({
      GROQ_API_KEY: ' groq-secret ',
      GROQ_MODEL: 'llama-test',
    });
    expect(cfg.providerName).toBe('groq');
    expect(cfg.apiKey).toBe('groq-secret');
    expect(cfg.model).toBe('llama-test');
    expect(cfg.baseUrl).toBe('https://api.groq.com/openai/v1');
  });

  it('GROQ_* présent et AI_* présent → GROQ_* prioritaire', () => {
    const cfg = resolveAssistantConfig({
      GROQ_API_KEY: 'groq-secret',
      GROQ_MODEL: 'groq-model',
      AI_API_KEY: 'legacy-secret',
      AI_MODEL: 'legacy-model',
      AI_BASE_URL: 'https://legacy.example/v1',
    });
    expect(cfg.providerName).toBe('groq');
    expect(cfg.apiKey).toBe('groq-secret');
    expect(cfg.model).toBe('groq-model');
    expect(cfg.baseUrl).toBe('https://api.groq.com/openai/v1');
  });

  it('seules les variables AI_* (héritées) → openai-compatible', () => {
    const cfg = resolveAssistantConfig({
      AI_API_KEY: 'legacy-secret',
      AI_MODEL: 'legacy-model',
      AI_BASE_URL: 'https://legacy.example/v1',
    });
    expect(cfg.providerName).toBe('openai-compatible');
    expect(cfg.apiKey).toBe('legacy-secret');
    expect(cfg.model).toBe('legacy-model');
    expect(cfg.baseUrl).toBe('https://legacy.example/v1');
  });

  it('timeout : valeur invalide/absente → défaut 30s, min 1s', () => {
    expect(resolveAssistantConfig({ GROQ_TIMEOUT_MS: 'abc' }).timeoutMs).toBe(30_000);
    expect(resolveAssistantConfig({}).timeoutMs).toBe(30_000);
    expect(resolveAssistantConfig({ GROQ_TIMEOUT_MS: '5' }).timeoutMs).toBe(1000);
  });
});

describe('provider — transport HTTP compatible OpenAI', () => {
  it('succès : envoie model + messages, renvoie le contenu nettoyé', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer groq-secret',
      );
      return okResponse('  Bonjour  ');
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = createGroqProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'groq-secret',
      model: 'llama-test',
      timeoutMs: 1000,
    });

    expect(provider.name).toBe('groq');
    expect(provider.model).toBe('llama-test');
    await expect(provider.complete(MESSAGES)).resolves.toBe('Bonjour');

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: ChatMessage[];
      temperature: number;
    };
    expect(body.model).toBe('llama-test');
    expect(body.messages).toEqual(MESSAGES);
    expect(body.temperature).toBe(0);
  });

  it('rate limit fournisseur (HTTP 429) → ProviderError, AUCUNE retry', async () => {
    const fetchMock = vi.fn(async () => httpError(429));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createGroqProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'groq-secret',
      model: 'llama-test',
      timeoutMs: 1000,
    });
    await expect(provider.complete(MESSAGES)).rejects.toMatchObject({
      name: 'ProviderError',
      message: 'Provider responded with HTTP 429.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('réponse vide → ProviderError (aucun contenu exploitable)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('  ')));
    const provider = createOpenAICompatibleProvider({
      baseUrl: 'https://legacy.example/v1',
      apiKey: 'k',
      model: 'm',
      timeoutMs: 1000,
    });
    await expect(provider.complete(MESSAGES)).rejects.toMatchObject({
      name: 'ProviderError',
    });
  });

  it('timeout → ProviderError "timed out", AUCUNE retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      ),
    );
    const provider = createGroqProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'groq-secret',
      model: 'llama-test',
      timeoutMs: 20,
    });
    await expect(provider.complete(MESSAGES)).rejects.toMatchObject({
      name: 'ProviderError',
      message: 'Provider request timed out.',
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('panne réseau transitoire → UNE retry technique, jamais plus', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(okResponse('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createOpenAICompatibleProvider({
      baseUrl: 'https://legacy.example/v1',
      apiKey: 'k',
      model: 'm',
      timeoutMs: 1000,
    });
    await expect(provider.complete(MESSAGES)).resolves.toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('deux pannes réseau → ProviderError final (pas de boucle)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createOpenAICompatibleProvider({
      baseUrl: 'https://legacy.example/v1',
      apiKey: 'k',
      model: 'm',
      timeoutMs: 1000,
    });
    await expect(provider.complete(MESSAGES)).rejects.toMatchObject({
      name: 'ProviderError',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('adapter générique : nom "openai-compatible", URL "/chat/completions" ajoutée', async () => {
    const fetchMock = vi.fn(async (_url: unknown) => okResponse('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createOpenAICompatibleProvider({
      baseUrl: 'https://lan-model.local:8000/v1/',
      apiKey: 'k',
      model: 'm',
      timeoutMs: 1000,
    });
    expect(provider.name).toBe('openai-compatible');
    await provider.complete(MESSAGES);
    const url = fetchMock.mock.calls[0]![0] as unknown as string;
    expect(url).toBe('https://lan-model.local:8000/v1/chat/completions');
  });
});

