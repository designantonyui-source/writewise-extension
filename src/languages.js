/**
 * Translation target languages. Deliberately four: English, Polish,
 * Ukrainian and Russian. The list is a promise — every language here has to
 * have a voice, a label a person reads and a prompt that names it — so it only
 * grows when someone actually needs it.
 */

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'pl', label: 'Polski' },
  { code: 'uk', label: 'Українська' },
  { code: 'ru', label: 'Русский' },
];

export function languageLabel(code) {
  const found = LANGUAGES.find((l) => l.code === code);
  return found ? found.label : '';
}

/** Label used inside the prompt: "Polish (pl)". */
/** The label a person reads: "Polski", not "Polski (pl)" — the code is for the
 *  model and for speech, never for the card. */
export function languageDisplayLabel(code) {
  const found = LANGUAGES.find((l) => l.code === code);
  return found ? found.label : 'English';
}

export function languagePromptLabel(code) {
  const found = LANGUAGES.find((l) => l.code === code);
  return found ? `${found.label} (${found.code})` : 'English (en)';
}

/** English names a model returns, e.g. "Polish", mapped to a code. */
const NAME_TO_CODE = {
  english: 'en', polish: 'pl', ukrainian: 'uk', german: 'de', french: 'fr',
  spanish: 'es', italian: 'it', portuguese: 'pt', dutch: 'nl', swedish: 'sv',
  czech: 'cs', russian: 'ru', turkish: 'tr', japanese: 'ja', chinese: 'zh',
  arabic: 'ar', hindi: 'hi',
};

/**
 * Best code for a language the model named in prose ("English", "Polish").
 * Returns '' when it is not one we ship — callers then hide the control
 * rather than guess and pronounce the word in the wrong language.
 */
export function codeForLanguageName(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return '';
  if (NAME_TO_CODE[key]) return NAME_TO_CODE[key];
  const exact = LANGUAGES.find((l) => l.label.toLowerCase() === key);
  if (exact) return exact.code;
  const partial = Object.keys(NAME_TO_CODE).find((name) => key.indexOf(name) !== -1);
  return partial ? NAME_TO_CODE[partial] : '';
}

/** Code from a stored label: "Polski (pl)" or "English". */
export function codeFromLabel(label) {
  const match = String(label || '').match(/\(([a-z]{2})\)/i);
  if (match) return match[1].toLowerCase();
  return codeForLanguageName(label);
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
