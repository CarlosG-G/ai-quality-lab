const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash'];

export interface FetchResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<FetchResponse>;

export type GeminiFailure =
  | 'auth'
  | 'quota'
  | 'model_not_found'
  | 'blocked'
  | 'bad_request'
  | 'transient'
  | 'empty_response'
  | 'network';

/** Error that never carries the API key, only a classification and HTTP status. */
export class GeminiError extends Error {
  readonly failure: GeminiFailure;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(failure: GeminiFailure, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'GeminiError';
    this.failure = failure;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface GeminiUsage {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface GeminiRequest {
  systemInstruction: string;
  userText: string;
  temperature?: number;
  /** OpenAPI-style schema; when set, Gemini must answer with matching JSON. */
  responseSchema?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface GeminiResult {
  text: string;
  model: string;
  keyIndex: number;
  attempts: number;
  usage: GeminiUsage;
}

export interface GeminiClientOptions {
  apiKeys: string[];
  models?: string[];
  fetcher?: Fetcher;
  /** Retries per key/model for transient errors (5xx, timeouts). */
  maxRetries?: number;
  baseDelayMs?: number;
  /** Total time one request may wait for rate-limited keys/models to become available again. */
  maxRetryAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

const DAILY_QUOTA_COOLDOWN_MS = 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,\n;]/)
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/** Reads GEMINI_API_KEYS (comma separated) plus GEMINI_API_KEY, de-duplicated, in order. */
export function geminiKeysFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([...splitList(env.GEMINI_API_KEYS), ...splitList(env.GEMINI_API_KEY)])];
}

/** Reads a model list such as GEMINI_MODELS="a,b"; a single-model variable is also accepted. */
export function geminiModelsFromEnv(
  env: NodeJS.ProcessEnv,
  listVar: string,
  singleVar?: string,
): string[] {
  const models = [...splitList(env[listVar]), ...(singleVar ? splitList(env[singleVar]) : [])];
  return models.length ? [...new Set(models)] : [...DEFAULT_GEMINI_MODELS];
}

function apiErrorStatus(payload: unknown): string {
  if (!isRecord(payload) || !isRecord(payload.error)) return '';
  const status = typeof payload.error.status === 'string' ? payload.error.status : '';
  const reasons = Array.isArray(payload.error.details)
    ? payload.error.details
      .filter(isRecord)
      .map((detail) => detail.reason)
      .filter((reason): reason is string => typeof reason === 'string')
    : [];
  return [status, ...reasons].join(' ');
}

function classifyHttp(status: number, apiStatus: string): GeminiFailure {
  if (/API_KEY_INVALID|API_KEY_EXPIRED|UNAUTHENTICATED|PERMISSION_DENIED|SERVICE_DISABLED/.test(apiStatus) ||
      status === 401 || status === 403) return 'auth';
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(apiStatus)) return 'quota';
  if (status === 404) return 'model_not_found';
  if (status === 408 || status >= 500) return 'transient';
  return 'bad_request';
}

function retryAfterMs(response: FetchResponse, payload: unknown): number | undefined {
  const header = response.headers?.get('retry-after');
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds)) return seconds * 1000;
  // Gemini usually sends the delay in the body as google.rpc.RetryInfo { retryDelay: "37s" }.
  if (!isRecord(payload) || !isRecord(payload.error) || !Array.isArray(payload.error.details)) return undefined;
  for (const detail of payload.error.details) {
    if (!isRecord(detail) || typeof detail.retryDelay !== 'string') continue;
    const match = detail.retryDelay.match(/^([\d.]+)s$/);
    if (match) return Math.ceil(Number(match[1]) * 1000);
  }
  return undefined;
}

function isDailyQuota(payload: unknown): boolean {
  return /PerDay/i.test(JSON.stringify(isRecord(payload) ? payload.error ?? '' : ''));
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Small Gemini REST client: rotates API keys on quota/auth errors, falls back across
 * models, retries transient failures with exponential backoff and detects safety blocks.
 */
export class GeminiClient {
  private readonly apiKeys: string[];
  readonly models: string[];
  private readonly fetcher: Fetcher;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  /** model|keyIndex -> timestamp when that pair may be used again. */
  private readonly cooldowns = new Map<string, number>();
  private activeKey = 0;
  private lastModel: string;

  constructor(options: GeminiClientOptions) {
    const keys = options.apiKeys.map((key) => key.trim()).filter(Boolean);
    if (!keys.length) throw new Error('GEMINI_API_KEY is required to call the Gemini API');
    const models = (options.models ?? DEFAULT_GEMINI_MODELS).map((model) => model.trim()).filter(Boolean);
    if (!models.length) throw new Error('At least one Gemini model is required');
    this.apiKeys = keys;
    this.models = models;
    this.fetcher = options.fetcher ?? fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 90_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.warn(message));
    this.lastModel = models[0] as string;
  }

  get keyCount(): number {
    return this.apiKeys.length;
  }

  /** Model that produced the last successful answer (first configured model before any call). */
  get model(): string {
    return this.lastModel;
  }

  async generate(request: GeminiRequest): Promise<GeminiResult> {
    const failures = new Set<string>();
    const missingModels = new Set<string>();
    const deadKeys = new Set<number>();
    let attempts = 0;
    let waitedMs = 0;
    let lastError: GeminiError | undefined;

    for (let pass = 0; pass < 10; pass++) {
      for (const model of this.models) {
        if (missingModels.has(model)) continue;
        for (let offset = 0; offset < this.apiKeys.length; offset++) {
          const keyIndex = (this.activeKey + offset) % this.apiKeys.length;
          const slot = `${model}|${keyIndex}`;
          if (deadKeys.has(keyIndex) || (this.cooldowns.get(slot) ?? 0) > this.now()) continue;

          for (let retry = 0; ; retry++) {
            attempts++;
            try {
              const result = await this.call(model, keyIndex, request);
              this.activeKey = keyIndex;
              this.lastModel = model;
              this.cooldowns.delete(slot);
              return { ...result, model, keyIndex, attempts };
            } catch (error) {
              const failure = error instanceof GeminiError
                ? error
                : new GeminiError('network', 'Gemini request failed before a response was received');
              lastError = failure;
              const label = `${model} key#${keyIndex + 1}: ${failure.failure}` +
                (failure.retryAfterMs === DAILY_QUOTA_COOLDOWN_MS ? ' (daily quota exhausted)' : '') +
                (failure.status ? ` (HTTP ${failure.status})` : '');

              if (failure.failure === 'blocked' || failure.failure === 'bad_request') throw failure;
              if (failure.failure === 'model_not_found') {
                missingModels.add(model);
              } else if (failure.failure === 'auth') {
                deadKeys.add(keyIndex);
              } else if (failure.failure === 'quota') {
                // Rate limits are per model and key: park this pair and move on to the next one.
                this.cooldowns.set(slot, this.now() + (failure.retryAfterMs ?? this.baseDelayMs * 10));
              } else if (retry < this.maxRetries) {
                const wait = this.baseDelayMs * 2 ** retry;
                this.log(`Gemini ${label}; retrying in ${Math.round(wait / 1000)}s`);
                await this.sleep(wait);
                continue;
              } else {
                // Overloaded model (503) or repeated timeouts: avoid it for a while across requests.
                this.cooldowns.set(slot, this.now() + this.baseDelayMs * 30);
              }
              failures.add(label);
              break;
            }
          }
          if (missingModels.has(model)) break;
        }
      }

      const readyTimes = this.models
        .filter((model) => !missingModels.has(model))
        .flatMap((model) => this.apiKeys
          .map((_, keyIndex) => keyIndex)
          .filter((keyIndex) => !deadKeys.has(keyIndex))
          .map((keyIndex) => this.cooldowns.get(`${model}|${keyIndex}`) ?? 0));
      if (!readyTimes.length) break;
      const wait = Math.max(1, Math.min(...readyTimes) - this.now());
      if (waitedMs + wait > this.maxRetryAfterMs) break;
      this.log(`All Gemini keys/models are rate limited or busy; waiting ${Math.ceil(wait / 1000)}s`);
      await this.sleep(wait);
      waitedMs += wait;
    }

    throw new GeminiError(
      lastError?.failure ?? 'network',
      `All Gemini keys/models failed: ${[...failures].join('; ')}`,
      lastError?.status,
    );
  }

  private async call(
    model: string,
    keyIndex: number,
    request: GeminiRequest,
  ): Promise<{ text: string; usage: GeminiUsage }> {
    const generationConfig: Record<string, unknown> = { temperature: request.temperature ?? 0 };
    if (request.responseSchema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = request.responseSchema;
    }

    let response: FetchResponse;
    try {
      response = await this.fetcher(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        signal: AbortSignal.timeout(request.timeoutMs ?? 60_000),
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKeys[keyIndex] as string,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.systemInstruction }] },
          contents: [{ role: 'user', parts: [{ text: request.userText }] }],
          generationConfig,
        }),
      });
    } catch {
      throw new GeminiError('transient', 'Gemini request timed out or the network failed');
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const failure = classifyHttp(response.status, apiErrorStatus(payload));
      const daily = failure === 'quota' && isDailyQuota(payload);
      throw new GeminiError(
        failure,
        `Gemini API returned HTTP ${response.status}${daily ? ' (daily quota exhausted)' : ''}`,
        response.status,
        daily ? DAILY_QUOTA_COOLDOWN_MS : retryAfterMs(response, payload),
      );
    }

    if (!isRecord(payload)) throw new GeminiError('empty_response', 'Gemini returned a non-JSON response');
    if (isRecord(payload.promptFeedback) && typeof payload.promptFeedback.blockReason === 'string') {
      throw new GeminiError('blocked', `Gemini blocked the prompt (${payload.promptFeedback.blockReason})`);
    }
    const candidate = Array.isArray(payload.candidates) ? payload.candidates[0] : undefined;
    if (!isRecord(candidate)) throw new GeminiError('empty_response', 'Gemini returned no candidates');

    const finishReason = typeof candidate.finishReason === 'string' ? candidate.finishReason : 'STOP';
    if (/SAFETY|RECITATION|BLOCKLIST|PROHIBITED_CONTENT|SPII/.test(finishReason)) {
      throw new GeminiError('blocked', `Gemini stopped the answer (${finishReason})`);
    }
    const parts = isRecord(candidate.content) && Array.isArray(candidate.content.parts)
      ? candidate.content.parts
      : [];
    const text = parts
      .filter(isRecord)
      .filter((part) => part.thought !== true)
      .map((part) => part.text)
      .filter((part): part is string => typeof part === 'string')
      .join('')
      .trim();
    if (!text) throw new GeminiError('empty_response', `Gemini returned an empty answer (${finishReason})`);

    const usage = isRecord(payload.usageMetadata) ? payload.usageMetadata : {};
    return {
      text,
      usage: {
        promptTokens: count(usage.promptTokenCount),
        outputTokens: count(usage.candidatesTokenCount) + count(usage.thoughtsTokenCount),
        totalTokens: count(usage.totalTokenCount),
      },
    };
  }

  /** Lists model ids visible to one key; used by the connectivity check. */
  async listModels(keyIndex = 0): Promise<string[]> {
    let response: FetchResponse;
    try {
      response = await this.fetcher(`${API_BASE}/models?pageSize=200`, {
        method: 'GET',
        signal: AbortSignal.timeout(20_000),
        headers: { 'x-goog-api-key': this.apiKeys[keyIndex] as string },
      });
    } catch {
      throw new GeminiError('network', 'Could not reach the Gemini API');
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new GeminiError(classifyHttp(response.status, apiErrorStatus(payload)),
        `Gemini model list returned HTTP ${response.status}`, response.status);
    }
    if (!isRecord(payload) || !Array.isArray(payload.models)) return [];
    return payload.models
      .filter(isRecord)
      .map((model) => model.name)
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.replace(/^models\//, ''));
  }
}
