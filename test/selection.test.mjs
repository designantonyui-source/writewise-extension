import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';

const source = readFileSync(new URL('../content/content.js', import.meta.url), 'utf8');

function harness({ autoCheck = true, translate = true, deferTranslate = false } = {}) {
  const listeners = new Map();
  const messages = [];
  const states = [];
  const timers = new Map();
  let nextTimer = 0;
  let selectedPageText = '';
  let pendingTranslation = null;

  class Input {
    constructor() {
      this.nodeType = 1;
      this.tagName = 'INPUT';
      this.type = 'search';
      this.disabled = false;
      this.readOnly = false;
      this.isContentEditable = false;
      this.isConnected = true;
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.value = '';
    }
    getAttribute() { return ''; }
    contains(node) { return node === this; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 300, bottom: 36 }; }
    dispatchEvent() {}
  }

  const field = new Input();
  const page = { nodeType: 1, isContentEditable: false, parentElement: null };
  const editor = {
    nodeType: 1,
    tagName: 'DIV',
    isContentEditable: true,
    isConnected: true,
    innerText: '',
    contains(node) { return node === this; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 300, bottom: 100 }; },
  };
  const range = {
    commonAncestorContainer: page,
    startContainer: page,
    endContainer: page,
    cloneRange() { return this; },
    getBoundingClientRect() { return { left: 0, top: 40, right: 100, bottom: 60 }; },
  };
  const selection = {
    rangeCount: 1,
    isCollapsed: false,
    toString: () => selectedPageText,
    getRangeAt: () => range,
  };
  const document = {
    activeElement: field,
    getElementById: () => null,
    addEventListener: (name, fn) => listeners.set(name, fn),
  };
  const settings = {
    provider: 'deepseek',
    keys: { deepseek: 'fake-key' },
    autoCheck,
    translate: { enabled: translate, onSelect: translate },
  };
  const chrome = {
    storage: {
      local: { get: async () => ({ ww_settings: settings }) },
      onChanged: { addListener() {} },
    },
    runtime: {
      id: 'test-extension',
      onMessage: { addListener(fn) { listeners.set('message', fn); } },
      sendMessage(message, callback) {
        messages.push(message);
        if (message.type === 'ANALYZE') {
          callback({ ok: true, result: { corrected: message.text, changed: false, model: 'deepseek-chat' } });
        } else if (message.type === 'TRANSLATE') {
          const result = { ok: true, result: { translation: 'tłumaczenie', sourceLanguage: 'English', targetLabel: 'Polski' } };
          if (deferTranslate) pendingTranslation = () => callback(result);
          else callback(result);
        } else callback({ ok: true });
      },
    },
  };
  const window = {
    __wwUI: {
      show: (_anchor, state) => states.push(state),
      hide() {},
      setTheme() {},
      onAction() {},
    },
    getSelection: () => selection,
  };
  const context = createContext({
    window, document, chrome,
    location: { hostname: 'example.com' },
    Node: { ELEMENT_NODE: 1 },
    HTMLInputElement: Input,
    HTMLTextAreaElement: Input,
    setTimeout: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  new Script(source).runInContext(context);

  return {
    field, page, editor, document, messages, states, listeners,
    selectInput(text, start = 0) {
      field.value = text;
      field.selectionStart = start;
      field.selectionEnd = text.length;
      document.activeElement = field;
    },
    selectPage(text) {
      selectedPageText = text;
      document.activeElement = page;
    },
    selectEditor(text) {
      editor.innerText = text;
      selectedPageText = text;
      range.commonAncestorContainer = editor;
      range.startContainer = editor;
      range.endContainer = editor;
      document.activeElement = editor;
    },
    flushTimers() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach(fn => fn());
    },
    deliverTranslation() { pendingTranslation?.(); },
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

async function run(name, fn) {
  await fn();
  console.log(`PASS  ${name}`);
}

await run('selecting an input checks writing, without translating', async () => {
  const h = harness();
  await settle();
  h.selectInput('this is a good pracitse');
  h.listeners.get('mouseup')({ button: 0, target: h.field });
  h.flushTimers();
  await settle();
  assert.deepEqual(h.messages.filter(m => m.type === 'ANALYZE').map(m => m.text), ['this is a good pracitse']);
  assert.equal(h.messages.some(m => m.type === 'TRANSLATE'), false);
});

await run('double-clicking an input checks once', async () => {
  const h = harness();
  await settle();
  h.selectInput('practise');
  h.listeners.get('mouseup')({ button: 0, target: h.field });
  h.listeners.get('dblclick')({ target: h.field });
  h.flushTimers();
  await settle();
  assert.equal(h.messages.filter(m => m.type === 'ANALYZE').length, 1);
  assert.equal(h.messages.some(m => m.type === 'TRANSLATE'), false);
});

await run('selecting page content still translates', async () => {
  const h = harness();
  await settle();
  h.selectPage('resilience');
  h.listeners.get('mouseup')({ button: 0, target: h.page });
  h.flushTimers();
  await settle();
  assert.deepEqual(h.messages.filter(m => m.type === 'TRANSLATE').map(m => m.text), ['resilience']);
  assert.equal(h.messages.some(m => m.type === 'ANALYZE'), false);
});

await run('selecting contenteditable writing checks the selected text', async () => {
  const h = harness();
  await settle();
  h.selectEditor('this needs a fix');
  h.listeners.get('mouseup')({ button: 0, target: h.editor });
  h.flushTimers();
  await settle();
  assert.deepEqual(h.messages.filter(m => m.type === 'ANALYZE').map(m => m.text), ['this needs a fix']);
  assert.equal(h.messages.some(m => m.type === 'TRANSLATE'), false);
});

await run('explicit translation inside an input remains available', async () => {
  const h = harness();
  await settle();
  h.selectInput('resilience');
  h.listeners.get('message')({ type: 'TRANSLATE_SELECTION' }, null, () => {});
  await settle();
  assert.deepEqual(h.messages.filter(m => m.type === 'TRANSLATE').map(m => m.text), ['resilience']);
});

await run('automatic writing checks respect the auto-check setting', async () => {
  const h = harness({ autoCheck: false });
  await settle();
  h.selectInput('this is a good pracitse');
  h.listeners.get('mouseup')({ button: 0, target: h.field });
  h.flushTimers();
  await settle();
  assert.equal(h.messages.some(m => m.type === 'ANALYZE' || m.type === 'TRANSLATE'), false);
});

await run('typing invalidates a late translation response', async () => {
  const h = harness({ deferTranslate: true });
  await settle();
  h.selectInput('resilience');
  h.listeners.get('message')({ type: 'TRANSLATE_SELECTION' }, null, () => {});
  await settle();
  h.listeners.get('input')({ target: h.field, isComposing: false });
  h.deliverTranslation();
  await settle();
  assert.equal(h.states.includes('translation'), false);
});

console.log('\nALL SELECTION TESTS PASS');
