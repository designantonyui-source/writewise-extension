const {test, expect, chromium} = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs/promises');

// A toolbar popup has Chrome-controlled sizing. Opening popup.html in a tab does
// not exercise it. Use a headed browser and chrome.action.openPopup here.
async function attachPopup(context, worker) {
  const browser = await context.browser().newBrowserCDPSession();
  await worker.evaluate(async () => {
    const [window] = await chrome.windows.getAll({windowTypes:['normal']});
    await chrome.windows.update(window.id,{focused:true});
    await chrome.action.openPopup({windowId:window.id});
  });
  let target;
  await expect.poll(async () => {
    target = (await browser.send('Target.getTargets')).targetInfos.find(t => t.url.endsWith('/popup.html'));
    return Boolean(target);
  }).toBe(true);
  const {sessionId} = await browser.send('Target.attachToTarget', {targetId:target.targetId, flatten:false});
  let nextId = 0;
  const pending = new Map();
  browser.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const result = JSON.parse(event.message);
    if (!pending.has(result.id)) return;
    const {resolve,reject} = pending.get(result.id);
    pending.delete(result.id);
    result.error ? reject(new Error(result.error.message)) : resolve(result.result);
  });
  const send = (method, params = {}) => new Promise((resolve,reject) => {
    const id = ++nextId;
    pending.set(id, {resolve,reject});
    browser.send('Target.sendMessageToTarget', {sessionId,message:JSON.stringify({id,method,params})}).catch(reject);
  });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', {expression,returnByValue:true,awaitPromise:true});
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  };
  const click = async selector => {
    const point = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.scrollIntoView({block:'center'});
      const rect = el.getBoundingClientRect();
      return {x:rect.x + rect.width/2,y:rect.y + rect.height/2};
    })()`);
    await send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point});
    await send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point});
  };
  return {send,evaluate,click};
}

for (const state of ['consent','missing-key','saved-key']) {
  test(`real Chrome toolbar popup: ${state} stays full width with reachable controls`, async ({}, testInfo) => {
    const extension = path.resolve(__dirname,'..');
    const context = await chromium.launchPersistentContext('', {
      channel:'chromium', headless:false,
      args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]
    });
    try {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      await worker.evaluate(async state => {
        await WriteWiseSecrets.ready;
        await chrome.storage.sync.clear(); await chrome.storage.local.clear();
        if (state !== 'consent') await chrome.storage.sync.set({
          dataSharingConsent:true,providerConsentVersion:3,provider:'openai'
        });
        if (state === 'saved-key') await chrome.storage.local.set({openaiKey:'fake-toolbar-test-key'});
      }, state);
      const popup = await attachPopup(context,worker);
      await expect.poll(() => popup.evaluate('innerWidth')).toBe(360);
      await expect.poll(() => popup.evaluate(`!document.querySelector('${state === 'consent' ? '#privacyConsent' : '#main-app'}').hidden`)).toBe(true);
      // Chrome briefly creates the surface at 25 px before its first layout.
      await expect.poll(() => popup.evaluate('innerHeight')).toBeGreaterThan(300);
      const dimensions = await popup.evaluate(`({
        width:innerWidth,height:innerHeight,bodyWidth:document.body.getBoundingClientRect().width,
        scrollWidth:document.documentElement.scrollWidth
      })`);
      expect(dimensions.bodyWidth).toBe(360);
      expect(dimensions.scrollWidth).toBe(dimensions.width);
      expect(dimensions.height).toBeGreaterThan(300);
      expect(dimensions.height).toBeLessThanOrEqual(600);
      // Capture the actual toolbar surface, without resizing its viewport.
      const image = await popup.send('Page.captureScreenshot', {format:'png'});
      const screenshotPath = testInfo.outputPath(`toolbar-${state}.png`);
      await fs.writeFile(screenshotPath,Buffer.from(image.data,'base64'));
      await testInfo.attach(`toolbar-${state}`, {path:screenshotPath,contentType:'image/png'});
      if (state === 'consent') {
        const button = await popup.evaluate('document.querySelector("#acceptPrivacy").getBoundingClientRect().toJSON()');
        expect(button.bottom).toBeLessThanOrEqual(dimensions.height);
        await popup.click('#acceptPrivacy');
        await expect.poll(() => popup.evaluate('!document.querySelector("#main-app").hidden')).toBe(true);
        await expect.poll(() => popup.evaluate('innerWidth')).toBe(360);
      } else {
        expect(await popup.evaluate('document.querySelector("#connectionDetails").open')).toBe(state === 'missing-key');
        await popup.click('#preferencesDetails summary');
        expect(await popup.evaluate('document.querySelector("#preferencesDetails").open')).toBe(true);
        await popup.click('#revokePrivacy');
        await expect.poll(() => popup.evaluate('!document.querySelector("#privacyConsent").hidden')).toBe(true);
        await expect.poll(() => popup.evaluate('innerWidth')).toBe(360);
      }
    } finally { await context.close(); }
  });
}
