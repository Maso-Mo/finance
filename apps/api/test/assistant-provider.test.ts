import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAssistantConfig } from '../src/assistant/config.js';
import {
  createGroqProvider,
  createOpenAICompatibleProvider,
  ProviderError,
  type ChatMessage,
} from '../src/assistant/provider.js';

/**
 * PROVIDER IA GROQ (étape 13) — tests unitaires SANS appel réel.
 *
 * Aucun réseau réel : `fetch` global est remplacé par un mock HTTP. On vérifie
 * la configuration GROQ_* (vs héritée AI_*), le transport OpenAI-compatible,
 * la gestion GPT-OSS (`max_completion_tokens` + raisonnement, jamais exposé),
 * les diagnostics sûrs en cas de complétion vide, le timeout, l'absence de
 * retry sur erreur HTTP/timeout et l'UNIQUE retry sur panne réseau
 * transitoire. Aucune donnée financière, aucun secret réel.
 */

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'Sois bref.' },
  { role: 'user', content: 'Dis ok.' },
];

/** Réponse HTTP avec corps JSON explicite (forme brute compatible OpenAI). */
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Réponse HTTP compatible OpenAI minimale avec `content`. */
function okResponse(content: string) {
  return jsonResponse({ choices: [{ message: { content } }] });
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

  it('budget de sortie : défaut 2048, valeur explicite respectée, plancher 256', () => {
    const base = { GROQ_API_KEY: 'groq-secret', GROQ_MODEL: 'openai/gpt-oss-20b' };
    expect(resolveAssistantConfig(base).maxCompletionTokens).toBe(2048);
    expect(
      resolveAssistantConfig({ ...base, GROQ_MAX_COMPLETION_TOKENS: '512' })
        .maxCompletionTokens,
    ).toBe(512);
    expect(
      resolveAssistantConfig({ ...base, GROQ_MAX_COMPLETION_TOKENS: 'abc' })
        .maxCompletionTokens,
    ).toBe(2048);
    expect(
      resolveAssistantConfig({ ...base, GROQ_MAX_COMPLETION_TOKENS: '5' })
        .maxCompletionTokens,
    ).toBe(256);
  });

  it('modèle à raisonnement (GPT-OSS/Qwen3) → effort « low » par défaut', () => {
    const gptOss = resolveAssistantConfig({
      GROQ_API_KEY: 'k',
      GROQ_MODEL: 'openai/gpt-oss-20b',
    });
    expect(gptOss.reasoningEffort).toBe('low');
    expect(gptOss.includeReasoning).toBe(false);
    expect(
      resolveAssistantConfig({ GROQ_API_KEY: 'k', GROQ_MODEL: 'qwen/qwen3.6-27b' })
        .reasoningEffort,
    ).toBe('low');
  });

  it('modèle classique (llama) → aucun paramètre de raisonnement', () => {
    const cfg = resolveAssistantConfig({
      GROQ_API_KEY: 'k',
      GROQ_MODEL: 'llama-3.3-70b-versatile',
    });
    expect(cfg.reasoningEffort).toBeNull();
    expect(cfg.includeReasoning).toBe(false);
  });

  it('GROQ_REASONING_EFFORT explicite prioritaire, valeur invalide ignorée', () => {
    expect(
      resolveAssistantConfig({
        GROQ_API_KEY: 'k',
        GROQ_MODEL: 'openai/gpt-oss-20b',
        GROQ_REASONING_EFFORT: 'HIGH',
      }).reasoningEffort,
    ).toBe('high');
    expect(
      resolveAssistantConfig({
        GROQ_API_KEY: 'k',
        GROQ_MODEL: 'llama-3.3-70b-versatile',
        GROQ_REASONING_EFFORT: 'medium',
      }).reasoningEffort,
    ).toBe('medium');
    expect(
      resolveAssistantConfig({
        GROQ_API_KEY: 'k',
        GROQ_MODEL: 'openai/gpt-oss-20b',
        GROQ_REASONING_EFFORT: 'nonsense',
      }).reasoningEffort,
    ).toBe('low');
  });

  it('GROQ_INCLUDE_REASONING=true → raisonnement inclus (débogage seulement)', () => {
    const cfg = resolveAssistantConfig({
      GROQ_API_KEY: 'k',
      GROQ_MODEL: 'openai/gpt-oss-20b',
      GROQ_INCLUDE_REASONING: 'true',
    });
    expect(cfg.includeReasoning).toBe(true);
  });

  it('endpoint hérité AI_* → aucun paramètre de raisonnement', () => {
    const cfg = resolveAssistantConfig({
      AI_API_KEY: 'k',
      AI_MODEL: 'openai/gpt-oss-20b',
      AI_BASE_URL: 'https://lan.example/v1',
    });
    expect(cfg.providerName).toBe('openai-compatible');
    expect(cfg.reasoningEffort).toBeNull();
  });
});

describe('provider — transport HTTP compatible OpenAI', () => {
  it('succès GPT-OSS : envoie content + raisonnement et renvoie le contenu seul', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer groq-secret',
      );
      return jsonResponse({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: '  OK  ', reasoning: 'raisonnement interne' },
          },
        ],
        usage: {
          prompt_tokens: 89,
          completion_tokens: 20,
          completion_tokens_details: { reasoning_tokens: 10 },
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = createGroqProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'groq-secret',
      model: 'openai/gpt-oss-20b',
      timeoutMs: 1000,
      tokenLimit: 256,
      reasoningEffort: 'low',
      includeReasoning: false,
    });

    expect(provider.name).toBe('groq');
    expect(provider.model).toBe('openai/gpt-oss-20b');
    await expect(provider.complete(MESSAGES)).resolves.toBe('OK');

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('openai/gpt-oss-20b');
    expect(body.messages).toEqual(MESSAGES);
    expect(body.temperature).toBe(0);
    expect(body.stream).toBe(false);
    // GPT-OSS : budget total via max_completion_tokens (jamais max_tokens).
    expect(body.max_completion_tokens).toBe(256);
    expect(body.max_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBe('low');
    expect(body.include_reasoning).toBe(false);
  });

  it('content + reasoning : `reasoning` n’est JAMAIS la réponse utilisateur', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: 'Bonjour', reasoning: 'je réfléchis longuement…' },
            },
          ],
        }),
      ),
    );
    const provider = createGroqProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'k',
      model: 'openai/gpt-oss-20b',
      timeoutMs: 1000,
      reasoningEffort: 'low',
    });
    await expect(provider.complete(MESSAGES)).resolves.toBe('Bonjour');
  });

  it('finish_reason "stop" → réponse acceptée telle quelle', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          choices: [
            { finish_reason: 'stop', message: { content: '{"action":"none"}' } },
          ],
        }),
      ),
    );
    const provider = createOpenAICompatibleProvider({
      baseUrl: 'https://legacy.example/v1',
      apiKey: 'k',
      model: 'm',
      timeoutMs: 1000,
    });
    await expect(provider.complete(MESSAGES)).resolves.toBe('{"action":"none"}');
  });

  it('rate limit fournisseur (HTTP 429) → ProviderError diagnostiqué, AUCUNE retry', async () => {
    const fetchMock = vi.fn(async () => httpError(429));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createGroqProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'groq-secret',
      model: 'openai/gpt-oss-20b',
      timeoutMs: 1000,
    });
    await expect(provider.complete(MESSAGES)).rejects.toMatchObject({
      name: 'ProviderError',
      message: 'Provider responded with HTTP 429.',
      diagnostics: {
        provider: 'groq',
        model: 'openai/gpt-oss-20b',
        httpStatus: 429,
        choicesCount: null,
        contentPresent: false,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('corps JSON malformé → ProviderError, aucune retry', async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('bad json');
          },
        }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = createGroqProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'k',
      model: 'openai/gpt-oss-20b',
      timeoutMs: 1000,
    });
    await expect(provider.complete(MESSAGES)).rejects.toMatchObject({
      name: 'ProviderError',
      message: 'Provider returned a malformed JSON response.',
      diagnostics: { httpStatus: 200, choicesCount: null },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aucun choix renvoyé (choices vide) → ProviderError diagnostiqué', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createGroqProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'k',
      model: 'openai/gpt-oss-20b',
      timeoutMs: 1000,
    });
    await expect(provider.complete(MESSAGES)).rejects.toMatchObject({
      name: 'ProviderError',
      message: 'Provider returned no completion choices.',
      diagnostics: { httpStatus: 200, choicesCount: 0, contentPresent: false },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('diagnostic d’échec : aucune fuite de clé, de prompt ni de raisonnement', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            finish_reason: 'length',
            message: { content: '', reasoning: 'raisonnement-secret-xyz' },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = createGroqProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'groq-secret-key-1234567890',
      model: 'openai/gpt-oss-20b',
      timeoutMs: 1000,
    });
    const error = await provider.complete(MESSAGES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    const failure = error as ProviderError;
    const serialized = JSON.stringify({
      message: failure.message,
      diagnostics: failure.diagnostics,
    });
    // Aucun secret, aucun contenu utilisateur, aucun raisonnement fuité.
    expect(serialized).not.toContain('groq-secret-key');
    expect(serialized).not.toContain('raisonnement-secret');
    expect(serialized).not.toContain('Sois bref');
    expect(serialized).not.toContain('Dis ok');
    // Le diagnostic ne contient QUE la liste blanche de métadonnées.
    expect(Object.keys(failure.diagnostics).sort()).toEqual([
      'choicesCount',
      'completionTokens',
      'contentPresent',
      'finishReason',
      'httpStatus',
      'model',
      'promptTokens',
      'provider',
      'reasoningPresent',
      'reasoningTokens',
    ]);
  });

  it('complétion vide (raisonnement ayant épuisé le budget) → diagnostic précis', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            finish_reason: 'length',
            message: { content: '   ', reasoning: 'raisonnement long tronqué' },
          },
        ],
        usage: {
          prompt_tokens: 89,
          completion_tokens: 16,
          completion_tokens_details: { reasoning_tokens: 14 },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = createGroqProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'groq-secret',
      model: 'openai/gpt-oss-20b',
      timeoutMs: 1000,
      tokenLimit: 256,
      reasoningEffort: 'low',
    });
    await expect(provider.complete(MESSAGES)).rejects.toMatchObject({
      name: 'ProviderError',
      diagnostics: {
        provider: 'groq',
        model: 'openai/gpt-oss-20b',
        httpStatus: 200,
        choicesCount: 1,
        finishReason: 'length',
        contentPresent: false,
        reasoningPresent: true,
        promptTokens: 89,
        completionTokens: 16,
        reasoningTokens: 14,
      },
    });
    // Une complétion vide ne se répare pas en rejouant la requête.
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // Endpoint hérité : max_tokens classique, aucun paramètre de raisonnement.
    expect(body.max_tokens).toBe(2048);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.include_reasoning).toBeUndefined();
    expect(body.stream).toBe(false);
  });
});

