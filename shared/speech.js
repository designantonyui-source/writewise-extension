/**
 * Pronunciation.
 *
 * Uses the speech engine Chrome already ships with (Web Speech API): no API
 * key, no extra host permission, no request cost, and it keeps working
 * offline with the voices installed on the operating system. Voice quality
 * depends on the system ("Samantha", "Zosia", "Google UK English"…), which
 * is the honest trade-off for something that must feel instant.
 *
 * Classic script on purpose: the content script and the extension page both
 * load it as a plain <script>, so there is exactly one copy of the logic.
 * Exposes window.WriteWiseSpeech.
 */
(function (root) {
  'use strict';

  var MAX_CHARS = 300;

  /* A bare "pl" makes some platforms pick the wrong voice; a full locale
     matches the installed voice far more reliably. */
  var LOCALES = {
    en: 'en-US', pl: 'pl-PL', uk: 'uk-UA', de: 'de-DE', fr: 'fr-FR',
    es: 'es-ES', it: 'it-IT', pt: 'pt-PT', nl: 'nl-NL', sv: 'sv-SE',
    cs: 'cs-CZ', ru: 'ru-RU', tr: 'tr-TR', ja: 'ja-JP', zh: 'zh-CN',
    ar: 'ar-SA', hi: 'hi-IN',
  };

  var cachedVoices = [];

  function synth() {
    return root && root.speechSynthesis ? root.speechSynthesis : null;
  }

  function available() {
    return !!synth() && typeof root.SpeechSynthesisUtterance === 'function';
  }

  function normalizeLang(lang) {
    var raw = String(lang || '').replace(/_/g, '-').trim();
    if (!raw) return 'en-US';
    var base = raw.toLowerCase().split('-')[0];
    if (raw.indexOf('-') !== -1) return raw;
    return LOCALES[base] || raw;
  }

  function refresh() {
    var s = synth();
    if (!s) return cachedVoices;
    try {
      var list = s.getVoices() || [];
      if (list.length) cachedVoices = list;
    } catch (err) {
      /* some builds throw before the engine is ready */
    }
    return cachedVoices;
  }

  function baseOf(lang) {
    return String(lang || '').replace(/_/g, '-').toLowerCase().split('-')[0];
  }

  /** Best installed voice for a language: exact locale, then local, then any. */
  function pick(lang) {
    var want = normalizeLang(lang).toLowerCase();
    var voices = refresh();
    var matches = voices.filter(function (v) {
      return baseOf(v.lang) === baseOf(want);
    });
    if (!matches.length) return null;
    function score(v) {
      var got = String(v.lang || '').replace(/_/g, '-').toLowerCase();
      return (got === want ? 4 : 0) + (v.localService ? 2 : 0) + (v.default ? 1 : 0);
    }
    matches.sort(function (a, b) { return score(b) - score(a); });
    return matches[0];
  }

  function cancel() {
    var s = synth();
    if (!s) return;
    try { s.cancel(); } catch (err) { /* nothing playing */ }
  }

  /**
   * Speak `text`. Returns false when the engine is missing or the text is
   * empty, so callers can hide the control instead of showing a dead button.
   */
  function speak(text, opts) {
    var options = opts || {};
    var clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
    if (!clean || !available()) return false;

    var s = synth();
    cancel(); // one voice at a time; a new word interrupts the old one

    var u = new root.SpeechSynthesisUtterance(clean);
    u.lang = normalizeLang(options.lang);
    u.rate = Math.max(0.5, Math.min(2, Number(options.rate) || 0.95));
    u.pitch = 1;
    var voice = pick(u.lang);
    if (voice) u.voice = voice;

    if (typeof options.onstart === 'function') u.onstart = options.onstart;

    /* Some engines accept an utterance and never report back (no voices, a
       suspended tab). The UI uses onend to clear its "playing" state, so it
       gets a guaranteed answer: a generous estimate of how long the word
       takes, at which point the state resets anyway. */
    var finished = false;
    var timer = 0;
    function finish() {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (typeof options.onend === 'function') {
        try { options.onend(); } catch (err) { /* the caller's problem */ }
      }
    }
    if (typeof options.onend === 'function') {
      u.onend = finish;
      u.onerror = finish;
      timer = setTimeout(finish, Math.min(20000, 1200 + clean.length * 80));
    }

    try {
      s.speak(u);
      return true;
    } catch (err) {
      finish();
      return false;
    }
  }

  function isSpeaking() {
    var s = synth();
    return !!(s && s.speaking);
  }

  var api = {
    available: available,
    speak: speak,
    cancel: cancel,
    pick: pick,
    refresh: refresh,
    normalizeLang: normalizeLang,
    isSpeaking: isSpeaking,
    voiceCount: function () { return refresh().length; },
  };

  if (root) root.WriteWiseSpeech = api;
})(typeof window !== 'undefined' ? window : null);
