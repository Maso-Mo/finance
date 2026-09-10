#!/usr/bin/env node
/**
 * SMOKE TEST GROQ (étape 13) — MANUEL uniquement.
 *
 *  - Jamais exécuté automatiquement par Vitest/E2E ;
 *  - n'appelle le fournisseur QUE si une clé est présente (GROQ_API_KEY,
 *    sinon AI_API_KEY hérité) ;
 *  - utilise uniquement des données SYNTHÉTIQUES : aucune donnée financière ;
 *  - la clé n'est jamais affichée ni loggée.
 *
 * Usage : pnpm --filter @finance/api assistant:smoke
 * Sortie : 0 si OK (ou non configuré), 1 si l'appel réel a échoué.
 */
import 'dotenv/config';

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

const apiKey = firstNonEmpty(process.env.GROQ_API_KEY, process.env.AI_API_KEY);
const model = firstNonEmpty(process.env.GROQ_MODEL, process.env.AI_MODEL);
const useGroq = firstNonEmpty(
  process.env.GROQ_API_KEY,
  process.env.GROQ_MODEL,
  process.env.GROQ_BASE_URL,
);
const baseUrl =
  (useGroq
    ? process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1'
    : process.env.AI_BASE_URL) || '';
const timeoutMs = Number(
  process.env.GROQ_TIMEOUT_MS ?? process.env.AI_TIMEOUT_MS ?? 30_000,
);

const provider = useGroq ? 'groq' : 'openai-compatible';

if (!apiKey || !model || !baseUrl) {
  console.log('[assistant:smoke] non configuré (GROQ_API_KEY/GROQ_MODEL absents) — ignoré.');
  process.exit(0);
}

// Requête SYNTHÉTIQUE minimale (aucune donnée réelle, aucune instruction).
const messages = [
  { role: 'system', content: 'Réponds uniquement par le mot "ok".' },
  { role: 'user', content: 'Dis-moi juste ok.' },
];

const url = baseUrl.replace(/\/+$/, '').endsWith('/chat/completions')
  ? baseUrl.replace(/\/+$/, '')
  : `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);

(async () => {
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 16 }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = await res.json();
    const content = body?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('completion vide');
    }
    console.log(
      `[assistant:smoke] ${provider} · modèle ${model} · ${res.status} · ${Date.now() - startedAt} ms · réponse: ${content.slice(0, 40)}`,
    );
    process.exit(0);
  } catch (error) {
    const kind =
      error instanceof DOMException && error.name === 'AbortError'
        ? 'timeout'
        : error?.name ?? 'error';
    console.error(`[assistant:smoke] échec ${provider} (${kind}) : ${String(error?.message ?? error).slice(0, 160)}`);
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
})();
