/**
 * WriteWise v2 popup.
 *
 * One settings object, one write path. Every control reads from `state.settings`
 * and writes through `setSettings(patch)` — no control owns its own copy of
 * anything. All toggles are real <input type="checkbox"> elements: the browser
 * flips them, a `change` listener persists. Nothing here re-toggles `.checked`
 * by hand, which is what made the v1 switches dead.
 */

import { getSettings, setSettings } from '../src/storage.js';
import { PROVIDERS, providerMeta } from '../src/providers.js';

const $ = (id) => document.getElementById(id);

const FIX_IDS = {
  spelling: 'fixSpelling',
  grammar: 'fixGrammar',
  clarity: 'fixClarity',
  tone: 'fixTone',
};

const TONE_PRESETS = ['professional', 'casual', 'formal', 'friendly'];

const ELEMENT_IDS = [
  'masterToggle', 'statusText',
  'segDeepseek', 'segOpenai',
  'setupCard', 'setupText', 'setupLink',
  'keyInput', 'testBtn', 'keyStatus', 'keyHelp', 'keyHelpText', 'keyHelpLink',
  'modelSelect',
  'autoCheckToggle', 'delaySlider', 'delayValue', 'delayFill',
  'fixSpelling', 'fixGrammar', 'fixClarity', 'fixTone', 'toneRow',
  'siteHost', 'pauseSiteBtn',
  'minChars', 'maxWords',
  'statFixes', 'statCost',
];

const el = {};

const state = {
  settings: null,
  stats: { fixes: 0, costUsd: 0 },
  site: { known: false, host: '', supported: false },
  models: { deepseek: null, openai: null },
  keyState: 'idle', // idle | busy | ok | bad
  pending: {},
  saveTimer: null,
  saving: Promise.resolve(),
};

/* ── boot ─────────────────────────────────────────────────────── */

function boot() {
  for (const id of ELEMENT_IDS) el[id] = $(id);
  bind();
  loadSettings();
}

async function loadSettings() {
  try {
    state.settings = await getSettings();
  } catch (err) {
    console.warn('[WriteWise] settings unavailable', err);
    el.statusText.textContent = 'Settings unavailable';
    return;
  }
  renderAll();
  loadSite();
  loadStats();
}

/* ── rendering ────────────────────────────────────────────────── */

function renderAll() {
  applyTheme();
  renderMaster();
  renderProvider();
  renderFix();
  renderTone();
  renderDelay();
  renderSite();
  renderStats();
  reflectNumbers();
  renderStatus();
}

function applyTheme() {
  const { theme } = state.settings;
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.dataset.theme = theme;
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function renderMaster() {
  el.masterToggle.checked = state.settings.enabled !== false;
  el.autoCheckToggle.checked = state.settings.autoCheck !== false;
}

function renderProvider() {
  const provider = state.settings.provider;
  const meta = providerMeta(provider);

  el.segDeepseek.setAttribute('aria-pressed', String(provider === 'deepseek'));
  el.segOpenai.setAttribute('aria-pressed', String(provider === 'openai'));

  if (document.activeElement !== el.keyInput) {
    el.keyInput.value = state.settings.keys[provider] || '';
  }
  el.keyInput.placeholder = meta.keyHint;
  el.keyHelpLink.href = meta.keyUrl;
  el.setupLink.href = meta.keyUrl;

  renderModels(provider);
  renderKeyBox();
}

function renderModels(provider) {
  const rows = state.models[provider]
    || PROVIDERS[provider].models.map((m) => ({ id: m.id, label: m.label }));
  const signature = `${provider}:${rows.map((m) => m.id).join('|')}`;

  if (el.modelSelect.dataset.signature !== signature) {
    el.modelSelect.replaceChildren(...rows.map((m) => new Option(m.label || m.id, m.id)));
    el.modelSelect.dataset.signature = signature;
  }

  const saved = state.settings.models[provider];
  if (saved && !Array.from(el.modelSelect.options).some((o) => o.value === saved)) {
    el.modelSelect.append(new Option(saved, saved));
  }
  el.modelSelect.value = saved || rows[0]?.id || '';
}

function renderKeyBox() {
  const provider = state.settings.provider;
  const meta = providerMeta(provider);
  const hasKey = Boolean(state.settings.keys[provider] || el.keyInput.value.trim());

  el.setupCard.hidden = hasKey;
  el.setupText.textContent = `No ${meta.label} key yet.`;

  if (state.keyState === 'idle') {
    el.keyStatus.classList.remove('is-ok', 'is-bad', 'is-busy');
    el.keyHelp.classList.remove('is-ok', 'is-error');
    el.keyHelpText.textContent = `Stored on this device — sent only to ${meta.label}.`;
    el.keyHelpLink.hidden = false;
  }
}

function renderFix() {
  for (const [name, id] of Object.entries(FIX_IDS)) {
    el[id].checked = state.settings.fix[name] !== false;
  }
}

function renderTone() {
  el.toneRow.hidden = state.settings.fix.tone === false;
  for (const preset of TONE_PRESETS) {
    const pill = $(`tonePill-${preset}`);
    if (pill) pill.setAttribute('aria-pressed', String(state.settings.tonePreset === preset));
  }
}

function renderDelay() {
  const ms = state.settings.delayMs;
  if (document.activeElement !== el.delaySlider) el.delaySlider.value = String(ms);
  el.delayValue.textContent = `${(ms / 1000).toFixed(1)} s`;
  paintDelayFill(ms);
}

function paintDelayFill(ms) {
  const pct = (ms - 400) / (3000 - 400);
  el.delayFill.style.width = `calc(7px + (100% - 14px) * ${pct.toFixed(4)})`;
}

function renderSite() {
  const { known, host, supported } = state.site;
  el.pauseSiteBtn.disabled = !known || !supported;

  if (!known) {
    el.siteHost.textContent = 'Unavailable on this page';
    el.siteHost.removeAttribute('title');
    el.pauseSiteBtn.textContent = 'Pause';
    el.pauseSiteBtn.setAttribute('aria-pressed', 'false');
    el.pauseSiteBtn.title = supported ? '' : 'This page is not supported';
    return;
  }

  el.siteHost.textContent = host;
  el.siteHost.title = host;
  const paused = state.settings.pausedSites.includes(host);
  el.pauseSiteBtn.textContent = paused ? 'Resume' : 'Pause';
  el.pauseSiteBtn.setAttribute('aria-pressed', String(paused));
  el.pauseSiteBtn.title = paused ? `Resume checking on ${host}` : `Pause checking on ${host}`;
}

function renderStats() {
  const fixes = Number(state.stats.fixes) || 0;
  el.statFixes.textContent = `${fixes} ${fixes === 1 ? 'fix' : 'fixes'} today`;
  el.statCost.textContent = formatCost(state.stats.costUsd);
}

function formatCost(usd) {
  const value = Number(usd) || 0;
  if (value <= 0) return '≈$0.00';
  if (value < 0.01) return `≈$${value.toFixed(4)}`;
  return `≈$${value.toFixed(2)}`;
}

function renderStatus() {
  const s = state.settings;
  const hasKey = Boolean(s.keys[s.provider]);
  const pausedHere = state.site.known && s.pausedSites.includes(state.site.host);

  let text;
  if (!hasKey) text = 'Add a key to start';
  else if (pausedHere) text = 'Paused on this site';
  else if (!s.enabled) text = 'Paused';
  else text = 'Watching for pauses';

  el.statusText.textContent = text;
  document.body.classList.toggle('is-off', s.enabled === false);
}

/* ── settings writes (serialised, one path) ───────────────────── */

function save(patch) {
  state.saving = state.saving
    .then(() => setSettings(patch))
    .then((next) => {
      state.settings = next;
      afterSave(patch);
      return next;
    })
    .catch((err) => {
      console.warn('[WriteWise] could not save settings', err);
      return state.settings;
    });
  return state.saving;
}

/** Coalesce slider/number/key edits so we never write once per pixel. */
function queueSave(patch, delay) {
  state.pending = mergePatch(state.pending, patch);
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushSave, delay);
}

function flushSave() {
  clearTimeout(state.saveTimer);
  const patch = state.pending;
  state.pending = {};
  if (!Object.keys(patch).length) return Promise.resolve(state.settings);
  return save(patch);
}

function mergePatch(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const isObject = value && typeof value === 'object' && !Array.isArray(value);
    out[key] = isObject ? { ...(base[key] || {}), ...value } : value;
  }
  return out;
}

function afterSave(patch) {
  if ('provider' in patch) renderProvider();
  if ('keys' in patch) renderKeyBox();
  if ('fix' in patch || 'tonePreset' in patch) renderTone();
  if ('pausedSites' in patch) renderSite();
  if ('delayMs' in patch) renderDelay();
  if ('minChars' in patch || 'maxWords' in patch) reflectNumbers();
  renderStatus();
}

/* ── events ───────────────────────────────────────────────────── */

function bind() {
  el.masterToggle.addEventListener('change', () => {
    save({ enabled: el.masterToggle.checked });
  });

  el.autoCheckToggle.addEventListener('change', () => {
    save({ autoCheck: el.autoCheckToggle.checked });
  });

  for (const [name, id] of Object.entries(FIX_IDS)) {
    el[id].addEventListener('change', () => {
      save({ fix: { [name]: el[id].checked } });
    });
  }

  for (const preset of TONE_PRESETS) {
    $(`tonePill-${preset}`).addEventListener('click', () => {
      const next = state.settings.tonePreset === preset ? '' : preset;
      save({ tonePreset: next });
    });
  }

  el.segDeepseek.addEventListener('click', () => chooseProvider('deepseek'));
  el.segOpenai.addEventListener('click', () => chooseProvider('openai'));

  el.keyInput.addEventListener('input', () => {
    state.keyState = 'idle';
    el.keyStatus.classList.remove('is-ok', 'is-bad', 'is-busy');
    el.keyHelp.classList.remove('is-ok', 'is-error');
    el.setupCard.hidden = Boolean(el.keyInput.value.trim() || state.settings.keys[state.settings.provider]);
    queueSave({ keys: { [state.settings.provider]: el.keyInput.value.trim() } }, 450);
  });

  el.keyInput.addEventListener('change', () => {
    queueSave({ keys: { [state.settings.provider]: el.keyInput.value.trim() } }, 0);
    flushSave();
  });

  el.testBtn.addEventListener('click', testKey);

  el.modelSelect.addEventListener('change', () => {
    save({ models: { [state.settings.provider]: el.modelSelect.value } });
  });

  el.delaySlider.addEventListener('input', onDelayInput);
  el.delaySlider.addEventListener('change', () => flushSave());

  el.minChars.addEventListener('change', onNumberChange);
  el.maxWords.addEventListener('change', onNumberChange);

  el.pauseSiteBtn.addEventListener('click', toggleSitePause);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !state.settings) return;
    if (changes.ww_stats) loadStats();
  });
}

function chooseProvider(provider) {
  if (!state.settings || provider === state.settings.provider) return;
  state.keyState = 'idle';
  state.models[provider] = state.models[provider] || null;
  save({ provider });
}

function onDelayInput() {
  const ms = Number(el.delaySlider.value);
  el.delayValue.textContent = `${(ms / 1000).toFixed(1)} s`;
  paintDelayFill(ms);
  state.settings.delayMs = ms;
  queueSave({ delayMs: ms }, 150);
}

function onNumberChange() {
  const minChars = Number(el.minChars.value);
  const maxWords = Number(el.maxWords.value);
  save({
    minChars: Number.isFinite(minChars) ? minChars : state.settings.minChars,
    maxWords: Number.isFinite(maxWords) ? maxWords : state.settings.maxWords,
  });
}

function reflectNumbers() {
  const s = state.settings;
  if (document.activeElement !== el.minChars) el.minChars.value = String(s.minChars);
  if (document.activeElement !== el.maxWords) el.maxWords.value = String(s.maxWords);
}

/* ── key test ─────────────────────────────────────────────────── */

async function testKey() {
  const provider = state.settings.provider;
  const meta = providerMeta(provider);
  const apiKey = el.keyInput.value.trim();

  if (!apiKey) {
    setKeyState('bad', `Add your ${meta.label} key first.`);
    el.keyInput.focus();
    return;
  }

  setKeyState('busy', 'Testing the key…');
  el.testBtn.disabled = true;
  el.testBtn.textContent = 'Testing…';

  let result;
  try {
    result = await sendMessage({ type: 'MODELS', provider, apiKey }, 20000);
  } catch (err) {
    result = { ok: false, error: { code: 'RUNTIME', message: 'No response' } };
  } finally {
    el.testBtn.disabled = false;
    el.testBtn.textContent = 'Test';
  }

  if (result && result.ok) {
    const rows = orderModels(provider, (Array.isArray(result.models) ? result.models : []).map(toModelRow));
    if (rows.length) {
      state.models[provider] = rows;
      renderModels(provider);
    }
    await save({ keys: { [provider]: apiKey } });
    setKeyState('ok', 'Connected');
    renderKeyBox();
    renderStatus();
    return;
  }

  const message = result?.error?.message || result?.message || 'That key was rejected.';
  setKeyState('bad', message);
}

function toModelRow(entry) {
  if (typeof entry === 'string') return { id: entry };
  const id = entry && entry.id ? String(entry.id) : '';
  return { id, label: entry && entry.label ? String(entry.label) : '' };
}

function orderModels(provider, rows) {
  const known = PROVIDERS[provider].models;
  const rank = new Map(known.map((m, index) => [m.id, index]));
  const seen = new Set();
  const out = [];

  for (const row of rows) {
    if (!row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({ id: row.id, label: row.label || labelFor(provider, row.id) });
  }

  out.sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : 999;
    const rb = rank.has(b.id) ? rank.get(b.id) : 999;
    if (ra !== rb) return ra - rb;
    return String(a.label).localeCompare(String(b.label));
  });

  return out.slice(0, 60);
}

function labelFor(provider, id) {
  const match = PROVIDERS[provider].models.find((m) => m.id === id);
  return match ? match.label : id;
}

function setKeyState(name, message) {
  state.keyState = name;
  el.keyStatus.classList.remove('is-ok', 'is-bad', 'is-busy');
  el.keyHelp.classList.remove('is-ok', 'is-error');

  if (name === 'ok') {
    el.keyStatus.classList.add('is-ok');
    el.keyHelp.classList.add('is-ok');
  } else if (name === 'bad') {
    el.keyStatus.classList.add('is-bad');
    el.keyHelp.classList.add('is-error');
  } else if (name === 'busy') {
    el.keyStatus.classList.add('is-busy');
  }

  el.keyHelpText.textContent = message || defaultHint();
  el.keyHelpLink.hidden = name === 'ok';
}

function defaultHint() {
  return `Stored on this device — sent only to ${providerMeta(state.settings.provider).label}.`;
}

/* ── active tab + stats ───────────────────────────────────────── */

async function loadSite() {
  let result = null;
  try {
    result = await sendMessage({ type: 'GET_ACTIVE_INFO' }, 4000);
  } catch (err) {
    result = null;
  }

  if (result && result.ok && typeof result.host === 'string' && result.host) {
    state.site = { known: true, host: result.host, supported: result.supported !== false };
  } else {
    state.site = { known: false, host: '', supported: false };
  }
  renderSite();
  renderStatus();
}

function toggleSitePause() {
  if (!state.site.known) return;
  const { host } = state.site;
  const paused = state.settings.pausedSites.includes(host);
  const pausedSites = paused
    ? state.settings.pausedSites.filter((h) => h !== host)
    : [...state.settings.pausedSites, host];
  save({ pausedSites });
}

async function loadStats() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const got = await chrome.storage.local.get('ww_stats');
    const s = got && got.ww_stats;
    state.stats = s && s.date === today
      ? { fixes: Number(s.fixes) || 0, costUsd: Number(s.costUsd) || 0 }
      : { fixes: 0, costUsd: 0 };
  } catch (err) {
    state.stats = { fixes: 0, costUsd: 0 };
  }
  if (state.settings) renderStats();
}

/* ── messaging ────────────────────────────────────────────────── */

/**
 * Wrap chrome.runtime.sendMessage so a missing background, a dropped port or a
 * provider hang all resolve instead of throwing. Never rejects.
 */
function sendMessage(message, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: { code: 'TIMEOUT', message: 'No response' } }),
      timeoutMs,
    );

    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        finish({ ok: false, error: { code: 'CONTEXT', message: 'No response' } });
        return;
      }
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          finish({ ok: false, error: { code: 'RUNTIME', message: 'No response' } });
          return;
        }
        finish(response === undefined ? { ok: false, error: { code: 'EMPTY', message: 'No response' } } : response);
      });
    } catch (err) {
      finish({ ok: false, error: { code: 'RUNTIME', message: 'No response' } });
    }
  });
}

/* ── start ────────────────────────────────────────────────────── */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
