// ── In-memory cache ───────────────────────────────────────────────────────
let cachedSettings = null;

async function getSettings() {
  if (cachedSettings) return cachedSettings;
  cachedSettings = await chrome.storage.sync.get([
    'provider', 'claudeKey', 'geminiKey', 'claudeModel', 'geminiModel', 'tonePreset'
  ]);
  return cachedSettings;
}

// Invalidate cache when settings change
chrome.storage.onChanged.addListener(() => { cachedSettings = null; });

// ── Context menu setup (#14) ───────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'writewise-check',
    title: 'Check with WriteWise',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'writewise-check') {
    chrome.tabs.sendMessage(tab.id, { type: 'CHECK_SELECTION', text: info.selectionText });
  }
});

// ── Message handler ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CORRECT_TEXT') {
    handleCorrection(message.text, message.options)
      .then(({ result, categories }) => sendResponse({ success: true, result, categories }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function handleCorrection(text, options = {}) {
  const data = await getSettings();
  const provider = data.provider || 'gemini';

  // Model selection (#9)
  const claudeModel = data.claudeModel || 'claude-haiku-4-5-20251001';
  const geminiModel = 'gemini-2.5-flash-lite';

  const fixes = [];
  if (options.spelling) fixes.push('spelling');
  if (options.grammar)  fixes.push('grammar');
  if (options.clarity)  fixes.push('clarity and style');
  if (options.tone)     fixes.push('tone');
  const fixList = fixes.length ? fixes.join(', ') : 'spelling, grammar, clarity and style, tone';

  // Tone preset (#7)
  const tonePreset = data.tonePreset || '';
  let toneInstruction = '';
  if (options.tone && tonePreset) {
    toneInstruction = ` The desired tone is: ${tonePreset}.`;
  }

  const systemPrompt = `You are a multilingual writing assistant. Fix the user's text for: ${fixList}.
Always respond in the same language as the input — never translate.
Preserve the original meaning, voice, and length as much as possible.${toneInstruction}
Return ONLY the corrected text — no explanation, no quotes, no preamble.
If the text is already correct, return it exactly as-is.`;

  if (provider === 'claude') {
    if (!data.claudeKey) throw new Error('NO_API_KEY');
    return callClaude(text, systemPrompt, data.claudeKey, claudeModel);
  } else {
    if (!data.geminiKey) throw new Error('NO_API_KEY');
    return callGemini(text, systemPrompt, data.geminiKey, geminiModel);
  }
}

async function callClaude(text, systemPrompt, apiKey, model) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 512,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: text }]
      })
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = err?.error?.message || `Claude API error ${response.status}`;
      if (response.status === 429) throw new Error('quota_exceeded');
      throw new Error(msg);
    }
    const data = await response.json();
    const result = data.content.map(b => b.text || '').join('').trim();
    return { result, categories: [] };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('TIMEOUT');
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function callGemini(text, systemPrompt, apiKey, model) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text }] }],
          generationConfig: { maxOutputTokens: 512, temperature: 0 }
        })
      }
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = err?.error?.message || `Gemini API error ${response.status}`;
      const isQuota = response.status === 429 || err?.error?.status === 'RESOURCE_EXHAUSTED';
      if (isQuota) throw new Error('quota_exceeded');
      throw new Error(`[${response.status}] ${msg}`);
    }
    const data = await response.json();
    const result = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || text;
    return { result, categories: [] };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('TIMEOUT');
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}
