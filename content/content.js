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
    if (!model) return '';
    if (model === 'deepseek-flash') return 'DeepSeek Flash';
    if (model === 'deepseek-v4-pro') return 'DeepSeek V4 Pro';
    if (model === 'gpt-6-luna') return 'GPT-6 Luna';
    if (model === 'gpt-6.1-terra') return 'GPT-6.1 Terra';
    if (model === 'gpt-5.4-nano') return 'GPT-5.4 nano';
    return model;
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
        action: { id: 'open-settings', label: 'Open settings' },
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
        UI.hide();
        break;
      case 'undo':
        undoApply();
        break;
      case 'recheck':
      case 'retry':
        void recheck();
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
      return false;
    });

    document.addEventListener('input', onInput, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('compositionstart', onCompositionStart, true);
    document.addEventListener('compositionend', onCompositionEnd, true);
  }

  void boot();
})();
