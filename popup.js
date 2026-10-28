// ── Onboarding (#1) ───────────────────────────────────────────────────────

function showStorageError() {
  document.getElementById('storageError').classList.remove('hidden');
}

async function openApp() {
  const [keys, data] = await Promise.all([
    WriteWiseSecrets.get(), chrome.storage.sync.get(['dataSharingConsent'])
  ]);
  if (data.dataSharingConsent !== true) {
    document.getElementById('privacyConsent').classList.remove('hidden');
    return;
  }
  document.getElementById('privacyConsent').classList.add('hidden');
  if (!keys.claudeKey && !keys.geminiKey && !keys.groqKey) showOnboarding();
  else showMainApp();
}

document.addEventListener('DOMContentLoaded', () => { openApp().catch(showStorageError); });
document.getElementById('acceptPrivacy').addEventListener('click', async () => {
  try {
    await chrome.storage.sync.set({dataSharingConsent:true, autoCheckEnabled:false});
    await openApp();
  } catch { showStorageError(); }
});

function showOnboarding() {
  document.getElementById('onboarding').classList.remove('hidden');
  document.getElementById('main-app').classList.add('hidden');
}
function showMainApp() {
  document.getElementById('onboarding').classList.add('hidden');
  document.getElementById('main-app').classList.remove('hidden');
  initMainApp();
}

// ── Onboarding logic ──────────────────────────────────────────────────────

let obSelectedProvider = '';

function showObStep(n) {
  ['ob-step-1','ob-step-2','ob-step-3'].forEach((id, i) => {
    document.getElementById(id).classList.toggle('hidden', i !== n - 1);
  });
}

for (const provider of ['gemini','claude','groq']) {
  document.getElementById('ob-' + provider + '-btn').addEventListener('click', () => {
    obSelectedProvider = provider;
    for (const p of ['gemini','claude','groq']) {
      document.getElementById('ob-' + p + '-btn').classList.toggle('selected', p === provider);
    }
    const cont = document.getElementById('ob-continue');
    cont.disabled = false;
    cont.classList.remove('opacity-50','cursor-not-allowed');
  });
}

document.getElementById('ob-continue').addEventListener('click', () => {
  if (!obSelectedProvider) return;
  const providers = {
    gemini:['https://aistudio.google.com/apikey','aistudio.google.com','AIza…'],
    claude:['https://console.anthropic.com','console.anthropic.com','sk-ant-…'],
    groq:['https://console.groq.com/keys','console.groq.com','gsk_…']
  };
  const [href, label, placeholder] = providers[obSelectedProvider];
  const link = document.getElementById('ob-key-link');
  link.href = href; link.textContent = label;
  document.getElementById('ob-key-input').placeholder = placeholder;
  showObStep(2);
});

document.getElementById('ob-back').addEventListener('click', () => showObStep(1));

// Eye toggle for onboarding (#3)
document.getElementById('ob-eye').addEventListener('click', () => {
  const input = document.getElementById('ob-key-input');
  input.type = input.type === 'password' ? 'text' : 'password';
});

document.getElementById('ob-save-btn').addEventListener('click', async () => {
  const key = document.getElementById('ob-key-input').value.trim();
  const errEl = document.getElementById('ob-save-err');
  if (!key) {
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');
  const storageKey = obSelectedProvider + 'Key';
  try {
    await WriteWiseSecrets.set(storageKey, key);
    await chrome.storage.sync.set({provider:obSelectedProvider});
    showObStep(3);
  } catch { showStorageError(); }
});

document.getElementById('ob-to-settings').addEventListener('click', () => {
  showMainApp();
});

// ── Main app initialization ───────────────────────────────────────────────

let mainAppInited = false;

function initMainApp() {
  loadMainAppData().catch(showStorageError);
  if (mainAppInited) return;
  mainAppInited = true;
  bindMainAppEvents();
}

async function loadMainAppData() {
  const storageKeys = ['provider','autoCheckEnabled','delay','spelling','grammar','clarity','tone','enabled',
    'claudeModel','tonePreset','fixSectionCollapsed','providerSectionCollapsed','pausedSites'];

  const [settings, keys] = await Promise.all([chrome.storage.sync.get(storageKeys), WriteWiseSecrets.get()]);
  const data = { ...settings, ...keys };
  {
    // Master toggle
    const masterToggle = document.getElementById('masterToggle');
    masterToggle.checked = data.enabled !== false;
    updateStatus(masterToggle.checked, data.provider || 'gemini');

    document.getElementById('autoCheckToggle').checked = data.autoCheckEnabled === true;
    document.getElementById('checkDelay').value = data.delay || 2000;

    // API keys
    if (data.claudeKey) document.getElementById('claudeKeyInput').value = data.claudeKey;
    if (data.geminiKey) document.getElementById('geminiKeyInput').value = data.geminiKey;
    if (data.groqKey)   document.getElementById('groqKeyInput').value   = data.groqKey;

    // Key status dots (#2)
    updateKeyStatus('gemini', !!data.geminiKey);
    updateKeyStatus('claude', !!data.claudeKey);
    updateKeyStatus('groq',   !!data.groqKey);

    // Provider
    switchProvider(data.provider || 'gemini', false);

    // Fix options
    ['spelling','grammar','clarity','tone'].forEach(key => {
      const val = data[key] !== undefined ? data[key] : true;
      const item = document.getElementById('fix-' + key);
      item.querySelector('input').checked = val;
      item.classList.toggle('active', val);
    });

    // Tone preset row visibility (#7)
    const toneActive = data.tone !== false;
    document.getElementById('tonePresetRow').classList.toggle('hidden', !toneActive);

    // Tone preset selection (#7)
    if (data.tonePreset) {
      updateTonePresetUI(data.tonePreset);
    }


    // Model selectors (#9)
    const claudeModel = data.claudeModel || 'claude-haiku-4-5-20251001';
    updateModelUI('claude', claudeModel.includes('sonnet') ? 'sonnet' : 'haiku');
    // Collapsible sections (#13)
    if (data.fixSectionCollapsed) {
      document.getElementById('fixList').classList.add('collapsed');
      document.getElementById('fixSectionToggle').classList.add('collapsed');
    }
    if (data.providerSectionCollapsed) {
      document.getElementById('providerList').classList.add('collapsed');
      document.getElementById('providerSectionToggle').classList.add('collapsed');
    }

    // Session stats (#6)
    chrome.storage.local.get(['wwStats'], (d) => {
      const today = new Date().toDateString();
      const count = (d.wwStats?.date === today) ? d.wwStats.count : 0;
      document.getElementById('sessionStats').textContent = count > 0 ? `${count} fix${count !== 1 ? 'es' : ''} today` : '';
    });
  }
}

function bindMainAppEvents() {
  // Per-site pause (#4)
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs[0]?.url;
    if (!url || !/^https?:/.test(url)) {
      document.getElementById('siteContextRow').style.display = 'none';
      return;
    }
    const domain = new URL(url).hostname;
    document.getElementById('siteDomain').textContent = domain;
    chrome.storage.sync.get(['pausedSites'], (d) => {
      const paused = (d.pausedSites || []).includes(domain);
      updateSitePauseUI(paused);
    });
    document.getElementById('sitePauseBtn').addEventListener('click', () => {
      chrome.storage.sync.get(['pausedSites'], (d) => {
        let sites = d.pausedSites || [];
        const idx = sites.indexOf(domain);
        if (idx === -1) sites.push(domain); else sites.splice(idx, 1);
        chrome.storage.sync.set({ pausedSites: sites });
        updateSitePauseUI(sites.includes(domain));
      });
    });
  });

  // Master toggle
  document.getElementById('masterToggle').addEventListener('change', (e) => {
    const enabled = e.target.checked;
    chrome.storage.sync.set({ enabled });
    document.getElementById('toggleLabel').textContent = enabled ? 'On' : 'Off';
    chrome.storage.sync.get(['provider'], (d) => updateStatus(enabled, d.provider || 'gemini'));
  });

  // Provider tab click listeners
  document.getElementById('tab-groq').addEventListener('click',   () => switchProvider('groq'));
  document.getElementById('tab-gemini').addEventListener('click', () => switchProvider('gemini'));
  document.getElementById('tab-claude').addEventListener('click', () => switchProvider('claude'));

  for (const [provider, name] of [['groq','Groq'], ['claude','Claude'], ['gemini','Gemini']]) {
    document.getElementById('save' + name + 'Btn').addEventListener('click', async () => {
      try {
        const key = document.getElementById(provider + 'KeyInput').value.trim();
        await WriteWiseSecrets.set(provider + 'Key', key);
        flashSaved('save' + name + 'Btn');
        updateKeyStatus(provider, !!key);
      } catch { showStorageError(); }
    });
  }
  document.getElementById('autoCheckToggle').addEventListener('change', async e => {
    try { await chrome.storage.sync.set({autoCheckEnabled:e.target.checked}); }
    catch { showStorageError(); }
  });
  document.getElementById('checkDelay').addEventListener('change', async e => {
    try { await chrome.storage.sync.set({delay:Number(e.target.value)}); }
    catch { showStorageError(); }
  });
  document.getElementById('revokePrivacy').addEventListener('click', async () => {
    try {
      await chrome.storage.sync.set({dataSharingConsent:false, autoCheckEnabled:false});
      document.getElementById('main-app').classList.add('hidden');
      document.getElementById('privacyConsent').classList.remove('hidden');
    } catch { showStorageError(); }
  });

  // Eye toggle buttons (#3)
  document.getElementById('groqEye').addEventListener('click', () => {
    const input = document.getElementById('groqKeyInput');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  document.getElementById('geminiEye').addEventListener('click', () => {
    const input = document.getElementById('geminiKeyInput');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  document.getElementById('claudeEye').addEventListener('click', () => {
    const input = document.getElementById('claudeKeyInput');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // Fix checkboxes
  ['spelling','grammar','clarity','tone'].forEach(key => {
    const item = document.getElementById('fix-' + key);
    const cb = item.querySelector('input');
    cb.addEventListener('change', () => {
      item.classList.toggle('active', cb.checked);
      chrome.storage.sync.set({ [key]: cb.checked });
      if (key === 'tone') {
        document.getElementById('tonePresetRow').classList.toggle('hidden', !cb.checked);
      }
    });
  });

  // Tone preset pills (#7)
  ['professional','casual','formal','friendly'].forEach(preset => {
    document.getElementById('tone-' + preset).addEventListener('click', () => {
      chrome.storage.sync.set({ tonePreset: preset });
      updateTonePresetUI(preset);
    });
  });

  // Model selector (#9)
  ['haiku','sonnet'].forEach(m => {
    document.getElementById('model-claude-' + m)?.addEventListener('click', () => {
      const model = m === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
      chrome.storage.sync.set({ claudeModel: model });
      updateModelUI('claude', m);
    });
  });

  // Collapsible sections (#13)
  document.getElementById('fixSectionToggle').addEventListener('click', () => {
    const list = document.getElementById('fixList');
    const btn = document.getElementById('fixSectionToggle');
    const collapsed = list.classList.toggle('collapsed');
    btn.classList.toggle('collapsed', collapsed);
    chrome.storage.sync.set({ fixSectionCollapsed: collapsed });
  });
  document.getElementById('providerSectionToggle').addEventListener('click', () => {
    const list = document.getElementById('providerList');
    const btn = document.getElementById('providerSectionToggle');
    const collapsed = list.classList.toggle('collapsed');
    btn.classList.toggle('collapsed', collapsed);
    chrome.storage.sync.set({ providerSectionCollapsed: collapsed });
  });

}

// ── Helper functions ──────────────────────────────────────────────────────

function switchProvider(provider, save = true) {
  document.getElementById('panel-groq').classList.toggle('visible',   provider === 'groq');
  document.getElementById('panel-gemini').classList.toggle('visible', provider === 'gemini');
  document.getElementById('panel-claude').classList.toggle('visible', provider === 'claude');
  document.getElementById('tab-groq').className   = 'provider-tab flex-1' + (provider === 'groq'   ? ' active-groq'   : '');
  document.getElementById('tab-gemini').className = 'provider-tab flex-1' + (provider === 'gemini' ? ' active-gemini' : '');
  document.getElementById('tab-claude').className = 'provider-tab flex-1' + (provider === 'claude' ? ' active-claude' : '');

  const badge = document.getElementById('providerBadge');
  badge.className = 'provider-chip ' + provider;
  const lbl = document.getElementById('providerBadgeLabel');
  const labels = { groq: 'Groq Llama 3.1', gemini: 'Gemini 2.5 Flash-Lite', claude: 'Claude Haiku' };
  if (lbl) lbl.textContent = labels[provider] || 'Groq Llama 3.1';

  if (save) {
    chrome.storage.sync.set({ provider });
    const enabled = document.getElementById('masterToggle').checked;
    updateStatus(enabled, provider);
  }
}

function flashSaved(btnId) {
  const btn = document.getElementById(btnId);
  const orig = btn.textContent;
  btn.textContent = 'Saved ✓';
  btn.classList.add('saved');
  setTimeout(() => { btn.textContent = orig; btn.classList.remove('saved'); }, 1500);
}

function updateStatus(enabled, provider) {
  document.getElementById('statusDot').classList.toggle('active', enabled);
  document.getElementById('statusText').textContent = enabled ? 'Enabled' : 'Paused';
  const lbl = document.getElementById('toggleLabel');
  if (lbl) lbl.textContent = enabled ? 'On' : 'Off';
}

// Key status indicator (#2)
function updateKeyStatus(provider, hasKey) {
  const dot = document.getElementById(provider + 'Status');
  if (dot) dot.classList.toggle('connected', hasKey);
}

// Per-site pause UI (#4)
function updateSitePauseUI(paused) {
  const btn = document.getElementById('sitePauseBtn');
  if (!btn) return;
  btn.classList.toggle('paused', paused);
  btn.title = paused ? 'Resume on this site' : 'Pause on this site';
  const label = paused ? 'Resume here' : 'Pause here';
  btn.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">${paused ? '<polygon points="5 3 19 12 5 21 5 3"/>' : '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'}</svg> ${label}`;
}

// Model selector UI (#9)
function updateModelUI(provider, selection) {
  const activeClass = 'active-' + provider;
  document.getElementById('model-claude-haiku').classList.toggle(activeClass, selection === 'haiku');
  document.getElementById('model-claude-sonnet').classList.toggle(activeClass, selection === 'sonnet');
}

// Tone preset UI (#7)
function updateTonePresetUI(preset) {
  ['professional','casual','formal','friendly'].forEach(p => {
    const btn = document.getElementById('tone-' + p);
    if (btn) btn.classList.toggle('active', p === preset);
  });
}
