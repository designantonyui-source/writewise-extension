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
      return {ok:true, json:async () => ({candidates:[{finishReason:'STOP', content:{parts:[{text:'This is correct text.'}]}}]})};
    }
  });
  context.importScripts = name => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), context);
  return { context, sync, local, calls, access, listener,
    run:code => vm.runInContext(code, context) };
}
const sender = {id:'test-extension', url:'https://example.com/editor'};
const base = {dataSharingConsent:true, provider:'gemini'};
const input = 'This is corect text.';

test('legacy keys migrate locally, synced copies are removed, and local storage is restricted', async () => {
  const h = harness({sync:{claudeKey:'legacy', geminiKey:'old'}, local:{geminiKey:'new'}});
  const keys = await h.run('WriteWiseSecrets.get()');
  assert.equal(keys.claudeKey, 'legacy'); assert.equal(keys.geminiKey, 'new');
  assert.deepEqual(h.sync, {}); assert.deepEqual(h.access, ['TRUSTED_CONTEXTS']);
});
test('failed migration preserves legacy keys for recovery', async () => {
  const h = harness({sync:{geminiKey:'legacy'}, failWrite:true});
  await assert.rejects(h.run('WriteWiseSecrets.get()'), /disk full/);
  assert.equal(h.sync.geminiKey, 'legacy');
});
test('saving and deleting a key never writes it to sync storage', async () => {
  const h = harness();
  await h.run("WriteWiseSecrets.set('groqKey', 'test-key')");
  assert.equal(h.local.groqKey, 'test-key'); assert.deepEqual(h.sync, {});
  await h.run("WriteWiseSecrets.set('groqKey', '')"); assert.deepEqual(h.local, {});
});
for (const [label, override, error] of [
  ['consent missing', {dataSharingConsent:false}, 'CONSENT_REQUIRED'],
  ['disabled', {enabled:false}, 'PAUSED'],
  ['site paused', {pausedSites:['example.com']}, 'PAUSED'],
  ['all fix categories off', {spelling:false, grammar:false, clarity:false, tone:false}, 'NO_FIXES']
]) test(`worker blocks requests when ${label}`, async () => {
  const h = harness({sync:{...base, ...override}, local:{geminiKey:'fake-key'}});
  await assert.rejects(h.context.handleCorrection(input, sender), new RegExp(error));
  assert.equal(h.calls.length, 0);
});
test('worker rejects unsupported origins and oversized input before making a request', async () => {
  const h = harness({sync:base, local:{geminiKey:'fake-key'}});
  await assert.rejects(h.context.handleCorrection(input, {...sender,url:'file:///secret.txt'}), /UNSUPPORTED_PAGE/);
  await assert.rejects(h.context.handleCorrection('x'.repeat(12001), sender), /TEXT_LIMIT/);
  await assert.rejects(h.context.handleCorrection('word '.repeat(501), sender), /TEXT_LIMIT/);
  assert.equal(h.calls.length, 0);
});
for (const provider of ['gemini','claude','groq']) {
  for (const finish of ['complete','truncated','blocked','empty']) {
    test(`${provider}: ${finish} response ${finish === 'complete' ? 'is accepted' : 'cannot replace text'}`, async () => {
      const h = harness({sync:{...base,provider}, local:{[provider+'Key']:'fake-key'}});
      const text = finish === 'empty' ? '' : 'This is correct text.';
      const data = provider === 'claude'
        ? {stop_reason:finish === 'truncated' ? 'max_tokens' : finish === 'blocked' ? 'refusal' : 'end_turn', content:[{type:'text',text}]}
        : provider === 'groq'
          ? {choices:[{finish_reason:finish === 'truncated' ? 'length' : finish === 'blocked' ? 'content_filter' : 'stop', message:{content:text}}]}
          : {candidates:[{finishReason:finish === 'truncated' ? 'MAX_TOKENS' : finish === 'blocked' ? 'SAFETY' : 'STOP', content:{parts:[{text}]}}]};
      h.context.fetch = async (url, options) => { h.calls.push({url, ...options, body:JSON.parse(options.body)}); return {ok:true,json:async () => data}; };
      const promise = h.context.handleCorrection(input, sender);
      if (finish === 'complete') assert.equal((await promise).result, text);
      else await assert.rejects(promise, /INCOMPLETE_RESPONSE/);
      const request = h.calls[0];
      assert.ok((request.body.max_tokens || request.body.generationConfig?.maxOutputTokens) > 512);
      assert.ok(!request.url.includes('fake-key'));
    });
  }
}
test('provider errors do not expose response bodies or credentials', async () => {
  const h = harness({sync:base, local:{geminiKey:'fake-key'}});
  h.context.fetch = async () => ({ok:false, status:400, json:async () => ({error:{message:'secret text fake-key'}})});
  await assert.rejects(h.context.handleCorrection(input, sender), /^Error: API_ERROR_400$/);
});
