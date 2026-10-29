/**
 * Content controller.
 *
 * Watches the focused field, debounces a check, renders the card through
 * window.__wwUI, and writes accepted text back without breaking the host
 * page's undo stack.
 *
 * Classic script (no imports) — MV3 content scripts cannot use ES modules.
 */
(() => {
  'use strict';

  if (window.__wwLoaded) return;
  window.__wwLoaded = true;

  const UI = window.__wwUI;
  if (!UI || typeof UI.show !== 'function') return;

  const PROVIDER_LABEL = { deepseek: 'DeepSeek', openai: 'OpenAI' };
  const MIN_SELECTION_CHARS = 4;
  const MAX_DIFF_CELLS = 400000;
  const CLEAN_HIDE_MS = 2200;

  /** @type {ReturnType<typeof readSettings> | null} */
  let settings = null;
  /** @type {{el: Element, adapter: any} | null} */
  let current = null;
  let lastField = null;

  let debounceTimer = 0;
  let autoHideTimer = 0;
  let inflight = null; // { id }
  let runId = 0;
  let composing = false;
  let nagged = false;

  /** @type {{text: string, corrected: string, changed: boolean, ms: number, model: string} | null} */
  let lastResult = null;
  /** @type {{kind: 'value', start: number, end: number} | {kind: 'range', range: Range} | null} */
  let pendingSelection = null;

  let appliedEl = null;
  let appliedBefore = null;

  // translation
  let translateTimer = 0;
  let translateToken = 0;
  let lastTranslate = { text: '', at: 0 };
  let lastTranslation = null; // { translation, sourceLanguage, targetLabel, ms, canReplace, anchor, range }
  let translateField = null; // { el, start, end } when the selection lives in a field

  // ── settings ─────────────────────────────────────────────────────────────

  async function readSettings() {
    const got = await chrome.storage.local.get('ww_settings');
    const s = got.ww_settings || {};
    const provider = s.provider === 'openai' ? 'openai' : 'deepseek';
    const fix = s.fix || {};
    return {
      provider,
      hasKey: !!(s.keys && String(s.keys[provider] || '').trim()),
      enabled: s.enabled !== false,
      autoCheck: s.autoCheck !== false,
      delayMs: clamp(Number(s.delayMs) || 900, 400, 3000),
      minChars: clamp(Number(s.minChars) || 24, 1, 400),
      maxWords: clamp(Number(s.maxWords) || 250, 10, 2000),
      fix: {
        spelling: fix.spelling !== false,
        grammar: fix.grammar !== false,
        clarity: fix.clarity !== false,
        tone: fix.tone !== false,
      },
      tonePreset: s.tonePreset || '',
      translate: {
        enabled: s.translate?.enabled !== false,
        onSelect: s.translate?.onSelect !== false,
      },
      pausedSites: Array.isArray(s.pausedSites) ? s.pausedSites : [],
      theme: ['system', 'dark', 'light'].includes(s.theme) ? s.theme : 'system',
    };
  }

  const clamp = (n, min, max) => Math.min(max, Math.max(min, Math.round(n)));

  function fixList() {
    const f = settings?.fix || {};
    return ['spelling', 'grammar', 'clarity', 'tone'].filter((k) => f[k]);
  }

  const hostOf = () => location.hostname.replace(/^www\./, '');
  const isPausedSite = () => {
    const host = location.hostname;
    const bare = hostOf();
    const list = settings?.pausedSites || [];
    return list.includes(host) || list.includes(bare);
  };

  // ── field adapters ───────────────────────────────────────────────────────

  const BLOCKED_AUTOCOMPLETE = /(^|\s)(cc-|one-time-code|current-password|new-password)/i;

  function isEligible(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.__writewiseIgnore) return false;
    if (el.disabled || el.readOnly) return false;
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const type = String(el.type || 'text').toLowerCase();
      if (!['text', 'search', 'email', 'url', 'tel'].includes(type)) return false;
      if (BLOCKED_AUTOCOMPLETE.test(el.getAttribute('autocomplete') || '')) return false;
      return true;
    }
    if (tag === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function adapterFor(el) {
    if (el.isContentEditable) {
      return {
        kind: 'contenteditable',
        get: () => el.innerText || '',
        set: (text) => {
          el.focus({ preventScroll: true });
          const sel = window.getSelection();
          if (!sel) {
            el.innerText = text;
            return;
          }
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
          let ok = false;
          try {
            ok = document.execCommand('insertText', false, text);
          } catch {
            ok = false;
          }
          if (!ok) {
            el.innerText = text;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          }
        },
      };
    }

    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    return {
      kind: 'value',
      get: () => el.value || '',
      set: (text) => {
        if (setter) setter.call(el, text);
        else el.value = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }));
      },
    };
  }

  /** Run a write without letting our own input event re-trigger a check. */
  function withGuard(el, fn) {
    el.__wwApplying = true;
    try {
      fn();
    } finally {
      setTimeout(() => {
        try {
          el.__wwApplying = false;
        } catch {
          /* element may be gone */
        }
      }, 0);
    }
  }

  // ── diff ─────────────────────────────────────────────────────────────────

  const isSpace = (s) => /^\s+$/.test(s);

  function tokenizeDiff(before, after) {
    if (before === after) return { tokens: [{ t: 'text', v: before }], changes: 0 };

    const a = before.split(/(\s+)/);
    const b = after.split(/(\s+)/);
    const n = a.length;
    const m = b.length;

    // Local edits dominate; a full LCS on very long text would be wasteful.
    if (n * m > MAX_DIFF_CELLS) {
      const tokens = [{ t: 'del', v: before }, { t: 'ins', v: after }];
      return { tokens, changes: 1 };
    }

    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }

    const raw = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        raw.push({ t: 'text', v: a[i] });
        i++;
        j++;
      } else if (j < m && (i >= n || dp[i + 1][j] <= dp[i][j + 1])) {
        raw.push({ t: isSpace(b[j]) ? 'text' : 'ins', v: b[j] });
        j++;
      } else {
        raw.push({ t: isSpace(a[i]) ? 'text' : 'del', v: a[i] });
        i++;
      }
    }

    // Merge runs + count change hunks.
    const tokens = [];
    let changes = 0;
    let inHunk = false;
    for (const tok of raw) {
      if (!tok.v) continue;
      const last = tokens[tokens.length - 1];
      if (last && last.t === tok.t) last.v += tok.v;
      else tokens.push({ ...tok });

      if (tok.t === 'text') {
        inHunk = false;
      } else if (!inHunk) {
        inHunk = true;
        changes++;
      }
    }
    return { tokens, changes };
  }

  // ── messaging ────────────────────────────────────────────────────────────

  function send(msg) {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime?.id) {
          resolve({ ok: false, error: { code: 'CONTEXT', message: 'Extension reloaded — refresh the page.' } });
          return;
        }
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            resolve({
              ok: false,
              error: { code: 'CONTEXT', message: chrome.runtime.lastError.message || 'No response.' },
            });
            return;
          }
          resolve(res || { ok: false, error: { code: 'EMPTY', message: 'No response from the extension.' } });
        });
      } catch {
        resolve({ ok: false, error: { code: 'CONTEXT', message: 'Extension reloaded — refresh the page.' } });
      }
    });
  }

  function cancelInflight() {
    if (!inflight) return;
    const id = inflight.id;
    inflight = null;
    void send({ type: 'CANCEL', id });
  }

  // ── the check ────────────────────────────────────────────────────────────

  function runTokenIsCurrent(token) {
    return token === runId;
  }

  async function runCheck(el, text, token) {
    if (!el.isConnected || !runTokenIsCurrent(token)) return;
    cancelInflight();

    const id = `ww:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`;
    inflight = { id };
    clearTimeout(autoHideTimer);
    UI.show(el, 'checking', { provider: PROVIDER_LABEL[settings.provider] || 'AI' });

    const res = await send({
      type: 'ANALYZE',
      id,
      text,
      fixes: fixList(),
      tonePreset: settings.fix.tone ? settings.tonePreset : '',
    });

    if (!runTokenIsCurrent(token) || !el.isConnected) return;
    if (inflight && inflight.id === id) inflight = null;

    if (!res?.ok) {
      renderError(el, res?.error);
      return;
    }

    const r = res.result;
    lastResult = { text, corrected: r.corrected, changed: !!r.changed, ms: r.ms, model: r.model };

    if (!r.changed) {
      UI.show(el, 'clean', {
        provider: r.providerLabel,
        model: shortModel(r.model),
        ms: r.ms,
      });
      autoHideTimer = setTimeout(() => UI.hide(), CLEAN_HIDE_MS);
      return;
    }

    const { tokens, changes } = tokenizeDiff(text, r.corrected);
    UI.show(el, 'suggestion', {
      provider: r.providerLabel,
      model: shortModel(r.model),
      diff: tokens,
      changes,
      ms: r.ms,
    });
  }

  function shortModel(model) {
    const id = String(model || '').trim();
    if (!id) return '';
    const gpt = id.match(/^gpt-([\d.]+)(?:-([a-z]+))?$/i);
    if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ' ' + gpt[2] : ''}`;
    const ds = id.match(/^deepseek-([a-z]+)$/i);
    if (ds) return `DeepSeek ${ds[1].charAt(0).toUpperCase()}${ds[1].slice(1)}`;
    return id;
  }

  function renderError(el, error) {
    const code = error?.code || 'ERROR';
    const map = {
      NO_KEY: {
        state: 'setup',
        title: 'Add a key to start',
        body: 'WriteWise checks your writing with your own DeepSeek or OpenAI key. It stays on this device.',
        action: { id: 'open-settings', label: 'Add key' },
      },
      INVALID_KEY: {
        state: 'error',
        title: 'Key rejected',
        body: 'The provider refused that key. Check it in settings.',
        action: { id: 'open-settings', label: 'Open settings' },
      },
      RATE_LIMIT: {
        state: 'error',
        title: 'Rate limited',
        body: 'You have hit the provider limit. Give it a moment.',
        action: { id: 'retry', label: 'Try again' },
      },
      TIMEOUT: {
        state: 'error',
        title: 'Took too long',
        body: 'The model did not answer in time.',
        action: { id: 'retry', label: 'Try again' },
      },
      NETWORK: {
        state: 'error',
        title: 'No connection',
        body: 'Could not reach the provider. Check your network.',
        action: { id: 'retry', label: 'Try again' },
      },
      TRUNCATED: {
        state: 'error',
        title: 'Too long for one pass',
        body: 'Select a smaller part of the text and use “Fix selection”.',
        action: null,
      },
      MODEL: {
        state: 'error',
        title: 'Model unavailable',
        body: 'That model is not enabled for this key. Pick another in settings.',
        action: { id: 'open-settings', label: 'Change model' },
      },
      CONTEXT: {
        state: 'error',
        title: 'Reload this page',
        body: 'WriteWise was updated or reloaded while this page was open.',
        action: null,
      },
    };

    const view = map[code] || {
      state: 'error',
      title: 'Could not check',
      body: error?.message || 'Something went wrong.',
      action: { id: 'retry', label: 'Try again' },
    };
    UI.show(el, view.state, { title: view.title, body: view.body, action: view.action });
  }

  // ── events ───────────────────────────────────────────────────────────────

  function onInput(e) {
    if (!settings) return;
    const el = e.target;
    if (!isEligible(el) || el.__wwApplying) return;
    if (e.isComposing || composing) return;

    lastField = el;

    if (!settings.enabled || isPausedSite()) {
      UI.hide();
      return;
    }

    current = { el, adapter: adapterFor(el) };
    pendingSelection = null;
    lastResult = null;
    ++runId;
    cancelInflight();
    clearTimeout(debounceTimer);
    clearTimeout(autoHideTimer);
    UI.hide();

    const text = (current.adapter.get() || '').trim();

    if (!settings.hasKey) {
      if (!nagged && text.length >= settings.minChars) {
        nagged = true;
        renderError(el, { code: 'NO_KEY' });
      }
      return;
    }

    if (!settings.autoCheck) return;
    if (text.length < settings.minChars) return;
    if (wordCount(text) > settings.maxWords) return;

    const token = runId;
    debounceTimer = setTimeout(() => {
      void runCheck(el, text, token);
    }, settings.delayMs);
  }

  const wordCount = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0);

  function onFocusIn(e) {
    if (!isEligible(e.target)) return;
    lastField = e.target;
  }

  function onCompositionStart() {
    composing = true;
  }

  function onCompositionEnd(e) {
    composing = false;
    if (settings) onInput({ target: e.target, isComposing: false });
  }

  // ── translation ──────────────────────────────────────────────────────────

  const AUTO_TRANSLATE_CHARS = 240;

  function closestEditable(node) {
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    while (el) {
      if (el.isContentEditable) return el;
      el = el.parentElement;
    }
    return null;
  }

  function isOurs(target) {
    const host = document.getElementById('__ww-host');
    return !!host && target === host;
  }

  /** What the user has selected right now, or null. */
  function selectionContext() {
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') && isEligible(active)) {
      const start = active.selectionStart ?? 0;
      const end = active.selectionEnd ?? 0;
      if (end - start > 0) {
        return { text: active.value.slice(start, end), field: active, start, end };
      }
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const text = sel.toString();
    if (!text.trim()) return null;
    const range = sel.getRangeAt(0).cloneRange();
    return { text, range, editable: closestEditable(range.commonAncestorContainer) };
  }

  function anchorFor(context) {
    if (context.field) {
      return {
        getBoundingClientRect: () => {
          try {
            return context.field.getBoundingClientRect();
          } catch {
            return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
          }
        },
        get isConnected() {
          return !!(context.field && context.field.isConnected);
        },
      };
    }
    const range = context.range;
    return {
      getBoundingClientRect: () => {
        try {
          return range.getBoundingClientRect();
        } catch {
          return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
        }
      },
      get isConnected() {
        return !!(range && range.startContainer && range.startContainer.isConnected);
      },
    };
  }

  function renderTranslateError(anchor, error) {
    const code = error?.code || 'ERROR';
    const map = {
      NO_KEY: {
        title: 'Add a key to translate',
        body: 'Translation uses the same DeepSeek or OpenAI key as fixes. It stays on this device.',
        action: { id: 'open-settings', label: 'Add key' },
      },
      TOO_LONG: {
        title: 'Selection too long',
        body: error?.message || 'Select a shorter piece of text.',
        action: null,
      },
      EMPTY: { title: 'Nothing selected', body: 'Select some text first.', action: null },
      INVALID_KEY: {
        title: 'Key rejected',
        body: 'The provider refused that key. Check it in settings.',
        action: { id: 'open-settings', label: 'Open settings' },
      },
      RATE_LIMIT: {
        title: 'Rate limited',
        body: 'You have hit the provider limit. Give it a moment.',
        action: { id: 'retry', label: 'Try again' },
      },
      MODEL: {
        title: 'Model unavailable',
        body: 'That model is not enabled for this key. Pick another in settings.',
        action: { id: 'open-settings', label: 'Change model' },
      },
      TIMEOUT: { title: 'Took too long', body: 'The model did not answer in time.', action: { id: 'retry', label: 'Try again' } },
      NETWORK: { title: 'No connection', body: 'Could not reach the provider.', action: { id: 'retry', label: 'Try again' } },
      TRUNCATED: {
        title: 'Too long for one pass',
        body: 'Select a shorter piece of text and try again.',
        action: null,
      },
      CONTEXT: { title: 'Reload this page', body: 'WriteWise was reloaded while this page was open.', action: null },
    };
    const view = map[code] || {
      title: 'Could not translate',
      body: error?.message || 'Something went wrong.',
      action: { id: 'retry', label: 'Try again' },
    };
    UI.show(anchor, view.state || 'error', {
      title: view.title,
      body: view.body,
      action: view.action,
    });
  }

  function isWordLike(text) {
    const t = String(text || '').trim();
    if (!t || t.length > 48) return false;
    if (/[.!?…:]$/.test(t)) return false;
    if (/\s/.test(t) && t.split(/\s+/).length > 3) return false;
    if (/^https?:\/\//i.test(t)) return false;
    if (!/[A-Za-zÀ-ÿ\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF]/.test(t)) return false;
    return true;
  }

  function sentenceAround(full, index, length) {
    const text = String(full || '');
    const at = Math.max(0, Math.min(index, text.length));
    const before = text.slice(0, at);
    const after = text.slice(at + length);
    const starts = ['. ', '! ', '? ', '\n'].map((sep) => before.lastIndexOf(sep)).filter((i) => i >= 0);
    const begin = starts.length ? Math.max(...starts) + 1 : Math.max(0, at - 120);
    const ends = ['. ', '! ', '? ', '\n']
      .map((sep) => after.indexOf(sep))
      .filter((i) => i >= 0)
      .map((i) => i + 1);
    const end = ends.length ? Math.min(...ends) : Math.min(after.length, 120);
    return (before.slice(begin) + text.slice(at, at + length) + after.slice(0, end))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 280);
  }

  function contextAround(context) {
    const raw = String(context.text || '').trim();
    try {
      if (context.field) {
        const full = context.field.value || '';
        return sentenceAround(full, context.start, raw.length);
      }
      let node = context.range ? context.range.startContainer : null;
      let el = node && (node.nodeType === 1 ? node : node.parentElement);
      const block = el && el.closest ? el.closest('p,li,blockquote,td,th,figcaption,article,section,div') : null;
      const full = block ? block.innerText || block.textContent || '' : '';
      if (!full) return raw;
      const idx = full.indexOf(raw);
      if (idx !== -1) return sentenceAround(full, idx, raw.length);
      const flat = full.replace(/\s+/g, ' ');
      const flatRaw = raw.replace(/\s+/g, ' ');
      const idx2 = flat.indexOf(flatRaw);
      return idx2 === -1 ? raw : sentenceAround(flat, idx2, flatRaw.length);
    } catch {
      return raw;
    }
  }

  async function translateSelection({ force = false } = {}) {
    if (!settings || !settings.enabled) return;
    if (!settings.translate.enabled) return;

    const context = selectionContext();
    if (!context) return;

    const text = context.text.trim();
    if (!text) return;

    if (!force && text.length > AUTO_TRANSLATE_CHARS) return;

    const now = Date.now();
    if (text === lastTranslate.text && now - lastTranslate.at < 3000) return;
    lastTranslate = { text, at: now };

    const token = ++translateToken;
    const anchor = anchorFor(context);
    translateField = context.field ? { el: context.field, start: context.start, end: context.end } : null;

    UI.show(anchor, 'checking', {
      title: 'Translating…',
      provider: PROVIDER_LABEL[settings.provider] || 'AI',
    });

    const res = await send({ type: 'TRANSLATE', id: `wwtr:${now.toString(36)}`, text });
    if (token !== translateToken) return;

    if (!res?.ok) {
      renderTranslateError(anchor, res?.error);
      return;
    }

    const r = res.result;
    const canReplace = !!(context.field || context.editable);
    const canSave = isWordLike(text);
    lastTranslation = {
      translation: r.translation,
      sourceLanguage: r.sourceLanguage,
      sourceCode: r.sourceCode || '',
      targetCode: r.targetCode || '',
      targetLabel: r.targetLabel,
      ms: r.ms,
      provider: r.providerLabel,
      model: shortModel(r.model),
      canReplace,
      canSave,
      saved: false,
      total: 0,
      word: text,
      contextText: canSave ? contextAround(context) : '',
      anchor,
      context,
    };

    UI.show(anchor, 'translation', {
      translation: r.translation,
      source: text,
      sourceLanguage: r.sourceLanguage,
      sourceCode: r.sourceCode || '',
      targetCode: r.targetCode || '',
      targetLabel: r.targetLabel,
      ms: r.ms,
      provider: r.providerLabel,
      model: shortModel(r.model),
      canReplace,
      canSave,
      saved: false,
    });
  }

  async function copyTranslation() {
    if (!lastTranslation) return;
    const text = lastTranslation.translation;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = false;
    }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch {
        ok = false;
      }
    }
    const t = lastTranslation;
    UI.show(t.anchor, 'translation', {
      translation: t.translation,
      source: t.word,
      sourceLanguage: t.sourceLanguage,
      sourceCode: t.sourceCode,
      targetCode: t.targetCode,
      targetLabel: t.targetLabel,
      ms: t.ms,
      provider: t.provider,
      model: t.model,
      canReplace: t.canReplace,
      canSave: t.canSave,
      saved: t.saved,
      total: t.total,
      copied: ok,
    });
  }

  async function saveTranslationWord() {
    if (!lastTranslation || lastTranslation.saved || !lastTranslation.canSave) return;
    const t = lastTranslation;
    const res = await send({
      type: 'SAVE_WORD',
      word: t.word,
      translation: t.translation,
      source: t.sourceLanguage,
      sourceCode: t.sourceCode,
      target: t.targetLabel,
      targetCode: t.targetCode,
      context: t.contextText,
      host: location.hostname,
    });
    if (!res?.ok) return;
    t.saved = true;
    t.total = res.total || 0;
    UI.show(t.anchor, 'translation', {
      translation: t.translation,
      source: t.word,
      sourceLanguage: t.sourceLanguage,
      targetLabel: t.targetLabel,
      ms: t.ms,
      provider: t.provider,
      model: t.model,
      canReplace: t.canReplace,
      canSave: t.canSave,
      saved: true,
      total: t.total,
    });
  }

  function replaceWithTranslation() {
    if (!lastTranslation) return;
    const { context, translation } = lastTranslation;
    try {
      if (context.field && context.field.isConnected) {
        const el = context.field;
        withGuard(el, () => {
          el.setRangeText(translation, context.start, context.end, 'end');
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: translation }));
        });
      } else if (context.range && context.editable && context.editable.isConnected) {
        const sel = window.getSelection();
        if (sel) {
          const range = context.range.cloneRange();
          sel.removeAllRanges();
          sel.addRange(range);
          const el = context.editable;
          withGuard(el, () => {
            try {
              document.execCommand('insertText', false, translation);
            } catch {
              /* leave the text alone */
            }
          });
        }
      }
    } catch {
      /* selection disappeared — nothing to replace */
    }
    translateToken++;
    UI.hide();
  }

  function onSelectionMouseUp(e) {
    if (!settings || !settings.translate.enabled || !settings.translate.onSelect) return;
    if (e.button !== 0 || isOurs(e.target)) return;
    clearTimeout(translateTimer);
    translateTimer = setTimeout(() => {
      void translateSelection({ force: false });
    }, 260);
  }

  function onSelectionDblClick(e) {
    if (!settings || !settings.translate.enabled) return;
    if (isOurs(e.target)) return;
    clearTimeout(translateTimer);
    void translateSelection({ force: false });
  }

  // ── actions ──────────────────────────────────────────────────────────────

  function applySuggestion() {
    if (!current || !lastResult) return;
    const { el, adapter } = current;

    if (!lastResult.changed || !lastResult.corrected) {
      UI.hide();
      return;
    }

    const before = adapter.get();
    const corrected = lastResult.corrected;
    const selection = pendingSelection;

    withGuard(el, () => {
      if (selection && selection.kind === 'value' && !el.isContentEditable) {
        const start = clamp(selection.start, 0, before.length);
        const end = clamp(selection.end, 0, before.length);
        el.setRangeText(corrected, start, end, 'end');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: corrected }));
      } else if (selection && selection.kind === 'range') {
        const sel = window.getSelection();
        if (sel && selection.range) {
          sel.removeAllRanges();
          sel.addRange(selection.range);
          try {
            document.execCommand('insertText', false, corrected);
          } catch {
            adapter.set(corrected);
          }
        }
      } else {
        adapter.set(corrected);
      }
    });

    appliedEl = el;
    appliedBefore = before;
    lastResult = null;
    pendingSelection = null;
    ++runId;
    UI.show(el, 'applied', { canUndo: true });
    void send({ type: 'BUMP_STATS', fixes: 1 });
  }

  function undoApply() {
    if (!appliedEl || appliedBefore == null || !appliedEl.isConnected) {
      UI.hide();
      return;
    }
    const el = appliedEl;
    const before = appliedBefore;
    appliedEl = null;
    appliedBefore = null;
    withGuard(el, () => adapterFor(el).set(before));
    UI.hide();
  }

  async function recheck() {
    if (!current?.el?.isConnected) {
      UI.hide();
      return;
    }
    const el = current.el;
    const adapter = adapterFor(el);
    current = { el, adapter };
    pendingSelection = null;
    lastResult = null;
    const token = ++runId;
    const text = (adapter.get() || '').trim();
    if (text.length < 3) {
      UI.hide();
      return;
    }
    await runCheck(el, text, token);
  }

  function pickField() {
    const active = document.activeElement;
    if (isEligible(active)) return active;
    if (lastField && lastField.isConnected && isEligible(lastField)) return lastField;
    return null;
  }

  /** "Fix selection" — checks just the selected text when there is one. */
  async function fixSelection() {
    if (!settings) return;
    if (!settings.enabled || isPausedSite()) return;
    const el = pickField();
    if (!el) return;

    settings.hasKey = !!(await readSettings()).hasKey;
    if (!settings.hasKey) {
      current = { el, adapter: adapterFor(el) };
      renderError(el, { code: 'NO_KEY' });
      return;
    }

    const adapter = adapterFor(el);
    current = { el, adapter };
    pendingSelection = null;
    lastResult = null;

    let text = '';
    if (adapter.kind === 'value') {
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      if (end - start >= MIN_SELECTION_CHARS) {
        text = el.value.slice(start, end);
        pendingSelection = { kind: 'value', start, end };
      }
    } else {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && el.contains(sel.anchorNode) && sel.toString().trim().length >= MIN_SELECTION_CHARS) {
        text = sel.toString();
        pendingSelection = { kind: 'range', range: sel.getRangeAt(0).cloneRange() };
      }
    }
    if (!text) text = adapter.get();
    text = text.trim();
    if (text.length < 3) return;

    const token = ++runId;
    await runCheck(el, text, token);
  }

  async function checkField() {
    if (!settings || !settings.enabled || isPausedSite()) return;
    const el = pickField();
    if (!el) return;
    current = { el, adapter: adapterFor(el) };
    pendingSelection = null;
    lastResult = null;
    const text = (current.adapter.get() || '').trim();
    if (text.length < 3) return;
    const token = ++runId;
    await runCheck(el, text, token);
  }

  UI.onAction((action) => {
    switch (action) {
      case 'apply':
        applySuggestion();
        break;
      case 'dismiss':
        // Cancel anything in flight: a late result must not re-open the card.
        ++runId;
        ++translateToken;
        clearTimeout(debounceTimer);
        cancelInflight();
        lastResult = null;
        pendingSelection = null;
        UI.hide();
        break;
      case 'undo':
        undoApply();
        break;
      case 'recheck':
      case 'retry':
        if (lastTranslation) void translateSelection({ force: true });
        else void recheck();
        break;
      case 'copy':
        void copyTranslation();
        break;
      case 'save':
        void saveTranslationWord();
        break;
      case 'replace':
        replaceWithTranslation();
        break;
      case 'open-settings':
        void send({ type: 'OPEN_SETTINGS' });
        UI.hide();
        break;
      default:
        break;
    }
  });

  // ── boot ─────────────────────────────────────────────────────────────────

  async function boot() {
    try {
      settings = await readSettings();
    } catch {
      settings = null;
    }
    if (!settings) return;
    UI.setTheme(settings.theme);

    /* premium voice: the service worker does the fetching, this side plays it.
       Off by default; when it fails (no key, no network) speak() falls back to
       the OS voice on its own. */
    if (window.WriteWiseSpeech && window.WriteWiseSpeech.connectRemote) {
      window.WriteWiseSpeech.connectRemote();
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.ww_settings) return;
      void readSettings().then((next) => {
        settings = next;
        UI.setTheme(next.theme);
        if (!next.enabled) UI.hide();
      });
    });

    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
      if (msg?.type === 'GET_INFO') {
        respond({ host: hostOf(), supported: true });
        return false;
      }
      if (msg?.type === 'FIX_SELECTION') {
        void fixSelection();
        respond({ ok: true });
        return false;
      }
      if (msg?.type === 'CHECK_FIELD') {
        void checkField();
        respond({ ok: true });
        return false;
      }
      if (msg?.type === 'TRANSLATE_SELECTION') {
        void translateSelection({ force: true });
        respond({ ok: true });
        return false;
      }
      return false;
    });

    document.addEventListener('input', onInput, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('compositionstart', onCompositionStart, true);
    document.addEventListener('compositionend', onCompositionEnd, true);
    document.addEventListener('mouseup', onSelectionMouseUp, true);
    document.addEventListener('dblclick', onSelectionDblClick, true);
  }

  void boot();
})();
