/**
 * Background service worker.
 *
 * Owns every network call (so the content script never holds a key) and the
 * settings read/write path. The content script talks to it with these
 * messages: ANALYZE, CANCEL, BUMP_STATS, GET_ACTIVE_INFO, OPEN_SETTINGS.
 */

import {
  analyze,
  translate,
  listModels,
  providerMeta,
  estimateCost,
  isChatModel,
  modelLabel,
  pickModel,
} from './src/providers.js';
import { getSettings, bumpStats, migrateLegacy } from './src/storage.js';
import {
  codeForLanguageName,
  codeFromLabel,
  languageDisplayLabel,
  languagePromptLabel,
  resolveTarget,
} from './src/languages.js';
import { saveWord as saveVocabWord } from './src/vocab.js';

const MAX_TRANSLATE_CHARS = 2400;

/** id → { ctl: AbortController, tabId } */
const inflight = new Map();

// ── install / context menu / shortcut ─────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  void migrateLegacy();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'ww-fix-selection',
      title: 'Fix selection with WriteWise',
      contexts: ['editable'],
    });
    chrome.contextMenus.create({
      id: 'ww-translate-selection',
      title: 'Translate selection with WriteWise',
      contexts: ['selection', 'editable'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const type = info.menuItemId === 'ww-fix-selection' ? 'FIX_SELECTION'
    : info.menuItemId === 'ww-translate-selection' ? 'TRANSLATE_SELECTION'
      : null;
  if (!type) return;
  chrome.tabs.sendMessage(tab.id, { type }).catch(() => {});
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'check-field' || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'CHECK_FIELD' }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [id, entry] of inflight) {
    if (entry.tabId === tabId) {
      entry.ctl.abort();
      inflight.delete(id);
    }
  }
});

// ── messages ───────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  switch (msg?.type) {
    case 'ANALYZE':
      void onAnalyze(msg, sender, respond);
      return true;
    case 'CANCEL':
      onCancel(msg, sender);
      respond({ ok: true });
      return false;
    case 'TRANSLATE':
      void onTranslate(msg, sender, respond);
      return true;
    case 'MODELS':
      void onModels(msg, respond);
      return true;
    case 'GET_ACTIVE_INFO':
      void onActiveInfo(respond);
      return true;
    case 'SAVE_WORD':
      void onSaveWord(msg, respond);
      return true;
    case 'OPEN_VOCAB':
      chrome.tabs
        .create({ url: chrome.runtime.getURL('vocab/vocab.html') })
        .then(() => respond({ ok: true }))
        .catch(() => respond({ ok: false }));
      return true;
    case 'BUMP_STATS':
      void bumpStats({ fixes: Number(msg.fixes) || 0 }).then(() => respond({ ok: true }));
      return true;
    case 'SPEAK':
      void onSpeak(msg, respond);
      return true;
    case 'OPEN_SETTINGS':
      chrome.tabs
        .create({ url: chrome.runtime.getURL('popup/popup.html') })
        .then(() => respond({ ok: true }))
        .catch(() => respond({ ok: false }));
      return true;
    default:
      respond({ ok: false, error: { code: 'UNKNOWN', message: 'Unknown message.' } });
      return false;
  }
});

/* ── pronunciation ─────────────────────────────────────────────────────────
   Optional neural voice. The content script asks; the key stays here; the
   result is cached per voice+text so a second click on the same word is free
   and instant. Any failure returns `{ ok:false }` and the caller falls back to
   the OS voice, so pronunciation never becomes a button that does nothing. */

const TTS_MODEL = 'gpt-4o-mini-tts';
const TTS_VOICES = new Set(['nova', 'shimmer', 'alloy', 'echo', 'onyx', 'fable']);
const TTS_MAX_CHARS = 300;
const TTS_CACHE_LIMIT = 48;
const ttsCache = new Map();

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function onSpeak(msg, respond) {
  const text = String(msg?.text || '').replace(/\s+/g, ' ').trim().slice(0, TTS_MAX_CHARS);
  if (!text) {
    respond({ ok: false, code: 'EMPTY' });
    return;
  }

  const settings = await getSettings();
  if (settings.speech.premium !== true) {
    respond({ ok: false, code: 'OFF' });
    return;
  }
  const apiKey = String(settings.keys.openai || '').trim();
  if (!apiKey) {
    respond({ ok: false, code: 'NO_KEY' });
    return;
  }

  const voice = TTS_VOICES.has(settings.speech.voice) ? settings.speech.voice : 'nova';
  const cacheKey = voice + '\u0000' + text;
  const cached = ttsCache.get(cacheKey);
  if (cached) {
    respond({ ok: true, audio: cached, mime: 'audio/mpeg', cached: true });
    return;
  }

  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice,
        input: text,
        response_format: 'mp3',
        instructions: 'Pronounce this clearly and naturally, like a patient language teacher. Do not add words of your own.',
      }),
    });

    if (!res.ok) {
      const code = res.status === 401 || res.status === 403 ? 'BAD_KEY'
        : res.status === 429 ? 'RATE'
          : 'FAILED';
      respond({ ok: false, code, status: res.status });
      return;
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) {
      respond({ ok: false, code: 'EMPTY_AUDIO' });
      return;
    }
    const audio = bytesToBase64(bytes);
    if (ttsCache.size >= TTS_CACHE_LIMIT) ttsCache.delete(ttsCache.keys().next().value);
    ttsCache.set(cacheKey, audio);
    respond({ ok: true, audio, mime: 'audio/mpeg' });
  } catch {
    respond({ ok: false, code: 'NETWORK' });
  }
}

async function onAnalyze(msg, sender, respond) {
  const settings = await getSettings();
  const providerId = msg.provider || settings.provider;
  const meta = providerMeta(providerId);
  const apiKey = String(settings.keys[providerId] || '').trim();
  const model = msg.model || settings.models[providerId];

  if (!apiKey) {
    respond({
      ok: false,
      error: { code: 'NO_KEY', message: `No ${meta.label} API key set.` },
    });
    return;
  }

  const id = String(msg.id || crypto.randomUUID());
  const ctl = new AbortController();
  inflight.set(id, { ctl, tabId: sender.tab?.id });

  try {
    const result = await analyze({
      providerId,
      apiKey,
      model,
      text: String(msg.text || ''),
      fixes: Array.isArray(msg.fixes) ? msg.fixes : [],
      tonePreset: msg.tonePreset || '',
      signal: ctl.signal,
    });

    const { tokensIn, tokensOut } = result.usage;
    if (tokensIn || tokensOut) {
      await bumpStats({
        tokensIn,
        tokensOut,
        costUsd: estimateCost(providerId, tokensIn, tokensOut),
      });
    }

    respond({
      ok: true,
      result: {
        corrected: result.corrected,
        edits: result.edits,
        changed: result.changed,
        ms: result.ms,
        model: result.model,
        provider: providerId,
        providerLabel: meta.label,
      },
    });
  } catch (err) {
    respond({
      ok: false,
      error: {
        code: err?.code || 'ERROR',
        message: err?.message || 'Something went wrong.',
        detail: err?.detail || null,
      },
    });
  } finally {
    inflight.delete(id);
  }
}

function onCancel(msg, sender) {
  const id = String(msg.id || '');
  const entry = inflight.get(id);
  if (!entry) return;
  if (entry.tabId !== undefined && sender.tab?.id !== undefined && entry.tabId !== sender.tab.id) {
    return;
  }
  entry.ctl.abort();
  inflight.delete(id);
}

async function onTranslate(msg, sender, respond) {
  const settings = await getSettings();
  const providerId = msg.provider || settings.provider;
  const meta = providerMeta(providerId);
  const apiKey = String(settings.keys[providerId] || '').trim();
  const model = msg.model || settings.models[providerId];
  const text = String(msg.text || '').trim();

  if (!apiKey) {
    respond({ ok: false, error: { code: 'NO_KEY', message: `No ${meta.label} API key set.` } });
    return;
  }
  if (!text) {
    respond({ ok: false, error: { code: 'EMPTY', message: 'Nothing selected.' } });
    return;
  }
  if (text.length > MAX_TRANSLATE_CHARS) {
    respond({
      ok: false,
      error: {
        code: 'TOO_LONG',
        message: `Select at most ${MAX_TRANSLATE_CHARS} characters to translate.`,
        detail: `${text.length} characters selected`,
      },
    });
    return;
  }

  const targetCode = resolveTarget(settings);
  const targetLabel = languageDisplayLabel(targetCode); // what the card shows
  const promptTarget = languagePromptLabel(targetCode); // "Polski (pl)" for the model
  const id = String(msg.id || crypto.randomUUID());
  const ctl = new AbortController();
  inflight.set(id, { ctl, tabId: sender.tab?.id });

  try {
    const result = await translate({
      providerId,
      apiKey,
      model,
      text,
      targetLabel: promptTarget,
      signal: ctl.signal,
    });

    const { tokensIn, tokensOut } = result.usage;
    if (tokensIn || tokensOut) {
      await bumpStats({
        tokensIn,
        tokensOut,
        costUsd: estimateCost(providerId, tokensIn, tokensOut),
      });
    }

    respond({
      ok: true,
      result: {
        translation: result.translation,
        sourceLanguage: result.sourceLanguage,
        sourceCode: codeForLanguageName(result.sourceLanguage),
        targetCode,
        targetLabel,
        ms: result.ms,
        model: result.model,
        provider: providerId,
        providerLabel: meta.label,
      },
    });
  } catch (err) {
    respond({
      ok: false,
      error: {
        code: err?.code || 'ERROR',
        message: err?.message || 'Translation failed.',
        detail: err?.detail || null,
      },
    });
  } finally {
    inflight.delete(id);
  }
}

async function onSaveWord(msg, respond) {
  try {
    const result = await saveVocabWord({
      word: msg.word,
      translation: msg.translation,
      source: msg.source,
      sourceCode: msg.sourceCode || codeForLanguageName(msg.source),
      target: msg.target,
      targetCode: msg.targetCode || codeFromLabel(msg.target),
      context: msg.context,
      host: msg.host,
    });
    respond(result);
  } catch {
    respond({ ok: false, error: 'SAVE_FAILED' });
  }
}

async function onModels(msg, respond) {
  const apiKey = String(msg.apiKey || '').trim();
  const providerId = msg.provider;
  if (!apiKey) {
    respond({ ok: false, error: { code: 'NO_KEY', message: 'Enter a key first.' } });
    return;
  }
  try {
    const ids = await listModels({ providerId, apiKey });
    const best = pickModel(providerId, ids);
    const models = ids
      .filter(isChatModel)
      .map((id) => ({ id, label: modelLabel(id) }))
      .sort((a, b) => (b.id === best) - (a.id === best));
    respond({ ok: true, models, defaultId: best });
  } catch (err) {
    respond({
      ok: false,
      error: {
        code: err?.code || 'ERROR',
        message: err?.message || 'Could not reach the provider.',
      },
    });
  }
}

async function onActiveInfo(respond) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      respond({ ok: false });
      return;
    }
    try {
      const info = await chrome.tabs.sendMessage(tab.id, { type: 'GET_INFO' });
      if (info?.host) {
        respond({ ok: true, host: info.host, supported: true });
        return;
      }
    } catch {
      // No content script here (chrome://, web store, PDF viewer…).
    }
    const url = tab.url || '';
    if (!/^https?:/i.test(url)) {
      // chrome://, the extension's own pages, the web store, PDF viewer…
      respond({ ok: true, host: '', supported: false, restricted: true });
      return;
    }
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      host = '';
    }
    respond({ ok: true, host, supported: !!host });
  } catch {
    respond({ ok: false });
  }
}
