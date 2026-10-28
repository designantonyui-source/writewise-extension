/**
 * Background service worker.
 *
 * Owns every network call (so the content script never holds a key) and the
 * settings read/write path. The content script talks to it with these
 * messages: ANALYZE, CANCEL, BUMP_STATS, GET_ACTIVE_INFO, OPEN_SETTINGS.
 */

import { analyze, translate, listModels, providerMeta, estimateCost } from './src/providers.js';
import { getSettings, bumpStats, migrateLegacy } from './src/storage.js';
import {
  codeForLanguageName,
  codeFromLabel,
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
  const targetLabel = languagePromptLabel(targetCode);
  const id = String(msg.id || crypto.randomUUID());
  const ctl = new AbortController();
  inflight.set(id, { ctl, tabId: sender.tab?.id });

  try {
    const result = await translate({
      providerId,
      apiKey,
      model,
      text,
      targetLabel,
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
    const meta = providerMeta(providerId);
    const preferred = meta.models[0].id;
    const models = ids
      .map((id) => {
        const known = meta.models.find((m) => m.id === id);
        return { id, label: known?.label || id, tier: known?.tier || 'other' };
      })
      .sort((a, b) => (b.id === preferred) - (a.id === preferred));
    respond({ ok: true, models });
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
