let selectedProvider = 'openai';
let savedKeys = {};
let siteDomain = null;

const $ = id => document.getElementById(id);
function showStorageError() { $('storageError').hidden = false; }
function normalizeProvider(provider) {
  return Object.hasOwn(WriteWiseProviders, provider) ? provider : 'openai';
}

async function openApp() {
  const [keys, settings] = await Promise.all([
    WriteWiseSecrets.get(), chrome.storage.sync.get(null)
  ]);
  savedKeys = keys;
  const consented = settings.dataSharingConsent === true && settings.providerConsentVersion === WriteWiseConsentVersion;
  $('privacyConsent').hidden = consented;
  $('main-app').hidden = !consented;
  if (!consented) return;
  selectedProvider = normalizeProvider(settings.provider);
  if (settings.provider !== selectedProvider) await chrome.storage.sync.set({provider:selectedProvider});
  $('masterToggle').checked = settings.enabled !== false;
  updateStatus();
  $('autoCheckToggle').checked = settings.autoCheckEnabled === true;
  $('checkDelay').value = [500,1500,2000,4000].includes(settings.delay) ? settings.delay : 2000;
  for (const name of ['spelling','grammar','clarity','tone']) {
    $('fix-' + name).querySelector('input').checked = settings[name] !== false;
  }
  $('tonePreset').value = settings.tonePreset || '';
  $('tonePresetRow').hidden = settings.tone === false;
  renderProvider();
  const {wwStats} = await chrome.storage.local.get('wwStats');
  const count = wwStats?.date === new Date().toDateString() ? wwStats.count : 0;
  $('sessionStats').textContent = count ? `${count} correction${count === 1 ? '' : 's'} today` : 'Review before you apply';
  await loadSite();
}

function renderProvider() {
  const config = WriteWiseProviders[selectedProvider];
  for (const provider of Object.keys(WriteWiseProviders)) {
    $('tab-' + provider).setAttribute('aria-pressed', String(provider === selectedProvider));
  }
  $('modelLabel').textContent = config.modelLabel;
  $('keyLabel').textContent = `${config.name} API key`;
  $('apiKeyInput').value = savedKeys[selectedProvider + 'Key'] || '';
  $('apiKeyInput').type = 'password';
  $('keyEye').setAttribute('aria-label', 'Show API key');
  $('keyEye').setAttribute('aria-pressed', 'false');
  $('keyHelp').href = config.keyUrl;
  // Keep the shared SVG intact when updating link copy.
  $('keyHelp').firstChild.textContent = `Get ${config.name === 'OpenAI' ? 'an OpenAI' : 'a DeepSeek'} key `;
  const hasKey = Boolean(savedKeys[selectedProvider + 'Key']);
  $('keyStatus').textContent = hasKey ? 'Key saved on this device' : 'Add a key to start checking';
  $('keyStatus').dataset.saved = String(hasKey);
  $('connectionDetails').open = !hasKey;
  $('saveFeedback').textContent = '';
}

function updateStatus() {
  const enabled = $('masterToggle').checked;
  $('toggleLabel').textContent = enabled ? 'On' : 'Off';
}

async function loadSite() {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    $('siteContextRow').hidden = true;
    return;
  }
  siteDomain = new URL(tab.url).hostname;
  $('siteDomain').textContent = siteDomain;
  $('siteContextRow').hidden = false;
  const {pausedSites = []} = await chrome.storage.sync.get('pausedSites');
  updateSitePause(pausedSites.includes(siteDomain));
}
function updateSitePause(paused) {
  $('sitePauseBtn').textContent = paused ? 'Resume here' : 'Pause here';
  $('sitePauseBtn').setAttribute('aria-pressed', String(paused));
}

function bind(id, event, action) {
  $(id).addEventListener(event, e => Promise.resolve().then(() => action(e)).catch(showStorageError));
}
bind('acceptPrivacy','click',async () => {
  await chrome.storage.sync.set({dataSharingConsent:true, providerConsentVersion:WriteWiseConsentVersion, autoCheckEnabled:false});
  await openApp();
});
for (const provider of Object.keys(WriteWiseProviders)) {
  bind('tab-' + provider,'click',async () => {
    selectedProvider = provider;
    renderProvider();
    await chrome.storage.sync.set({provider});
  });
}
bind('saveKeyBtn','click',async () => {
  const provider = selectedProvider;
  const key = $('apiKeyInput').value.trim();
  $('saveKeyBtn').disabled = true;
  try {
    await WriteWiseSecrets.set(provider + 'Key', key);
    savedKeys[provider + 'Key'] = key;
    if (provider === selectedProvider) {
      renderProvider();
      $('saveFeedback').textContent = key ? 'Saved. Your first check will verify the key.' : 'API key removed.';
    }
  } finally { $('saveKeyBtn').disabled = false; }
});
bind('keyEye','click',() => {
  const reveal = $('apiKeyInput').type === 'password';
  $('apiKeyInput').type = reveal ? 'text' : 'password';
  $('keyEye').setAttribute('aria-pressed', String(reveal));
  $('keyEye').setAttribute('aria-label', reveal ? 'Hide API key' : 'Show API key');
});
bind('masterToggle','change',async e => {
  await chrome.storage.sync.set({enabled:e.target.checked});
  updateStatus();
});
bind('autoCheckToggle','change',e => chrome.storage.sync.set({autoCheckEnabled:e.target.checked}));
bind('checkDelay','change',e => chrome.storage.sync.set({delay:Number(e.target.value)}));
bind('tonePreset','change',e => chrome.storage.sync.set({tonePreset:e.target.value}));
for (const name of ['spelling','grammar','clarity','tone']) {
  $('fix-' + name).querySelector('input').addEventListener('change', async e => {
    try {
      await chrome.storage.sync.set({[name]:e.target.checked});
      if (name === 'tone') $('tonePresetRow').hidden = !e.target.checked;
    } catch { showStorageError(); }
  });
}
bind('sitePauseBtn','click',async () => {
  if (!siteDomain) return;
  const {pausedSites = []} = await chrome.storage.sync.get('pausedSites');
  const paused = !pausedSites.includes(siteDomain);
  const sites = paused ? [...pausedSites,siteDomain] : pausedSites.filter(site => site !== siteDomain);
  await chrome.storage.sync.set({pausedSites:sites});
  updateSitePause(paused);
});
bind('revokePrivacy','click',async () => {
  await chrome.storage.sync.set({dataSharingConsent:false, autoCheckEnabled:false});
  await openApp();
});
document.addEventListener('DOMContentLoaded', () => { openApp().catch(showStorageError); });
