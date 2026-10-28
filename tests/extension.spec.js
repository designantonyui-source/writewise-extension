const { test:base, expect, chromium } = require('@playwright/test');
const http = require('node:http');
const path = require('node:path');

const test = base.extend({
  app: async ({}, use) => {
    const server = http.createServer((req,res) => {
      res.setHeader('Content-Type','text/html');
      res.end(`<!doctype html><html><body style="padding:30px"><h1>Writing fixture</h1>
        <label>First draft<textarea id="first" style="display:block;width:400px;height:80px"></textarea></label>
        <label>Second draft<textarea id="second" style="display:block;width:400px;height:80px"></textarea></label>
        <div id="rich" contenteditable="true" role="textbox" aria-label="Rich draft" style="width:400px;padding:20px;border:1px solid"><b>This is corect text.</b> <a href="/">Keep this link</a></div>
        <input id="password" type="password" aria-label="Password"><input id="payment" autocomplete="cc-number" aria-label="Card">
        <textarea id="private" data-writewise="off" aria-label="Private draft"></textarea>
        <script>window.inputEvents = 0; document.querySelector('#first').addEventListener('input',()=>window.inputEvents++);</script>
        </body></html>`);
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const extension = path.resolve(__dirname,'..');
    const context = await chromium.launchPersistentContext('', {
      channel:'chromium', headless:process.env.HEADED !== '1',
      args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = worker.url().split('/')[2];
    await worker.evaluate(async () => {
      await WriteWiseSecrets.ready;
      await chrome.storage.local.set({geminiKey:'fake-test-key'});
      await chrome.storage.sync.set({dataSharingConsent:true, enabled:true, provider:'gemini', autoCheckEnabled:false});
      globalThis.requests = [];
      globalThis.fixture = {text:'This is correct text.', finish:'STOP', hold:false};
      globalThis.fetch = async (url, options) => {
        requests.push({url, body:JSON.parse(options.body)});
        if (fixture.hold) await new Promise(resolve => { globalThis.releaseRequest = resolve; });
        return {ok:true,json:async () => ({candidates:[{finishReason:fixture.finish,content:{parts:[{text:fixture.text}]}}]})};
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url);
    const popup = () => context.newPage().then(async p => { await p.goto(`chrome-extension://${extensionId}/popup.html`); return p; });
    try { await use({context,worker,page,popup,url}); }
    finally { await context.close(); await new Promise(resolve => server.close(resolve)); expect(errors).toEqual([]); }
  }
});
const field = page => page.getByLabel('First draft');
const apply = page => page.getByRole('button',{name:'✓ Apply',exact:true});
const anchor = page => page.getByRole('button',{name:'Check with WriteWise',exact:true});
async function check(page, text = 'This is corect text.') {
  await field(page).fill(text); await anchor(page).click();
}
async function selection(app, start, end) {
  await field(app.page).evaluate((el,{start,end}) => {el.focus();el.setSelectionRange(start,end);},{start,end});
  await app.worker.evaluate(async url => {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    await chrome.tabs.sendMessage(tab.id,{type:'CHECK_SELECTION',text:'ignored; actual selection must be used'});
  },app.url);
}

test('manual check applies to the original field, preserves whitespace, dispatches input, and supports undo', async ({app}) => {
  await check(app.page,'  This is corect text.\n');
  await expect(apply(app.page)).toBeVisible();
  const eventsBefore = await app.page.evaluate(() => inputEvents);
  await apply(app.page).click();
  await expect(field(app.page)).toHaveValue('  This is correct text.\n');
  expect(await app.page.evaluate(() => inputEvents)).toBe(eventsBefore + 1);
  await app.page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(field(app.page)).toHaveValue('  This is corect text.\n');
  expect(await app.page.evaluate(() => sessionStorage.getItem('__ww_last'))).toBeNull();
});
test('switching fields while a request is pending cannot apply to the other field', async ({app}) => {
  await app.worker.evaluate(() => {fixture.hold = true;});
  await app.page.getByLabel('Second draft').fill('Keep this separate draft.');
  await check(app.page);
  await expect.poll(() => app.worker.evaluate(() => requests.length)).toBe(1);
  await app.page.getByLabel('Second draft').focus();
  await app.worker.evaluate(() => {releaseRequest();});
  await expect(app.page.getByText('Analysing your text…')).toBeHidden();
  await expect(apply(app.page)).toBeHidden();
  await expect(app.page.getByLabel('Second draft')).toHaveValue('Keep this separate draft.');
});
test('programmatic edits after a suggestion prevent stale replacement', async ({app}) => {
  await check(app.page); await expect(apply(app.page)).toBeVisible();
  await field(app.page).evaluate(el => {el.value = 'A new draft without an input event.';});
  await apply(app.page).click();
  await expect(field(app.page)).toHaveValue('A new draft without an input event.');
});
test('selected-text checking sends and replaces only the selected section', async ({app}) => {
  const selected = 'This is corect text.';
  const before = 'Keep before. ';
  await field(app.page).fill(before + selected + ' Keep after.');
  await selection(app,before.length,before.length + selected.length);
  await apply(app.page).click();
  await expect(field(app.page)).toHaveValue(before+'This is correct text. Keep after.');
  expect(await app.worker.evaluate(() => requests[0].body.contents[0].parts[0].text)).toBe(selected);
});
test('rich text shows copy-only suggestions and preserves links, formatting, and editor state', async ({app}) => {
  const rich = app.page.getByRole('textbox',{name:'Rich draft'});
  await rich.press('End'); await rich.press('Space');
  const html = await rich.innerHTML();
  await anchor(app.page).click();
  await expect(app.page.getByRole('button',{name:'Copy correction'})).toBeVisible();
  await expect(apply(app.page)).toHaveCount(0);
  await rich.press('Tab');
  expect(await rich.innerHTML()).toBe(html);
});
test('truncated AI responses show an error and cannot replace text', async ({app}) => {
  await app.worker.evaluate(() => {fixture.finish = 'MAX_TOKENS';fixture.text = 'Incomplete';});
  await check(app.page);
  await expect(app.page.getByText(/AI response was incomplete/)).toBeVisible();
  await expect(apply(app.page)).toHaveCount(0);
  await expect(field(app.page)).toHaveValue('This is corect text.');
});
test('pause cancels queued automatic checks and blocks the selection command', async ({app}) => {
  await app.worker.evaluate(async () => {await chrome.storage.sync.set({autoCheckEnabled:true, delay:4000});});
  await field(app.page).fill('This is corect text.');
  await app.worker.evaluate(async () => {await chrome.storage.sync.set({pausedSites:['127.0.0.1']});});
  await expect(anchor(app.page)).toBeHidden();
  await selection(app,0,20);
  await app.page.clock.install(); await app.page.clock.fastForward(10000);
  expect(await app.worker.evaluate(() => requests.length)).toBe(0);
});
test('automatic checking is off by default and works after opt-in', async ({app}) => {
  const popup = await app.popup();
  await expect(popup.getByLabel('Check automatically after typing')).not.toBeChecked();
  await app.page.clock.install();
  await field(app.page).fill('This is corect text.');
  await app.page.clock.fastForward(5000);
  expect(await app.worker.evaluate(() => requests.length)).toBe(0);
  await popup.getByLabel('Check automatically after typing').check();
  await expect.poll(() => app.worker.evaluate(async () => (await chrome.storage.sync.get('autoCheckEnabled')).autoCheckEnabled)).toBe(true);
  await field(app.page).fill('This is anoter draft.');
  await app.page.clock.fastForward(2500);
  await expect(apply(app.page)).toBeVisible();
});
test('consent is required for existing users and can be revoked', async ({app}) => {
  await app.worker.evaluate(async () => {await chrome.storage.sync.remove('dataSharingConsent');});
  const popup = await app.popup();
  await expect(popup.getByRole('button',{name:'Allow checks and continue'})).toBeVisible();
  await field(app.page).fill('This is corect text.'); await expect(anchor(app.page)).toBeHidden();
  await popup.getByRole('button',{name:'Allow checks and continue'}).click();
  await expect(popup.locator('#main-app')).toBeVisible();
  await popup.getByRole('button',{name:'Stop sharing text'}).click();
  await expect(popup.locator('#privacyConsent')).toBeVisible();
  await field(app.page).fill('Another corect draft.'); await expect(anchor(app.page)).toBeHidden();
  expect(await app.worker.evaluate(() => requests.length)).toBe(0);
});
test('credentials are local, Groq-only setup reopens, and fix options toggle once', async ({app}) => {
  await app.worker.evaluate(async () => {
    await chrome.storage.local.remove('geminiKey');
    await chrome.storage.local.set({groqKey:'fake-groq-only'});
    await chrome.storage.sync.set({provider:'groq'});
  });
  const popup = await app.popup();
  await expect(popup.locator('#main-app')).toBeVisible();
  await expect(popup.locator('#groqKeyInput')).toHaveValue('fake-groq-only');
  await popup.locator('#fix-spelling').click();
  await expect(popup.locator('#fix-spelling input')).not.toBeChecked();
  await expect.poll(() => app.worker.evaluate(async () => (await chrome.storage.sync.get('spelling')).spelling)).toBe(false);
  await popup.locator('#groqKeyInput').fill(''); await popup.getByRole('button',{name:'Save',exact:true}).filter({visible:true}).click();
  await expect.poll(() => app.worker.evaluate(async () => (await chrome.storage.local.get('groqKey')).groqKey)).toBe(undefined);
  expect(await app.worker.evaluate(async () => Object.keys(await chrome.storage.sync.get(['groqKey','geminiKey','claudeKey'])))).toEqual([]);
});
test('password, payment, and opted-out fields are excluded', async ({app}) => {
  for (const name of ['Password','Card','Private draft']) {
    await app.page.getByLabel(name,{exact:true}).fill('Sensitive test text');
    await expect(anchor(app.page)).toBeHidden();
  }
  expect(await app.worker.evaluate(() => requests.length)).toBe(0);
});

test('new users can choose Groq during onboarding and reopen the saved configuration', async ({app}) => {
  await app.worker.evaluate(async () => {
    await chrome.storage.local.remove(['claudeKey','geminiKey','groqKey']);
    await chrome.storage.sync.remove('dataSharingConsent');
  });
  const popup = await app.popup();
  await popup.getByRole('button',{name:'Allow checks and continue'}).click();
  await popup.locator('#ob-groq-btn').click();
  await popup.getByRole('button',{name:'Continue →',exact:true}).click();
  await popup.locator('#ob-key-input').fill('gsk_fake-new-key');
  await popup.getByRole('button',{name:'Save & Continue'}).click();
  await popup.getByRole('button',{name:'Open settings'}).click();
  await expect(popup.locator('#groqKeyInput')).toHaveValue('gsk_fake-new-key');
  await popup.close();
  const reopened = await app.popup();
  await expect(reopened.locator('#panel-groq')).toBeVisible();
});
test('restricted local storage cannot be read from the actual content-script world', async ({app}) => {
  const session = await app.context.newCDPSession(app.page);
  const worlds = [];
  session.on('Runtime.executionContextCreated', ({context}) => worlds.push(context));
  await session.send('Runtime.enable');
  const world = worlds.find(w => w.origin.startsWith('chrome-extension://'));
  expect(world).toBeTruthy();
  const result = await session.send('Runtime.evaluate', {
    contextId:world.id, awaitPromise:true, returnByValue:true,
    expression:'chrome.storage.local.get(["geminiKey"]).then(() => "ACCESS_GRANTED", () => "ACCESS_DENIED")'
  });
  expect(result.result.value).toBe('ACCESS_DENIED');
});
test('an old synced key is migrated when settings reopen, and stays out of sync', async ({app}) => {
  await app.worker.evaluate(async () => {
    await chrome.storage.sync.set({groqKey:'fake-legacy-key',provider:'groq'});
  });
  const popup = await app.popup();
  await expect(popup.locator('#groqKeyInput')).toHaveValue('fake-legacy-key');
  expect(await app.worker.evaluate(async () => (await chrome.storage.sync.get('groqKey')).groqKey)).toBe(undefined);
});
test('undo cannot overwrite a later programmatic edit', async ({app}) => {
  await check(app.page); await apply(app.page).click();
  await field(app.page).evaluate(el => {el.value = 'A newer draft.';});
  await app.page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(field(app.page)).toHaveValue('A newer draft.');
});
test('Tab applies a suggestion and Enter still inserts a newline', async ({app}) => {
  await check(app.page); await expect(apply(app.page)).toBeVisible();
  await field(app.page).press('Tab');
  await expect(field(app.page)).toHaveValue('This is correct text.');
  await field(app.page).press('End'); await field(app.page).press('Enter');
  await expect(field(app.page)).toHaveValue('This is correct text.\n');
});

test('website scripts cannot click the check or apply controls to spend keys or replace drafts', async ({app}) => {
  await field(app.page).fill('This is corect text.');
  await anchor(app.page).evaluate(el => el.click());
  expect(await app.worker.evaluate(() => requests.length)).toBe(0);
  await anchor(app.page).click(); await expect(apply(app.page)).toBeVisible();
  await apply(app.page).evaluate(el => el.click());
  await field(app.page).evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true})));
  await expect(field(app.page)).toHaveValue('This is corect text.');
  await apply(app.page).click();
  await expect(field(app.page)).toHaveValue('This is correct text.');
});
test('synthetic website input cannot trigger automatic checking', async ({app}) => {
  await app.worker.evaluate(async () => {await chrome.storage.sync.set({autoCheckEnabled:true});});
  await app.page.clock.install();
  await field(app.page).evaluate(el => {el.focus();el.value = 'Website generated text.';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await app.page.clock.fastForward(10000);
  expect(await app.worker.evaluate(() => requests.length)).toBe(0);
});
