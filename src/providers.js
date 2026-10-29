/**
 * Provider metadata + a single OpenAI-compatible client.
 *
 * Both providers speak the same wire format (`POST /chat/completions`,
 * `Authorization: Bearer …`), so one client serves both. Provider-specific
 * quirks live in the config below, not in branches spread through the code.
 */

import { buildMessages, buildTranslateMessages } from './prompt.js';

export const PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    keyHint: 'sk-…',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    baseUrl: 'https://api.deepseek.com',
    // DeepSeek's JSON mode is the `json_object` flavour.
    jsonMode: 'object',
    // DeepSeek defaults to thinking mode at high effort; a grammar pass
    // does not need chain-of-thought and it costs seconds per check.
    extraBody: { thinking: { type: 'disabled' } },
    // $/1M tokens, peak hours (conservative for estimates).
    price: { in: 0.3, out: 1.2 },
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat', tier: 'fast', note: 'default' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', tier: 'quality' },
    ],
  },

  openai: {
    id: 'openai',
    label: 'OpenAI',
    keyHint: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    baseUrl: 'https://api.openai.com/v1',
    // OpenAI prefers a strict json_schema; we retry without it if rejected.
    jsonMode: 'schema',
    extraBody: {},
    price: { in: 0.1, out: 0.5 },
    models: [
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', tier: 'fast', note: 'default' },
      { id: 'gpt-4o', label: 'GPT-4o', tier: 'quality' },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', tier: 'fast' },
      { id: 'gpt-4.1', label: 'GPT-4.1', tier: 'quality' },
    ],
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export function providerMeta(id) {
  return PROVIDERS[id] || PROVIDERS.deepseek;
}

export function defaultModel(providerId) {
  const p = providerMeta(providerId);
  return p.models[0].id;
}

/* Model ids we'd reach for first, in order, when we have to choose from a live
   list. Anything newer than this list still gets offered; this only decides
   which one is picked automatically. */
const PREFERRED = {
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  openai: [
    'gpt-5-mini', 'gpt-5', 'gpt-4.1-mini', 'gpt-4.1',
    'gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo',
  ],
};

/* Not chat models: the /models endpoint returns everything the key can touch,
   and picking an embedding model would fail at the first request. */
const NOT_CHAT = /(embedding|tts|whisper|transcribe|dall-e|image|moderation|realtime|audio|search|sora|rerank)/i;

/** True for ids that can answer a chat completion. */
export function isChatModel(id) {
  return typeof id === 'string' && !!id && !NOT_CHAT.test(id);
}

/** "gpt-4.1-mini" -> "GPT-4.1 mini"; unknown ids are shown as they are. */
export function modelLabel(id) {
  const raw = String(id || '');
  const known = Object.values(PROVIDERS)
    .flatMap((p) => p.models)
    .find((m) => m.id === raw);
  if (known) return known.label;
  const gpt = raw.match(/^gpt-([\d.]+)(?:-([a-z]+))?$/i);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ' ' + gpt[2] : ''}`;
  const ds = raw.match(/^deepseek-([a-z]+)$/i);
  if (ds) return `DeepSeek ${ds[1].charAt(0).toUpperCase()}${ds[1].slice(1)}`;
  return raw;
}

/** The model to use when the saved one is unknown or unavailable. */
export function pickModel(providerId, ids) {
  const list = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id && !NOT_CHAT.test(id));
  if (!list.length) return '';
  const preferred = PREFERRED[providerId] || [];
  for (const want of preferred) {
    if (list.includes(want)) return want;
  }
  /* Otherwise respect the provider's own ordering but skip previews/aliases. */
  const stable = list.filter((id) => !/(preview|beta|alpha|latest)/i.test(id));
  return (stable[0] || list[0]);
}

/** Rough $ estimate for the usage footer. */
export function estimateCost(providerId, tokensIn = 0, tokensOut = 0) {
  const p = providerMeta(providerId);
  return (tokensIn / 1e6) * p.price.in + (tokensOut / 1e6) * p.price.out;
}

export class ProviderError extends Error {
  constructor(code, message, detail) {
    super(message || code);
    this.name = 'ProviderError';
    this.code = code;
    this.detail = detail || null;
  }
}

// ── request plumbing ───────────────────────────────────────────────────────

const TIMEOUT_MS = 15000;

function controllerFor(signal, ms) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, ms);
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctl.signal,
    wasTimeout: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

async function request({ providerId, apiKey, path, body, method = 'POST', signal }) {
  const meta = providerMeta(providerId);
  if (!apiKey) throw new ProviderError('NO_KEY', 'No API key set.');

  const ctl = controllerFor(signal, TIMEOUT_MS);
  let res;
  try {
    res = await fetch(meta.baseUrl + path, {
      method,
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    if (signal?.aborted) throw new ProviderError('ABORTED', 'Cancelled.');
    if (ctl.wasTimeout()) throw new ProviderError('TIMEOUT', 'The model took too long to answer.');
    throw new ProviderError('NETWORK', 'Could not reach the provider. Check your connection.');
  } finally {
    ctl.cleanup();
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const msg = payload?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError('INVALID_KEY', 'That API key was rejected.', msg);
    }
    if (res.status === 429) {
      throw new ProviderError('RATE_LIMIT', 'Rate limit hit. Try again in a moment.', msg);
    }
    if (res.status === 404 || /model/i.test(msg) && res.status === 400) {
      throw new ProviderError('MODEL', 'That model is not available on this key.', msg);
    }
    if (res.status >= 500) {
      throw new ProviderError('SERVER', 'The provider is having trouble.', msg);
    }
    throw new ProviderError('REQUEST', 'The request was rejected.', msg);
  }

  return payload;
}

// ── response parsing ───────────────────────────────────────────────────────

const EDIT_TYPES = ['spelling', 'grammar', 'clarity', 'tone', 'punctuation'];

function stripFences(s) {
  return String(s || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

function parseEnvelope(content) {
  const raw = stripFences(content);
  if (!raw) return null;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  const corrected =
    typeof obj?.corrected === 'string' ? obj.corrected
      : typeof obj?.text === 'string' ? obj.text
        : null;
  if (corrected === null) return null;

  const edits = Array.isArray(obj?.edits)
    ? obj.edits
        .filter((e) => e && typeof e.before === 'string' && typeof e.after === 'string')
        .map((e) => ({
          type: EDIT_TYPES.includes(e.type) ? e.type : 'other',
          before: e.before,
          after: e.after,
        }))
        .slice(0, 60)
    : [];

  return { corrected, edits };
}

function jsonSchemaFormat() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'writewise_correction',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['corrected', 'edits'],
        properties: {
          corrected: { type: 'string' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'before', 'after'],
              properties: {
                type: { type: 'string', enum: EDIT_TYPES },
                before: { type: 'string' },
                after: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
}

function bodyFor({ meta, model, messages, maxTokens, withJson }) {
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    ...meta.extraBody,
  };
  // DeepSeek ignores temperature in thinking mode but accepts it; OpenAI
  // accepts it. Keep it deterministic where it counts.
  body.temperature = 0;
  if (withJson) {
    body.response_format = meta.jsonMode === 'schema' ? jsonSchemaFormat() : { type: 'json_object' };
  }
  return body;
}

function usageOf(payload) {
  const u = payload?.usage || {};
  return {
    tokensIn: Number(u.prompt_tokens || u.input_tokens || 0),
    tokensOut: Number(u.completion_tokens || u.output_tokens || 0),
  };
}

/**
 * Analyze one field's text.
 * Returns { corrected, edits, changed, usage, ms, model }.
 * Throws ProviderError with a stable `code`.
 */
export async function analyze({ providerId, apiKey, model, text, fixes, tonePreset, signal }) {
  const meta = providerMeta(providerId);
  const chosenModel = model || defaultModel(providerId);
  const messages = buildMessages({ text, fixes, tonePreset });

  const maxTokens = Math.min(2048, Math.ceil(text.length / 3) + 120);
  const started = Date.now();

  const attemptOnce = async (withJson) => {
    const payload = await request({
      providerId,
      apiKey,
      path: '/chat/completions',
      body: bodyFor({ meta, model: chosenModel, messages, maxTokens, withJson }),
      signal,
    });

    const choice = payload?.choices?.[0];
    const finish = choice?.finish_reason || '';
    if (finish === 'length') {
      throw new ProviderError(
        'TRUNCATED',
        'The answer was cut off before it finished.',
        'Try a shorter selection.',
      );
    }
    const content = choice?.message?.content;
    const usage = usageOf(payload);
    return { content, usage };
  };

  // One short retry on the two failure modes that are usually transient.
  const attempt = async (withJson) => {
    try {
      return await attemptOnce(withJson);
    } catch (err) {
      if ((err.code === 'RATE_LIMIT' || err.code === 'SERVER') && !signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        if (!signal?.aborted) return attemptOnce(withJson);
      }
      throw err;
    }
  };

  let parsed = null;
  let usage = { tokensIn: 0, tokensOut: 0 };

  // 1) structured attempt
  try {
    const first = await attempt(true);
    usage = first.usage;
    parsed = parseEnvelope(first.content);
    if (!parsed && first.content && !first.content.trim().startsWith('{')) {
      // Provider ignored the format and returned prose — treat as the fix.
      parsed = { corrected: stripFences(first.content), edits: [] };
    }
  } catch (err) {
    // A provider that rejects response_format is not a failed check.
    if (err.code === 'REQUEST' || err.code === 'SERVER') {
      parsed = null;
    } else {
      throw err;
    }
  }

  // 2) one plain-text retry (covers empty content + rejected format)
  if (!parsed) {
    try {
      const second = await attempt(false);
      usage = second.usage;
      parsed = parseEnvelope(second.content) || {
        corrected: stripFences(second.content) || '',
        edits: [],
      };
    } catch (err) {
      if (err.code === 'REQUEST') {
        throw new ProviderError('PARSE', 'The model answered in an unexpected shape.');
      }
      throw err;
    }
  }

  const corrected = String(parsed.corrected ?? '');
  if (!corrected) {
    throw new ProviderError('PARSE', 'The model returned an empty answer.');
  }

  return {
    corrected,
    edits: parsed.edits,
    changed: corrected.trim() !== text.trim(),
    usage,
    ms: Date.now() - started,
    model: chosenModel,
    providerId,
  };
}

/** Validate a key and return the models it can see. */
export async function listModels({ providerId, apiKey }) {
  const payload = await request({
    providerId,
    apiKey,
    path: '/models',
    method: 'GET',
  });
  const ids = Array.isArray(payload?.data)
    ? payload.data.map((m) => m?.id).filter(Boolean)
    : [];
  return ids;
}

// ── translation ────────────────────────────────────────────────────────────

function parseTranslation(content) {
  const raw = stripFences(content);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    const translation = typeof obj?.translation === 'string' ? obj.translation
      : typeof obj?.text === 'string' ? obj.text
        : null;
    if (!translation) return null;
    const source = typeof obj?.source_language === 'string' ? obj.source_language
      : typeof obj?.sourceLanguage === 'string' ? obj.sourceLanguage
        : '';
    return { translation, sourceLanguage: source };
  } catch {
    return null;
  }
}

/**
 * Translate one fragment. Same transport and error taxonomy as analyze();
 * only the prompt and the response shape differ.
 * Returns { translation, sourceLanguage, usage, ms, model, providerId }.
 */
export async function translate({ providerId, apiKey, model, text, targetLabel, signal }) {
  const meta = providerMeta(providerId);
  const chosenModel = model || defaultModel(providerId);
  const messages = buildTranslateMessages({ text, targetLabel });
  // A translation is roughly as long as its source, plus JSON overhead.
  const maxTokens = Math.min(2048, Math.ceil(text.length / 2) + 220);
  const started = Date.now();

  const attemptOnce = async (withJson) => {
    const payload = await request({
      providerId,
      apiKey,
      path: '/chat/completions',
      body: bodyFor({ meta, model: chosenModel, messages, maxTokens, withJson }),
      signal,
    });
    const choice = payload?.choices?.[0];
    const finish = choice?.finish_reason || '';
    if (finish === 'length') {
      throw new ProviderError(
        'TRUNCATED',
        'The translation was cut off before it finished.',
        'Select a shorter piece of text.',
      );
    }
    return { content: choice?.message?.content, usage: usageOf(payload) };
  };

  const attempt = async (withJson) => {
    try {
      return await attemptOnce(withJson);
    } catch (err) {
      if ((err.code === 'RATE_LIMIT' || err.code === 'SERVER') && !signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        if (!signal?.aborted) return attemptOnce(withJson);
      }
      throw err;
    }
  };

  let parsed = null;
  let usage = { tokensIn: 0, tokensOut: 0 };

  try {
    const first = await attempt(true);
    usage = first.usage;
    parsed = parseTranslation(first.content);
    if (!parsed && first.content && !first.content.trim().startsWith('{')) {
      parsed = { translation: stripFences(first.content), sourceLanguage: '' };
    }
  } catch (err) {
    if (err.code === 'REQUEST' || err.code === 'SERVER') {
      parsed = null;
    } else {
      throw err;
    }
  }

  if (!parsed) {
    try {
      const second = await attempt(false);
      usage = second.usage;
      parsed = parseTranslation(second.content) || {
        translation: stripFences(second.content) || '',
        sourceLanguage: '',
      };
    } catch (err) {
      if (err.code === 'REQUEST') {
        throw new ProviderError('PARSE', 'The model answered in an unexpected shape.');
      }
      throw err;
    }
  }

  if (!parsed.translation) {
    throw new ProviderError('PARSE', 'The model returned an empty translation.');
  }

  return {
    translation: parsed.translation,
    sourceLanguage: parsed.sourceLanguage,
    usage,
    ms: Date.now() - started,
    model: chosenModel,
    providerId,
  };
}
