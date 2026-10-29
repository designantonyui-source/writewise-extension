// Exercises src/providers.js in plain Node with a stubbed fetch.
import { analyze, translate, listModels, estimateCost, PROVIDERS, defaultModel, pickModel, isChatModel, modelLabel, ttsInstructions } from '../src/providers.js';

let failures = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`);
  if (!cond) failures++;
};

const envelope = (obj, usage = { prompt_tokens: 12, completion_tokens: 14 }) =>
  JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) }, finish_reason: 'stop' }], usage });

function withFetch(mock) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, headers: init?.headers, body: init?.body ? JSON.parse(init.body) : null });
    const m = await mock(calls.length, calls[calls.length - 1]);
    if (m.throwNet) throw new TypeError('Failed to fetch');
    return new Response(typeof m.body === 'string' ? m.body : JSON.stringify(m.body ?? {}), {
      status: m.status ?? 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  return calls;
}

const base = { providerId: 'deepseek', apiKey: 'sk-test', text: 'helo wrld this is a sentance', fixes: ['spelling'], tonePreset: '' };

// 1. happy path + request shape
{
  const calls = withFetch(() => ({ body: envelope({ corrected: 'hello world this is a sentence', edits: [{ type: 'spelling', before: 'helo', after: 'hello' }] }) }));
  const r = await analyze(base);
  const body = calls[0].body;
  ok('happy: corrected text', r.corrected === 'hello world this is a sentence', r.corrected);
  ok('happy: changed flag', r.changed === true);
  ok('happy: edits parsed', r.edits.length === 1 && r.edits[0].type === 'spelling');
  ok('happy: usage reported', r.usage.tokensIn === 12 && r.usage.tokensOut === 14, r.usage);
  ok('request: deepseek endpoint', calls[0].url === 'https://api.deepseek.com/chat/completions', calls[0].url);
  ok('request: bearer auth', calls[0].headers.Authorization === 'Bearer sk-test');
  ok('request: model', body.model === 'deepseek-chat', body.model);
  ok('request: thinking disabled', body.thinking?.type === 'disabled', body.thinking);
  ok('request: json_object mode', body.response_format?.type === 'json_object', body.response_format);
  ok('request: temperature 0', body.temperature === 0);
  ok('request: max_tokens set', body.max_tokens > 0 && body.max_tokens <= 2048, body.max_tokens);
  ok('request: verbatim user text', body.messages[1].content === base.text);
  ok('request: prompt mentions json', /json/i.test(body.messages[0].content));
  ok('request: prompt forbids answering', /never answer/i.test(body.messages[0].content));
}

// 2. openai shape
{
  const calls = withFetch(() => ({ body: envelope({ corrected: 'x', edits: [] }) }));
  await analyze({ ...base, providerId: 'openai', model: 'gpt-4o-mini' });
  ok('openai: endpoint', calls[0].url === 'https://api.openai.com/v1/chat/completions', calls[0].url);
  ok('openai: json_schema mode', calls[0].body.response_format?.type === 'json_schema', calls[0].body.response_format?.type);
  ok('openai: no deepseek thinking flag', calls[0].body.thinking === undefined);
  ok('openai: model respected', calls[0].body.model === 'gpt-4o-mini');
}

// 2b. transient failures are retried once
{
  const calls = withFetch((n) => (n === 1
    ? { status: 429, body: { error: { message: 'slow down' } } }
    : { body: envelope({ corrected: 'hello world', edits: [] }) }));
  const r = await analyze(base);
  ok('429 then success retried', calls.length === 2 && r.corrected === 'hello world', calls.length);
}
{
  const calls = withFetch((n) => (n === 1
    ? { status: 503, body: { error: { message: 'unavailable' } } }
    : { body: envelope({ corrected: 'hello again', edits: [] }) }));
  const r = await analyze(base);
  ok('503 then success retried', calls.length === 2 && r.corrected === 'hello again', calls.length);
}

// 3. error taxonomy
{
  withFetch(() => ({ status: 401, body: { error: { message: 'bad key' } } }));
  await analyze(base).then(() => ok('401 mapped', false), (e) => ok('401 → INVALID_KEY', e.code === 'INVALID_KEY', e.code));
}
{
  withFetch(() => ({ status: 429, body: { error: { message: 'slow down' } } }));
  await analyze(base).then(() => ok('429 mapped', false), (e) => ok('429 → RATE_LIMIT', e.code === 'RATE_LIMIT', e.code));
}
{
  withFetch(() => ({ status: 500, body: { error: { message: 'boom' } } }));
  await analyze(base).then(() => ok('500 mapped', false), (e) => ok('500 → SERVER', e.code === 'SERVER', e.code));
}
{
  withFetch(() => ({ throwNet: true }));
  await analyze(base).then(() => ok('network mapped', false), (e) => ok('network → NETWORK', e.code === 'NETWORK', e.code));
}
{
  withFetch(() => ({ body: JSON.stringify({ choices: [{ message: { content: '{"corrected":"This sent' }, finish_reason: 'length' }] }) }));
  await analyze(base).then(() => ok('truncation mapped', false), (e) => ok('truncated → TRUNCATED', e.code === 'TRUNCATED', e.code));
}
{
  withFetch(() => ({ status: 400, body: { error: { message: 'model not found' } } }));
  await analyze(base).then(() => ok('bad model mapped', false), (e) => ok('bad model → MODEL', e.code === 'MODEL', e.code));
}

// 4. prose fallback
{
  withFetch(() => ({ body: JSON.stringify({ choices: [{ message: { content: 'hello world this is a sentence.' }, finish_reason: 'stop' }] }) }));
  const r = await analyze(base);
  ok('prose reply used as correction', r.corrected === 'hello world this is a sentence.');
}

// 5. empty content retried once
{
  const calls = withFetch((n) => (n === 1
    ? { body: JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }) }
    : { body: envelope({ corrected: 'hello world this is a sentence', edits: [] }) }));
  const r = await analyze(base);
  ok('empty first answer retried', calls.length === 2, calls.length);
  ok('retry without response_format', calls[1].body.response_format === undefined, calls[1].body.response_format);
  ok('retry result used', r.corrected === 'hello world this is a sentence');
}

// 6. always empty
{
  withFetch(() => ({ body: JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }) }));
  await analyze(base).then(() => ok('empty mapped', false), (e) => ok('empty → PARSE', e.code === 'PARSE', e.code));
}

// 7. no key
{
  withFetch(() => ({ body: envelope({ corrected: 'x' }) }));
  await analyze({ ...base, apiKey: '' }).then(() => ok('no key mapped', false), (e) => ok('no key → NO_KEY', e.code === 'NO_KEY', e.code));
}

// 8. long text gets a bigger budget
{
  const calls = withFetch(() => ({ body: envelope({ corrected: 'x' }) }));
  const long = 'word '.repeat(400).trim();
  await analyze({ ...base, text: long });
  ok('long text max_tokens grows', calls[0].body.max_tokens > 512, calls[0].body.max_tokens);
}

// 9. cost estimate
{
  const cost = estimateCost('deepseek', 1000, 1000);
  ok('cost estimate plausible', cost > 0 && cost < 0.01, cost);
  ok('deepseek default model', defaultModel('deepseek') === 'deepseek-chat');
  ok('openai default model', defaultModel('openai') === 'gpt-4o-mini');
}

// 10. listModels
{
  const calls = withFetch(() => ({ body: { data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] } }));
  const ids = await listModels({ providerId: 'deepseek', apiKey: 'sk-test' });
  ok('listModels parses ids', ids.length === 2 && ids[0] === 'deepseek-chat', ids);
  ok('listModels uses GET /models', calls[0].method === 'GET' && calls[0].url === 'https://api.deepseek.com/models', calls[0].url);
}

// 11. translation
{
  const calls = withFetch(() => ({
    body: JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ translation: 'To jest zdanie.', source_language: 'English' }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 12 },
    }),
  }));
  const r = await translate({ providerId: 'deepseek', apiKey: 'k', text: 'This is a sentence.', targetLabel: 'Polski (pl)' });
  const body = calls[0].body;
  ok('translate: result', r.translation === 'To jest zdanie.', r.translation);
  ok('translate: source language', r.sourceLanguage === 'English', r.sourceLanguage);
  ok('translate: endpoint', calls[0].url === 'https://api.deepseek.com/chat/completions');
  ok('translate: system prompt names target', /Polski \(pl\)/.test(body.messages[0].content));
  ok('translate: prompt asks for json', /json/i.test(body.messages[0].content));
  ok('translate: user message is the selection', body.messages[1].content === 'This is a sentence.');
  ok('translate: json_object mode', body.response_format?.type === 'json_object');
  ok('translate: usage reported', r.usage.tokensIn === 20 && r.usage.tokensOut === 12, r.usage);
}
{
  const calls = withFetch(() => ({ body: JSON.stringify({ choices: [{ message: { content: 'To jest zdanie.' }, finish_reason: 'stop' }] }) }));
  const r = await translate({ providerId: 'openai', apiKey: 'k', model: 'gpt-4o-mini', text: 'This is a sentence.', targetLabel: 'Deutsch (de)' });
  ok('translate: openai schema mode', calls[0].body.response_format?.type === 'json_schema', calls[0].body.response_format?.type);
  ok('translate: prose fallback', r.translation === 'To jest zdanie.', r.translation);
}
{
  withFetch(() => ({ status: 401, body: { error: { message: 'bad key' } } }));
  await translate({ providerId: 'deepseek', apiKey: 'k', text: 'x', targetLabel: 'English (en)' })
    .then(() => ok('translate 401 mapped', false), (e) => ok('translate 401 → INVALID_KEY', e.code === 'INVALID_KEY', e.code));
}
{
  withFetch(() => ({ body: JSON.stringify({ choices: [{ message: { content: '{"translation":"cut' }, finish_reason: 'length' }] }) }));
  await translate({ providerId: 'deepseek', apiKey: 'k', text: 'x', targetLabel: 'English (en)' })
    .then(() => ok('translate truncation mapped', false), (e) => ok('translate truncated → TRUNCATED', e.code === 'TRUNCATED', e.code));
}
{
  const calls = withFetch(() => ({ body: JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }) }));
  await translate({ providerId: 'deepseek', apiKey: 'k', text: 'x', targetLabel: 'English (en)' })
    .then(() => ok('translate empty mapped', false), (e) => ok('translate empty → PARSE', e.code === 'PARSE', e.code));
  ok('translate: empty answer retried once', calls.length === 2, calls.length);
}

// model picking for a key whose catalogue we only know at runtime
{
  ok('pickModel prefers the known-good chat model', pickModel('openai', ['gpt-4o-mini', 'gpt-4.1-mini']) === 'gpt-4.1-mini', pickModel('openai', ['gpt-4o-mini', 'gpt-4.1-mini']));
  ok('pickModel skips non-chat models', pickModel('openai', ['text-embedding-3-small', 'gpt-4o']) === 'gpt-4o', pickModel('openai', ['text-embedding-3-small', 'gpt-4o']));
  ok('pickModel skips previews when it can', pickModel('openai', ['gpt-5-preview', 'gpt-4o']) === 'gpt-4o', pickModel('openai', ['gpt-5-preview', 'gpt-4o']));
  ok('pickModel handles an empty list', pickModel('openai', []) === '');
  ok('isChatModel classifies ids', isChatModel('gpt-4o-mini') === true && isChatModel('whisper-1') === false && isChatModel('dall-e-3') === false);
  ok('modelLabel formats unknown ids', modelLabel('gpt-4o-mini') === 'GPT-4o mini' && modelLabel('gpt-5') === 'GPT-5' && modelLabel('deepseek-chat') === 'DeepSeek Chat', modelLabel('gpt-4o-mini'));
}

// ── neural voice instructions ──────────────────────────────────────────────
{
  const uk = ttsInstructions('Ukrainian');
  ok('tts: names the language it must speak', uk.includes('Read this Ukrainian text aloud in Ukrainian'), uk.slice(0, 60));
  ok('tts: forbids translating', uk.includes('Do not translate'));
  ok('tts: Polish is asked for in Polish', ttsInstructions('Polish').includes('Read this Polish text aloud in Polish'));
  const plain = ttsInstructions('');
  ok('tts: falls back to a plain instruction without a language', plain.includes('Pronounce this clearly') && !plain.includes('text aloud in'), plain.slice(0, 40));
}

console.log(failures === 0 ? '\nALL PROVIDER TESTS PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
