// Exercises src/storage.js in Node with a chrome.storage stub.
import { normalize, getSettings, setSettings, getStats, bumpStats, DEFAULTS, migrateLegacy, SETTINGS_KEY, STATS_KEY } from '../src/storage.js';

let failures = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  if (!cond) failures++;
};

const store = {};
const local = {
  get: async (keys) => {
    if (keys == null) return { ...store };
    if (typeof keys === 'string') return { [keys]: store[keys] };
    if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store[k]]));
    return Object.fromEntries(Object.keys(keys).map((k) => [k, store[k] === undefined ? keys[k] : store[k]]));
  },
  set: async (obj) => { Object.assign(store, obj); },
};
globalThis.chrome = {
  storage: { local, sync: { get: async () => ({}), remove: async () => {} }, onChanged: { addListener() {}, removeListener() {} } },
};

// defaults
const d = normalize(undefined);
ok('defaults: provider', d.provider === 'deepseek');
ok('defaults: models', d.models.deepseek === 'deepseek-chat' && d.models.openai === 'gpt-4o-mini', d.models);
ok('defaults: delay', d.delayMs === 900);
ok('defaults: fixes on', d.fix.spelling && d.fix.grammar && d.fix.clarity && d.fix.tone);
ok('defaults: no keys', d.keys.deepseek === '' && d.keys.openai === '');

// clamping + hostile input
const n = normalize({
  provider: 'gemini', delayMs: 99999, minChars: -5, maxWords: 1e9,
  tonePreset: 'shouty', theme: 'neon', pausedSites: ['a.com', 'a.com', 42], keys: { deepseek: 'sk-1' },
  fix: { tone: false },
});
ok('normalize: unknown provider → deepseek', n.provider === 'deepseek', n.provider);
ok('normalize: delay clamped', n.delayMs === 3000, n.delayMs);
ok('normalize: minChars clamped', n.minChars === 1, n.minChars);
ok('normalize: maxWords clamped', n.maxWords === 2000, n.maxWords);
ok('normalize: bad tone preset dropped', n.tonePreset === '', n.tonePreset);
ok('normalize: bad theme dropped', n.theme === 'system');
ok('normalize: pausedSites deduped + typed', n.pausedSites.length === 1 && n.pausedSites[0] === 'a.com', n.pausedSites);
ok('normalize: keys preserved', n.keys.deepseek === 'sk-1');
ok('normalize: fix defaults fill in', n.fix.tone === false && n.fix.spelling === true, n.fix);

// translate settings
ok('defaults: translate on', d.translate.enabled === true && d.translate.onSelect === true);
ok('defaults: translate target is auto', d.translate.target === '');
const hostileTranslate = normalize({ translate: { enabled: false, onSelect: 'nope', target: 'klingon' } });
ok('normalize: translate flag kept', hostileTranslate.translate.enabled === false);
ok('normalize: onSelect coerced', hostileTranslate.translate.onSelect === true);
ok('normalize: unknown target kept for later validation', typeof hostileTranslate.translate.target === 'string');

// round-trip through storage preserve other keys
await setSettings({ provider: 'openai', keys: { openai: 'sk-o' } });
await setSettings({ delayMs: 1200 });
const s = await getSettings();
ok('setSettings: nested keys survive patch', s.keys.openai === 'sk-o' && s.keys.deepseek === '', s.keys);
ok('setSettings: provider persists', s.provider === 'openai');
ok('setSettings: delay persists', s.delayMs === 1200);
await setSettings({ translate: { enabled: false } });
await setSettings({ translate: { target: 'pl' } });
const st2settings = await getSettings();
ok('setSettings: translate merges deeply', st2settings.translate.enabled === false && st2settings.translate.target === 'pl', st2settings.translate);
ok('storage key name', typeof store[SETTINGS_KEY] === 'object');

// stats
await bumpStats({ fixes: 2, tokensIn: 100, tokensOut: 50, costUsd: 0.0002 });
await bumpStats({ fixes: 1, tokensIn: 10, tokensOut: 5, costUsd: 0.0001 });
const st = await getStats();
ok('stats accumulate', st.fixes === 3 && st.tokensIn === 110 && st.tokensOut === 55, st);
ok('stats cost accumulates', Math.abs(st.costUsd - 0.0003) < 1e-9, st.costUsd);

// day rollover
store[STATS_KEY] = { date: '2000-01-01', fixes: 99, tokensIn: 1, tokensOut: 1, costUsd: 1 };
const st2 = await getStats();
ok('stats reset on a new day', st2.fixes === 0 && st2.tokensIn === 0, st2);

// migration must not throw when sync is empty
let migrated = 'threw';
try { await migrateLegacy(); migrated = 'ok'; } catch { migrated = 'threw'; }
ok('migrateLegacy is safe', migrated === 'ok');

console.log(failures === 0 ? '\nALL STORAGE TESTS PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
