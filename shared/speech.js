/**
 * Pronunciation.
 *
 * Two engines, one API:
 *  · the local one — Web Speech API, i.e. the voices Chrome/OS already ship.
 *    No key, no request, works offline; quality depends on the OS, which is
 *    why some languages sound like a 1998 satnav.
 *  · an optional remote one — a neural voice fetched by the service worker
 *    (OpenAI audio/speech) and played through Web Audio. Off unless the user
 *    turns it on and has a key; the key never reaches the page.
 *
 * The caller never has to care which one ran: speak() picks, falls back and
 * reports `onend` once either way.
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

  /* Callers occasionally hand over a language name ("Українська",
     "Polski (pl)") instead of a code. An unrecognised string lands in
     SpeechSynthesisUtterance.lang, where the platform ignores it and reads the
     text with its default voice — Ukrainian in English phonetics. Map the
     names this product can produce; anything else that is not a code becomes
     English, which is still the right language for English text. */
  var NAMES = {
    english: 'en', polish: 'pl', ukrainian: 'uk', russian: 'ru',
    polski: 'pl', 'українська': 'uk', 'русский': 'ru',
  };

  /* A code, optionally with a region: en, en-GB, zh-Hans. */
  var CODE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

  var cachedVoices = [];

  function synth() {
    return root && root.speechSynthesis ? root.speechSynthesis : null;
  }

  function available() {
    return (!!synth() && typeof root.SpeechSynthesisUtterance === 'function') || !!remote;
  }

  /* ── remote engine ────────────────────────────────────────────────────
     The caller supplies a sender (in the extension that is the service
     worker); this file owns playback, interruption and the onend contract. */
  var remote = null;
  var playToken = 0;
  var audioCtx = null;
  var audioSource = null;

  function setRemote(sender) {
    remote = typeof sender === 'function' ? sender : null;
    if (!remote) cancel();
  }

  function connectRemote() {
    if (!root || !root.chrome || !root.chrome.runtime || !root.chrome.runtime.sendMessage) return false;
    setRemote(function (text, lang) {
      return new Promise(function (resolve) {
        try {
          root.chrome.runtime.sendMessage({ type: 'SPEAK', text: text, lang: lang }, function (res) {
            if (root.chrome.runtime.lastError || !res || !res.ok || !res.audio) resolve(null);
            else resolve(res);
          });
        } catch (err) {
          resolve(null);
        }
      });
    });
    return true;
  }

  function context() {
    if (audioCtx) return audioCtx;
    var Ctx = root.AudioContext || root.webkitAudioContext;
    if (!Ctx) return null;
    try { audioCtx = new Ctx(); } catch (err) { audioCtx = null; }
    return audioCtx;
  }

  function bytesOf(base64) {
    var bin = root.atob(base64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function stopAudio() {
    if (!audioSource) return;
    try { audioSource.onended = null; audioSource.stop(); } catch (err) { /* already stopped */ }
    audioSource = null;
  }

  function playRemote(base64, token, done, fallback) {
    var ctx = context();
    if (!ctx) { fallback(); return; }
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (err) { /* gesture missing */ } }
    var buffer;
    try { buffer = bytesOf(base64); } catch (err) { fallback(); return; }
    ctx.decodeAudioData(buffer, function (decoded) {
      if (token !== playToken) return;
      stopAudio();
      audioSource = ctx.createBufferSource();
      audioSource.buffer = decoded;
      audioSource.connect(ctx.destination);
      audioSource.onended = function () { audioSource = null; done(); };
      audioSource.start(0);
    }, function () { if (token === playToken) fallback(); });
  }

  function normalizeLang(lang) {
    var raw = String(lang == null ? '' : lang).replace(/_/g, '-').trim();
    if (!raw) return 'en-US';
    var name = raw.toLowerCase().replace(/\([^)]*\)/g, '').trim();
    if (NAMES[name]) raw = NAMES[name];
    else if (!CODE.test(raw)) raw = 'en';
    if (raw.indexOf('-') !== -1) return raw;
    var base = raw.toLowerCase().split('-')[0];
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

  /* Names of the good voices, not the bad ones: every platform marks its
     neural/premium sets by name, and the compact fallbacks by nothing at all. */
  var GOOD_VOICE = /(neural|natural|premium|enhanced|siri|google|microsoft|azure|eleven|wavenet|studio)/i;
  /* Novelties and ancient formant synths: they exist in every voice list. */
  var JOKE_VOICE = /(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|compact|novelty)/i;

  /**
   * Best installed voice for a language. Quality first, then exact locale,
   * then a voice that is actually available offline, then the platform's
   * own default. The old order put `localService` first, which is how a
   * "compact" system voice could beat a Premium one.
   */
  function pick(lang) {
    var want = normalizeLang(lang).toLowerCase();
    var voices = refresh();
    var matches = voices.filter(function (v) {
      return baseOf(v.lang) === baseOf(want);
    });
    if (!matches.length) return null;
    function score(v) {
      var name = String(v.name || '');
      var got = String(v.lang || '').replace(/_/g, '-').toLowerCase();
      return (GOOD_VOICE.test(name) ? 8 : 0)
        + (JOKE_VOICE.test(name) ? -8 : 0)
        + (got === want ? 4 : 0)
        + (v.localService ? 2 : 0)
        + (v.default ? 1 : 0);
    }
    matches.sort(function (a, b) { return score(b) - score(a); });
    return matches[0];
  }

  /* ── engine readiness ─────────────────────────────────────────────────
     getVoices() is empty until the platform has finished enumerating, and
     nothing announces that unless you listen. Prime the list once, keep it
     fresh, and let a first click wait a beat instead of concluding that the
     language is missing. */
  var primed = false;

  function prime() {
    var s = synth();
    if (!s || primed) return;
    primed = true;
    refresh();
    try {
      if (typeof s.addEventListener === 'function') s.addEventListener('voiceschanged', refresh);
      else s.onvoiceschanged = refresh;
    } catch (err) {
      /* engine without the event */
    }
  }

  var voiceWait = 0;

  function whenVoices(fn) {
    var s = synth();
    var settled = false;
    function settle() {
      if (settled) return;
      settled = true;
      if (voiceWait) { clearTimeout(voiceWait); voiceWait = 0; }
      fn();
    }
    refresh();
    if (cachedVoices.length) { settle(); return; }
    try {
      if (s && typeof s.addEventListener === 'function') s.addEventListener('voiceschanged', settle, { once: true });
      else if (s) s.onvoiceschanged = settle;
    } catch (err) {
      settle();
      return;
    }
    voiceWait = setTimeout(settle, 600);
  }

  /** Can this platform pronounce `lang` at all? English rides on the default
      voice, every other language needs one of its own installed. */
  function hasVoice(lang) {
    var want = normalizeLang(lang);
    if (baseOf(want) === 'en') return true;
    return !!pick(want);
  }

  function cancel() {
    playToken += 1;
    stopAudio();
    var s = synth();
    if (!s) return;
    try { s.cancel(); } catch (err) { /* nothing playing */ }
  }

  /* The neural voices are English-trained identities: handed Ukrainian text
     without being told the language, they read it with an English accent. An
     installed native voice pronounces the same text correctly, so for any
     language that is not English the native voice wins and the neural one is
     kept for English and for languages this computer cannot speak. */
  function nativeVoice(lang) {
    var want = normalizeLang(lang);
    if (baseOf(want) === 'en') return null;
    return pick(want);
  }

  /**
   * Speak `text`. Returns false when the engine is missing or the text is
   * empty, so callers can hide the control instead of showing a dead button.
   */
  function speak(text, opts) {
    var options = opts || {};
    var clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
    if (!clean || !available()) return false;

    function decide() {
      if (remote && options.remote !== false && !nativeVoice(options.lang)) {
        speakRemote(clean, options);
        return true;
      }
      return speakLocal(clean, options);
    }

    var want = normalizeLang(options.lang);
    if (remote && options.remote !== false && baseOf(want) !== 'en' && !cachedVoices.length) {
      /* The voice list decides between native and neural, and it may still be
         loading: wait for it rather than defaulting to an accented reading. */
      var token = playToken;
      whenVoices(function () {
        if (token !== playToken) { // dismissed while we waited: stay quiet
          var done = options.onend;
          if (typeof done === 'function') {
            try { done(); } catch (err) { /* the caller's problem */ }
          }
          return;
        }
        decide();
      });
      return true;
    }
    return decide();
  }

  function speakRemote(clean, options) {
    cancel(); // stop whatever is playing; cancel() is what bumps the token
    var token = ++playToken;
    var u = new root.SpeechSynthesisUtterance(clean);
    u.lang = normalizeLang(options.lang);

    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      if (typeof options.onend === 'function') {
        try { options.onend(); } catch (err) { /* the caller's problem */ }
      }
    }

    if (typeof options.onstart === 'function') {
      try { options.onstart(); } catch (err) { /* the caller's problem */ }
    }

    var fellBack = false;
    function fallback() {
      if (fellBack || token !== playToken) return;
      fellBack = true;
      if (typeof options.onstart === 'function') {
        try { options.onstart(); } catch (err) { /* the caller's problem */ }
      }
      speakLocal(clean, Object.assign({}, options, { onstart: null }), finish);
    }

    remote(clean, u.lang).then(function (res) {
      if (token !== playToken || finished) return;
      if (!res || !res.audio) { fallback(); return; }
      playRemote(res.audio, token, finish, fallback);
    }).catch(function () {
      if (token === playToken && !finished) fallback();
    });
  }

  /**
   * The language has no installed voice. Reporting beats reading: the platform
   * would silently borrow its default (English) voice and turn Ukrainian into
   * phonetic nonsense. `onmissing` lets the caller offer the neural voice;
   * `onend` still fires exactly once so the "playing" state is released.
   */
  function miss(lang, options, doneOverride) {
    if (typeof options.onmissing === 'function') {
      try { options.onmissing(lang); } catch (err) { /* the caller's problem */ }
    }
    var done = doneOverride || options.onend;
    if (typeof done === 'function') {
      try { done(); } catch (err) { /* the caller's problem */ }
    }
    return false;
  }

  function speakLocal(clean, options, doneOverride) {
    var s = synth();
    if (!s) { if (doneOverride) doneOverride(); return false; }
    cancel(); // one voice at a time; a new word interrupts the old one

    var u = new root.SpeechSynthesisUtterance(clean);
    u.lang = normalizeLang(options.lang);
    u.rate = Math.max(0.5, Math.min(2, Number(options.rate) || 0.95));
    u.pitch = 1;
    var voice = pick(u.lang);

    /* A voice from another language is worse than no sound at all. English is
       the exception: when nothing is installed, the platform's default voice
       is already the right language. */
    if (!voice && baseOf(u.lang) !== 'en') {
      if (!cachedVoices.length) {
        var token = playToken;
        whenVoices(function () {
          if (token !== playToken) { // dismissed while we waited: stay quiet
            var done = doneOverride || options.onend;
            if (typeof done === 'function') {
              try { done(); } catch (err) { /* the caller's problem */ }
            }
            return;
          }
          speakLocal(clean, options, doneOverride);
        });
        return true; // the retry reports back, so the caller keeps its state
      }
      return miss(u.lang, options, doneOverride);
    }
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
    if (typeof options.onend === 'function' || doneOverride) {
      u.onend = doneOverride || finish;
      u.onerror = doneOverride || finish;
      timer = setTimeout(doneOverride || finish, Math.min(20000, 1200 + clean.length * 80));
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
    setRemote: setRemote,
    connectRemote: connectRemote,
    pick: pick,
    refresh: refresh,
    prime: prime,
    hasVoice: hasVoice,
    normalizeLang: normalizeLang,
    isSpeaking: isSpeaking,
    voiceCount: function () { return refresh().length; },
  };

  if (root) {
    root.WriteWiseSpeech = api;
    prime();
  }
})(typeof window !== 'undefined' ? window : null);
