#!/usr/bin/env node
/**
 * SMOKE TEST GROQ (étape 13) — MANUEL uniquement.
 *
 *  - Jamais exécuté automatiquement par Vitest/E2E ;
 *  - n'appelle le fournisseur QUE si une clé est présente (GROQ_API_KEY,
 *    sinon AI_API_KEY hérité) ;
 *  - utilise uniquement des données SYNTHÉTIQUES : aucune donnée financière ;
 *  - la clé n'est jamais affichée ni loggée ;
 *  - utilise LE VRAI transport du provider (`createConfiguredProvider`) : la
 *    requête envoyée est EXACTEMENT celle de l'assistant (aucune divergence).
 *
 * Usage : pnpm --filter @finance/api assistant:smoke
 *   (charge automatiquement apps/api/.env — `node --env-file-if-exists=.env` —
 *   et TypeScript via tsx, d'où l'absence de build préalable)
 * Sortie : 0 si OK (ou non configuré), 1 si l'appel réel a échoué.
 */
import 'dotenv/config';

// Import dynamique APRÈS le chargement de l'environnement : la config du
// provider est lue à l'initialisation du module (comme dans l'API réelle).
const { createConfiguredProvider, ProviderError } = await import(
  '../src/assistant/provider.ts'
);
const { assistantConfig, isAssistantConfigured } = await import(
  '../src/assistant/config.ts'
);

// Requête SYNTHÉTIQUE minimale (aucune donnée réelle, aucune instruction).
const messages = [
  { role: 'system', content: 'Réponds uniquement par le mot "ok".' },
  { role: 'user', content: 'Dis-moi juste ok.' },
];

if (!isAssistantConfigured()) {
  console.log('[assistant:smoke] non configuré (GROQ_API_KEY/GROQ_MODEL absents) — ignoré.');
  process.exit(0);
}

const provider = createConfiguredProvider();
if (!provider) {
  console.log('[assistant:smoke] non configuré (provider indisponible) — ignoré.');
  process.exit(0);
}

// Paramètres effectifs (jamais la clé) : mêmes valeurs que l'assistant réel.
console.log(
  `[assistant:smoke] ${provider.name} · modèle ${provider.model} · max_completion_tokens=${assistantConfig.maxCompletionTokens} · reasoning_effort=${assistantConfig.reasoningEffort ?? 'n/a'} · include_reasoning=${assistantConfig.includeReasoning} · stream=false`,
);

const startedAt = Date.now();
try {
  const content = await provider.complete(messages);
  const preview = content.replace(/\s+/g, ' ').slice(0, 40);
  console.log(`[assistant:smoke] OK ${Date.now() - startedAt} ms · réponse: ${preview}`);
  process.exit(0);
} catch (error) {
  const kind = error instanceof ProviderError ? error.name : (error?.name ?? 'Error');
  const message = String(error?.message ?? error).slice(0, 200);
  console.error(`[assistant:smoke] échec ${provider.name} (${kind}) : ${message}`);
  if (error instanceof ProviderError) {
    // Diagnostic technique SANS donnée sensible (ni clé, ni prompt, ni contexte).
    console.error(`[assistant:smoke] diagnostic: ${JSON.stringify(error.diagnostics)}`);
  }
  process.exit(1);
}

