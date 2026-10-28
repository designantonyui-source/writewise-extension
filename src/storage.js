/**
 * Settings + stats. One storage key each, one normaliser, one place that
 * knows the shape. Keys live in storage.local on purpose: they are secrets,
 * and chrome.storage.sync copies them to a Google account.
 */

export const SETTINGS_KEY = 'ww_settings';
export const STATS_KEY = 'ww_stats';

export const DEFAULTS = Object.freeze({
  version: 2,
  provider: 'deepseek', // 'deepseek' | 'openai'
  keys: { deepseek: '', openai: '' },
  models: { deepseek: 'deepseek-flash', openai: 'gpt-6-luna' },
  enabled: true,
  autoCheck: true,
  delayMs: 900, // 400–3000
  minChars: 24,
  maxWords: 250,
  fix: { spelling: true, grammar: true, clarity: true, tone: true },
  tonePreset: '', // '' | professional | casual | formal | friendly
  pausedSites: [],
  theme: 'system', // 'system' | 'dark' | 'light'
});

const clamp = (n, min, max, fallback) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
};

export function normalize(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const provider = s.provider === 'openai' ? 'openai' : 'deepseek';
  return {
    version: 2,
    provider,
    keys: {
      deepseek: String(s.keys?.deepseek || ''),
      openai: String(s.keys?.openai || ''),
    },
    models: {
      deepseek: String(s.models?.deepseek || DEFAULTS.models.deepseek),
      openai: String(s.models?.openai || DEFAULTS.models.openai),
    },
    enabled: s.enabled !== false,
    autoCheck: s.autoCheck !== false,
    delayMs: clamp(s.delayMs, 400, 3000, DEFAULTS.delayMs),
    minChars: clamp(s.minChars, 1, 400, DEFAULTS.minChars),
    maxWords: clamp(s.maxWords, 10, 2000, DEFAULTS.maxWords),
    fix: {
      spelling: s.fix?.spelling !== false,
      grammar: s.fix?.grammar !== false,
      clarity: s.fix?.clarity !== false,
      tone: s.fix?.tone !== false,
    },
    tonePreset: ['professional', 'casual', 'formal', 'friendly'].includes(s.tonePreset)
      ? s.tonePreset
      : '',
    pausedSites: Array.isArray(s.pausedSites)
      ? [...new Set(s.pausedSites.filter((h) => typeof h === 'string' && h))]
      : [],
    theme: ['system', 'dark', 'light'].includes(s.theme) ? s.theme : 'system',
  };
}

export async function getSettings() {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return normalize(got[SETTINGS_KEY]);
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = normalize({
    ...current,
    ...patch,
    keys: { ...current.keys, ...(patch?.keys || {}) },
    models: { ...current.models, ...(patch?.models || {}) },
    fix: { ...current.fix, ...(patch?.fix || {}) },
  });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function onSettingsChanged(cb) {
  const handler = (changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    cb(normalize(changes[SETTINGS_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

// ── stats ──────────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);

const emptyStats = () => ({ date: today(), fixes: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 });

export async function getStats() {
  const got = await chrome.storage.local.get(STATS_KEY);
  const s = got[STATS_KEY];
  if (!s || s.date !== today()) return emptyStats();
  return { ...emptyStats(), ...s };
}

export async function bumpStats({ fixes = 0, tokensIn = 0, tokensOut = 0, costUsd = 0 } = {}) {
  const s = await getStats();
  const next = {
    date: s.date,
    fixes: s.fixes + fixes,
    tokensIn: s.tokensIn + tokensIn,
    tokensOut: s.tokensOut + tokensOut,
    costUsd: s.costUsd + costUsd,
  };
  await chrome.storage.local.set({ [STATS_KEY]: next });
  return next;
}

// ── one-time cleanup of v1 secrets ────────────────────────────────────────

/** v1 kept keys in cloud-synced storage for three providers we no longer ship. */
export async function migrateLegacy() {
  try {
    const legacy = await chrome.storage.sync.get(['claudeKey', 'geminiKey', 'groqKey', 'provider']);
    if (!legacy || Object.keys(legacy).length === 0) return;
    await chrome.storage.sync.remove(['claudeKey', 'geminiKey', 'groqKey', 'provider']);
  } catch {
    // sync may be unavailable offline; nothing here is required to run.
  }
}
