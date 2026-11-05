import { GeminiClient, GeminiError, geminiKeysFromEnv, geminiModelsFromEnv } from '../src/providers/gemini-client.ts';

// Connectivity check for every configured Gemini key. Keys are only ever shown as key#N.
const keys = geminiKeysFromEnv(process.env);
const models = [...new Set([
  ...geminiModelsFromEnv(process.env, 'GEMINI_MODELS', 'GEMINI_MODEL'),
  ...geminiModelsFromEnv(process.env, 'GEMINI_JUDGE_MODELS', 'GEMINI_JUDGE_MODEL'),
])];

if (!keys.length) {
  console.error('No Gemini key found. Set GEMINI_API_KEY or GEMINI_API_KEYS in .env');
  process.exit(1);
}

console.log(`Checking ${keys.length} Gemini key(s) against models: ${models.join(', ')}`);
let workingKeys = 0;

for (const [index, key] of keys.entries()) {
  const label = `key#${index + 1}`;
  const client = new GeminiClient({ apiKeys: [key], models, maxRetries: 1, log: () => {} });
  try {
    const visible = new Set(await client.listModels());
    const missing = models.filter((model) => !visible.has(model));
    console.log(`${label}: ${visible.size} models visible${missing.length ? `, missing: ${missing.join(', ')}` : ''}`);

    const started = Date.now();
    const result = await client.generate({
      systemInstruction: 'Reply with exactly one word.',
      userText: 'Say OK.',
      timeoutMs: 30_000,
    });
    console.log(
      `${label}: OK via ${result.model} in ${Date.now() - started} ms ` +
      `(${result.usage.promptTokens} in / ${result.usage.outputTokens} out tokens) -> "${result.text.trim().slice(0, 40)}"`,
    );
    workingKeys++;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    const quotaOnly = error instanceof GeminiError && error.failure === 'quota';
    console.error(quotaOnly
      ? `${label}: CONNECTED but out of quota - ${reason}`
      : `${label}: FAILED - ${reason}`);
  }
}

console.log(`${workingKeys}/${keys.length} Gemini key(s) working`);
if (!workingKeys) process.exit(1);
