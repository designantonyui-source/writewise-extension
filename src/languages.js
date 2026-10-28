/**
 * Translation target languages. Kept deliberately short: a list of every
 * locale would be a maintenance tax with no product value here — these are
 * the languages a DeepSeek/OpenAI model handles well and people actually
 * translate between.
 */

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'pl', label: 'Polski' },
  { code: 'uk', label: 'Українська' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'sv', label: 'Svenska' },
  { code: 'cs', label: 'Čeština' },
  { code: 'ru', label: 'Русский' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '中文' },
  { code: 'ar', label: 'العربية' },
  { code: 'hi', label: 'हिन्दी' },
];

export function languageLabel(code) {
  const found = LANGUAGES.find((l) => l.code === code);
  return found ? found.label : '';
}

/** Label used inside the prompt: "Polish (pl)". */
export function languagePromptLabel(code) {
  const found = LANGUAGES.find((l) => l.code === code);
  return found ? `${found.label} (${found.code})` : 'English (en)';
}

/**
 * Resolve the configured target. Empty setting = follow the browser UI
 * language, falling back to English when we do not ship that language.
 */
export function resolveTarget(settings) {
  const configured = settings?.translate?.target;
  if (configured && LANGUAGES.some((l) => l.code === configured)) return configured;
  const nav = typeof navigator !== 'undefined' && navigator.language ? String(navigator.language) : 'en';
  const base = nav.slice(0, 2).toLowerCase();
  return LANGUAGES.some((l) => l.code === base) ? base : 'en';
}
