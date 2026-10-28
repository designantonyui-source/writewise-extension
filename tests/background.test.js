const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness({ sync = {}, local = {}, failWrite = false } = {}) {
  const access = [];
  const calls = [];
  let listener;
  const area = (data) => ({
    async get(keys) {
      if (typeof keys === 'string') keys = [keys];
      return Object.fromEntries((keys || Object.keys(data)).filter(k => k in data).map(k => [k, data[k]]));
    },
    async set(values) { if (failWrite) throw new Error('disk full'); Object.assign(data, values); },
    async remove(keys) { for (const k of [keys].flat()) delete data[k]; },
    async setAccessLevel(value) { access.push(value.accessLevel); }
  });
  const context = vm.createContext({
    chrome: {
      runtime: { id:'test-extension', onInstalled:{ addListener() {} }, onMessage:{ addListener(fn) { listener = fn; } } },
      storage: { sync:area(sync), local:area(local) },
      contextMenus: { create() {}, onClicked:{ addListener() {} } }, tabs:{}
    }, URL, AbortController, setTimeout, clearTimeout,
    fetch:async (url, options) => {
      calls.push({url, ...options, body:JSON.parse(options.body)});
      return {ok:true, json:async () => ({choices:[{finish_reason:'stop', message:{content:'This is correct text.'}}]})};
    }
  });
  context.importScripts = (...names) => names.forEach(name => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), context);
  return { context, sync, local, calls, access, listener,
    run:code => vm.runInContext(code, context) };
}
const sender = {id:'test-extension', url:'https://example.com/editor'};
const base = {dataSharingConsent:true, providerConsentVersion:3, provider:'openai'};
const input = 'This is corect text.';

test('legacy keys migrate locally, synced copies are removed, and local storage is restricted', async () => {
  const h = harness({sync:{deepseekKey:'legacy', openaiKey:'old'}, local:{openaiKey:'new'}});
  const keys = await h.run('WriteWiseSecrets.get()');
  assert.equal(keys.deepseekKey, 'legacy'); assert.equal(keys.openaiKey, 'new');
  assert.deepEqual(h.sync, {}); assert.deepEqual(h.access, ['TRUSTED_CONTEXTS']);
});
test('failed migration preserves legacy keys for recovery', async () => {
  const h = harness({sync:{openaiKey:'legacy'}, failWrite:true});
  await assert.rejects(h.run('WriteWiseSecrets.get()'), /disk full/);
  assert.equal(h.sync.openaiKey, 'legacy');
});
test('saving and deleting a key never writes it to sync storage', async () => {
  const h = harness();
  await h.run("WriteWiseSecrets.set('deepseekKey', 'test-key')");
  assert.equal(h.local.deepseekKey, 'test-key'); assert.deepEqual(h.sync, {});
  await h.run("WriteWiseSecrets.set('deepseekKey', '')"); assert.deepEqual(h.local, {});
});
for (const [label, override, error] of [
  ['consent missing', {dataSharingConsent:false}, 'CONSENT_REQUIRED'],
  ['disabled', {enabled:false}, 'PAUSED'],
  ['site paused', {pausedSites:['example.com']}, 'PAUSED'],
  ['all fix categories off', {spelling:false, grammar:false, clarity:false, tone:false}, 'NO_FIXES']
]) test(`worker blocks requests when ${label}`, async () => {
  const h = harness({sync:{...base, ...override}, local:{openaiKey:'fake-key'}});
  await assert.rejects(h.context.handleCorrection(input, sender), new RegExp(error));
  assert.equal(h.calls.length, 0);
});
test('worker rejects unsupported origins and oversized input before making a request', async () => {
  const h = harness({sync:base, local:{openaiKey:'fake-key'}});
  await assert.rejects(h.context.handleCorrection(input, {...sender,url:'file:///secret.txt'}), /UNSUPPORTED_PAGE/);
  await assert.rejects(h.context.handleCorrection('x'.repeat(12001), sender), /TEXT_LIMIT/);
  await assert.rejects(h.context.handleCorrection('word '.repeat(501), sender), /TEXT_LIMIT/);
  assert.equal(h.calls.length, 0);
});
for (const provider of ['openai','deepseek']) {
  for (const finish of ['complete','truncated','blocked','empty']) {
    test(`${provider}: ${finish} response ${finish === 'complete' ? 'is accepted' : 'cannot replace text'}`, async () => {
      const h = harness({sync:{...base,provider}, local:{[provider+'Key']:'fake-key'}});
      const text = finish === 'empty' ? '' : 'This is correct text.';
      const data = {choices:[{finish_reason:finish === 'truncated' ? 'length' : finish === 'blocked' ? 'content_filter' : 'stop', message:{content:text}}]};
      h.context.fetch = async (url, options) => { h.calls.push({url, ...options, body:JSON.parse(options.body)}); return {ok:true,json:async () => data}; };
      const promise = h.context.handleCorrection(input, sender);
      if (finish === 'complete') assert.equal((await promise).result, text);
      else await assert.rejects(promise, /INCOMPLETE_RESPONSE/);
      const request = h.calls[0];
      assert.ok((request.body.max_tokens || request.body.max_completion_tokens) > 512);
      assert.ok(!request.url.includes('fake-key'));
      assert.equal(request.headers.Authorization,'Bearer fake-key');
      assert.ok(request.url.startsWith(provider === 'openai' ? 'https://api.openai.com/' : 'https://api.deepseek.com/'));
      if (provider === 'openai') {
        assert.equal(request.body.store,false); assert.equal(request.body.reasoning_effort,'none');
        assert.equal(request.body.model,'gpt-5.4-mini');
      } else {
        assert.equal(request.body.thinking.type,'disabled'); assert.equal(request.body.model,'deepseek-flash');
      }
    });
  }
}
test('provider errors do not expose response bodies or credentials', async () => {
  const h = harness({sync:base, local:{openaiKey:'fake-key'}});
  h.context.fetch = async () => ({ok:false, status:400, json:async () => ({error:{message:'secret text fake-key'}})});
  await assert.rejects(h.context.handleCorrection(input, sender), /^Error: API_ERROR_400$/);
});

test('retired provider credentials are removed from local and sync storage', async () => {
  const h = harness({sync:{geminiKey:'old-google',groqKey:'old-groq'},local:{claudeKey:'old-anthropic'}});
  await h.run('WriteWiseSecrets.ready');
  assert.deepEqual(h.sync,{}); assert.deepEqual(h.local,{});
});
test('old consent does not authorize new providers', async () => {
  const h = harness({sync:{...base,providerConsentVersion:1},local:{openaiKey:'fake-key'}});
  await assert.rejects(h.context.handleCorrection(input,sender),/CONSENT_REQUIRED/);
  assert.equal(h.calls.length,0);
});
test('unsupported provider names cannot send a request', async () => {
  for (const provider of ['claude','gemini','groq','constructor','__proto__']) {
    const h = harness({sync:{...base,provider},local:{openaiKey:'fake-key'}});
    await assert.rejects(h.context.handleCorrection(input,sender),/INVALID_PROVIDER/);
    assert.equal(h.calls.length,0);
  }
});

for (const provider of ['openai','deepseek']) {
  for (const [language,name] of [['en','English'],['pl','Polish'],['ru','Russian'],['uk','Ukrainian']]) {
    test(`${provider} translates short selections into ${name} without changing writing-check behavior`, async () => {
      const h = harness({sync:{...base,provider,translationLanguage:language,spelling:false,grammar:false,clarity:false,tone:false},local:{[provider+'Key']:'fake-key'}});
      const result = await h.context.handleCorrection('hi',sender,'translate');
      assert.equal(result.language,language);
      assert.match(h.calls[0].body.messages[0].content,new RegExp(`Translate the supplied text into ${name}`));
      assert.equal(h.calls[0].body.messages[1].content,'hi');
      await assert.rejects(h.context.handleCorrection('hi',sender),/TEXT_LIMIT/);
    });
  }
}
for (const [label,overrides,error] of [
  ['translation disabled',{doubleClickTranslate:false},'TRANSLATION_DISABLED'],
  ['globally paused',{enabled:false},'PAUSED'],
  ['site paused',{pausedSites:['example.com']},'PAUSED'],
  ['consent missing',{dataSharingConsent:false},'CONSENT_REQUIRED'],
  ['old writing-only consent',{providerConsentVersion:2},'CONSENT_REQUIRED'],
  ['invalid language',{translationLanguage:'constructor'},'INVALID_LANGUAGE']
]) test(`translation is blocked when ${label}`, async () => {
  const h = harness({sync:{...base,...overrides},local:{openaiKey:'fake-key'}});
  await assert.rejects(h.context.handleCorrection('Bonjour',sender,'translate'),new RegExp(error));
  assert.equal(h.calls.length,0);
});
test('incomplete translation cannot be offered as a successful result', async () => {
  const h = harness({sync:base,local:{openaiKey:'fake-key'}});
  h.context.fetch = async () => ({ok:true,json:async () => ({choices:[{finish_reason:'length',message:{content:'Partial'}}]})});
  await assert.rejects(h.context.handleCorrection('Bonjour',sender,'translate'),/INCOMPLETE_RESPONSE/);
});
