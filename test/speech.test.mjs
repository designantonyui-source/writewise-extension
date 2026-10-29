// Exercises shared/speech.js in Node with a fake speech engine.
// The file is a classic script (it attaches to window), so it is loaded with
// a hand-made window object — no DOM needed.
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
  new URL('../shared/speech.js', import.meta.url).href.replace('file://', ''),
  'utf8',
).replace(/^/, '');

let failures = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  if (!cond) failures++;
};

class Utterance {
  constructor(text) { this.text = text; this.lang = ''; this.rate = 1; this.pitch = 1; this.voice = null; }
}

function makeWindow({ voices = [], strictThrow = false } = {}) {
  const calls = { spoken: [], cancelled: 0 };
  const win = {
    SpeechSynthesisUtterance: Utterance,
    speechSynthesis: {
      speaking: false,
      getVoices: () => voices,
      speak(u) {
        if (strictThrow) throw new Error('engine unavailable');
        calls.spoken.push(u);
      },
      cancel() { calls.cancelled += 1; },
    },
  };
  new Function('window', SRC)(win);
  return { win, api: win.WriteWiseSpeech, calls };
}

// ── feature detection ──────────────────────────────────────────────────────
{
  const win = {};
  new Function('window', SRC)(win);
  ok('exposes window.WriteWiseSpeech', !!win.WriteWiseSpeech);
  ok('unavailable without an engine', win.WriteWiseSpeech.available() === false);
  ok('speak is a no-op without an engine', win.WriteWiseSpeech.speak('hi', { lang: 'en' }) === false);
}

// ── language normalisation ─────────────────────────────────────────────────
{
  const { api } = makeWindow();
  ok('bare code gets a locale', api.normalizeLang('pl') === 'pl-PL', api.normalizeLang('pl'));
  ok('unknown code passes through', api.normalizeLang('xx') === 'xx', api.normalizeLang('xx'));
  ok('explicit locale is kept', api.normalizeLang('en-GB') === 'en-GB', api.normalizeLang('en-GB'));
  ok('underscores are normalised', api.normalizeLang('pt_BR') === 'pt-BR', api.normalizeLang('pt_BR'));
  ok('empty falls back to en-US', api.normalizeLang('') === 'en-US', api.normalizeLang(''));
  ok('a language name becomes its locale', api.normalizeLang('\u0423\u043a\u0440\u0430\u0457\u043d\u0441\u044c\u043a\u0430') === 'uk-UA', api.normalizeLang('\u0423\u043a\u0440\u0430\u0457\u043d\u0441\u044c\u043a\u0430'));
  ok('a name with a code in brackets still resolves', api.normalizeLang('Polski (pl)') === 'pl-PL', api.normalizeLang('Polski (pl)'));
  ok('an unknown name never reaches the engine raw', api.normalizeLang('Klingon') === 'en-US', api.normalizeLang('Klingon'));
}

// ── voice selection ────────────────────────────────────────────────────────
{
  const voices = [
    { lang: 'en-US', name: 'English US', default: true, localService: false },
    { lang: 'en-US', name: 'English US local', default: false, localService: true },
    { lang: 'pl-PL', name: 'Polski', default: true, localService: true },
    { lang: 'de-DE', name: 'Deutsch', default: false, localService: true },
  ];
  const { api } = makeWindow({ voices });
  const picked = api.pick('pl');
  ok('picks a voice for the language', picked && picked.name === 'Polski', picked && picked.name);
  ok('picks nothing for an uninstalled language', api.pick('ja') === null);
  const en = api.pick('en');
  ok('prefers the local voice on a tie', en && en.name === 'English US local', en && en.name);
  ok('counts installed voices', api.voiceCount() === 4, api.voiceCount());
  ok('hasVoice sees an installed language', api.hasVoice('pl') === true);
  ok('hasVoice sees a missing language', api.hasVoice('uk') === false);
  ok('English rides the platform default', api.hasVoice('en') === true);
}

// ── speak ──────────────────────────────────────────────────────────────────
{
  const voices = [{ lang: 'pl-PL', name: 'Polski', default: true, localService: true }];
  const { api, calls } = makeWindow({ voices });

  const okSpeak = api.speak('  zdanie  ', { lang: 'pl' });
  ok('speaks the text', okSpeak === true && calls.spoken.length === 1);
  const u = calls.spoken[0];
  ok('text is cleaned', u.text === 'zdanie', u.text);
  ok('language normalised on the utterance', u.lang === 'pl-PL', u.lang);
  ok('learning-friendly rate', u.rate === 0.95, u.rate);
  ok('voice attached', u.voice && u.voice.name === 'Polski', u.voice && u.voice.name);

  api.speak('drugie', { lang: 'pl' });
  ok('a new word cancels the previous one', calls.cancelled >= 1, calls.cancelled);
  ok('one voice at a time', calls.spoken.length === 2);

  const rate = api.speak('x', { lang: 'pl', rate: 9 }).valueOf();
  ok('rate is clamped', calls.spoken[calls.spoken.length - 1].rate === 2, calls.spoken[calls.spoken.length - 1].rate);
  ok('clamped rate still returns true', rate === true);

  ok('empty text is ignored', api.speak('   ', { lang: 'pl' }) === false);
  ok('long text is clipped', (() => {
    api.speak('a'.repeat(900), { lang: 'pl' });
    return calls.spoken[calls.spoken.length - 1].text.length === 300;
  })(), calls.spoken[calls.spoken.length - 1].text.length);
}

// ── callbacks + failures ───────────────────────────────────────────────────
{
  const { api, calls } = makeWindow({ voices: [] });
  let started = 0;
  let ended = 0;
  api.speak('hello', { lang: 'en', onstart: () => { started += 1; }, onend: () => { ended += 1; } });
  const u = calls.spoken[0];
  ok('onstart wired', typeof u.onstart === 'function');
  ok('onend wired', typeof u.onend === 'function');
  u.onstart();
  u.onend();
  ok('callbacks fire', started === 1 && ended === 1);
  ok('no voice is not an error', u.voice === null);

  const broken = makeWindow({ strictThrow: true });
  ok('engine failure returns false', broken.api.speak('hi', { lang: 'en' }) === false);

  const { api: noVoiceApi, calls: c2 } = makeWindow({ voices: [] });
  ok('English still speaks when nothing is listed', noVoiceApi.voiceCount() === 0 && noVoiceApi.speak('hi', { lang: 'en' }) === true && c2.spoken.length === 1);

  /* The bug: no Ukrainian voice on the machine meant the platform's default
     English voice read the text. Report the gap instead. */
  const { api: gapApi, calls: c3 } = makeWindow({
    voices: [{ lang: 'en-US', name: 'Samantha', default: true, localService: true }],
  });
  let missing = null;
  let gapEnded = 0;
  const gapSpeak = gapApi.speak('\u043f\u0440\u0438\u0432\u0456\u0442', {
    lang: 'uk',
    onmissing: (lang) => { missing = lang; },
    onend: () => { gapEnded += 1; },
  });
  ok('a missing voice is reported, not faked', gapSpeak === false && missing === 'uk-UA', [gapSpeak, missing]);
  ok('no utterance goes to the engine without a matching voice', c3.spoken.length === 0, c3.spoken.length);
  ok('the report releases the playing state', gapEnded === 1, gapEnded);
}

// ── cancel ─────────────────────────────────────────────────────────────────
{
  const { api, calls } = makeWindow();
  api.cancel();
  ok('cancel reaches the engine', calls.cancelled === 1, calls.cancelled);
}

// ── remote engine (neural voice fetched by the service worker) ────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRemoteWindow(sender, opts = {}) {
  const played = [];
  class FakeCtx {
    constructor() { this.state = 'running'; this.destination = {}; this.buffer = null; }
    decodeAudioData(buffer, okCb) {
      this.buffer = buffer;
      okCb({ duration: 1, bytes: buffer.byteLength });
    }
    createBufferSource() {
      const src = {
        buffer: null,
        onended: null,
        connect() {},
        start() { played.push('start'); setTimeout(() => src.onended && src.onended(), 5); },
        stop() { played.push('stop'); },
      };
      return src;
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
  }
  const win = {
    SpeechSynthesisUtterance: Utterance,
    speechSynthesis: {
      speaking: false,
      getVoices: () => opts.voices || [],
      speak(u) { win.__localSpoken.push(u); },
      cancel() {},
    },
    AudioContext: FakeCtx,
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    __localSpoken: [],
  };
  new Function('window', SRC)(win);
  win.WriteWiseSpeech.setRemote(sender);
  return { win, api: win.WriteWiseSpeech, played };
}

{
  let asked = [];
  const { api, win, played } = makeRemoteWindow(async (text, lang) => {
    asked.push({ text, lang });
    return { audio: Buffer.from('fake-mp3').toString('base64'), mime: 'audio/mpeg' };
  }, { voices: [{ lang: 'en-US', name: 'Samantha', default: true, localService: true }] });
  let ended = 0;
  const okSpeak = api.speak('zdanie', { lang: 'en', onend: () => { ended += 1; } });
  await sleep(40);
  ok('remote: speak returns true', okSpeak === true);
  ok('remote: asks for the text and language', asked.length === 1 && asked[0].text === 'zdanie' && asked[0].lang === 'en-US', asked);
  ok('remote: plays through Web Audio', played.includes('start'), played);
  ok('remote: does not use the OS voice', win.__localSpoken.length === 0, win.__localSpoken.length);
  ok('remote: onend fires once', ended === 1, ended);
}

/* A neural voice trained on English reads Ukrainian with an English accent, so
   a native voice on the machine wins; without one, neural is the only option. */
{
  const asked = [];
  const { api, win } = makeRemoteWindow(async (text, lang) => {
    asked.push({ text, lang });
    return { audio: Buffer.from('fake-mp3').toString('base64'), mime: 'audio/mpeg' };
  }, { voices: [{ lang: 'uk-UA', name: 'Lesya', default: true, localService: true }] });
  api.speak('\u043f\u0440\u0438\u0432\u0456\u0442', { lang: 'uk' });
  await sleep(40);
  ok('native voice beats the neural one', asked.length === 0 && win.__localSpoken.length === 1, { asked: asked.length, local: win.__localSpoken.length });
  ok('the native voice is the right language', win.__localSpoken[0] && win.__localSpoken[0].lang === 'uk-UA', win.__localSpoken[0] && win.__localSpoken[0].lang);
}

{
  const asked = [];
  const { api, win } = makeRemoteWindow(async (text, lang) => {
    asked.push({ text, lang });
    return { audio: Buffer.from('fake-mp3').toString('base64'), mime: 'audio/mpeg' };
  }, { voices: [{ lang: 'en-US', name: 'Samantha', default: true, localService: true }] });
  api.speak('\u043f\u0440\u0438\u0432\u0456\u0442', { lang: 'uk' });
  await sleep(40);
  ok('neural covers a language with no native voice', asked.length === 1 && asked[0].lang === 'uk-UA', asked);
}

{
  const { api, win } = makeRemoteWindow(async () => null, {
    voices: [{ lang: 'en-US', name: 'Samantha', default: true, localService: true }],
  });
  let ended = 0;
  api.speak('zdanie', { lang: 'en', onend: () => { ended += 1; } });
  await sleep(30);
  ok('remote failure falls back to the OS voice', win.__localSpoken.length === 1, win.__localSpoken.length);
  const u = win.__localSpoken[0];
  ok('fallback still has a done callback', typeof u.onend === 'function' && ended === 0);
  u.onend();
  ok('fallback reports onend once', ended === 1, ended);
}

{
  const { api, win } = makeRemoteWindow(async () => null, {
    voices: [{ lang: 'en-US', name: 'Samantha', default: true, localService: true }],
  });
  let missing = null;
  let ended = 0;
  api.speak('\u043f\u0440\u0438\u0432\u0456\u0442', {
    lang: 'uk',
    onmissing: (lang) => { missing = lang; },
    onend: () => { ended += 1; },
  });
  await sleep(40);
  ok('remote failure with no local voice reports the gap', missing === 'uk-UA' && win.__localSpoken.length === 0, [missing, win.__localSpoken.length]);
  ok('the reported gap still ends exactly once', ended === 1, ended);
}

{
  const { api, win } = makeRemoteWindow(async () => { throw new Error('offline'); });
  api.speak('hello', { lang: 'en' });
  await sleep(30);
  ok('remote throw falls back to the OS voice', win.__localSpoken.length === 1, win.__localSpoken.length);
}

{
  const { api, win } = makeRemoteWindow(async () => ({ audio: Buffer.from('x').toString('base64') }));
  api.setRemote(null);
  api.speak('hello', { lang: 'en' });
  ok('disconnecting the remote restores the OS voice', win.__localSpoken.length === 1, win.__localSpoken.length);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
