(() => {
  if (window.__writewiseLoaded) return;
  window.__writewiseLoaded = true;
  // Remove only the legacy WriteWise draft cache left by version 1.0.0.
  try { sessionStorage.removeItem('__ww_last'); } catch {}

  let debounceTimer    = null;
  let activeElement    = null;
  let bubble           = null;
  let badge            = null;
  let anchor           = null;
  let anchorEl         = null;
  let badgeHideTimer   = null;
  let originalText     = '';
  let correctedText    = '';
  let isProcessing     = false;
  let lastTriggerTime  = 0;
  let correctionApplied = false;
  let changeCount      = 0;
  let suggestion = null;
  let requestVersion = 0;
  let settingsLoaded = false;
  let pendingInputEl = null;
  let composing = false;

  const MAX_WORDS = 500;
  const MIN_CHECK_INTERVAL = 8000; // ms — minimum gap between API calls

  const defaults = { spelling:true, grammar:true, clarity:true, tone:true, delay:2000,
    enabled:true, pausedSites:[], autoCheckEnabled:false, dataSharingConsent:false, providerConsentVersion:0 };
  let settings = { ...defaults };
  const settingKeys = [...Object.keys(defaults), 'provider', 'tonePreset'];

  try {
    chrome.storage.sync.get(settingKeys, (data) => {
      if (chrome.runtime.lastError) return;
      settings = { ...defaults, ...data };
      settingsLoaded = true;
      if (pendingInputEl) {
        const el = pendingInputEl;
        pendingInputEl = null;
        if (document.activeElement === el) onInput({target:el});
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !Object.keys(changes).some(k => settingKeys.includes(k))) return;
      for (const [key, {newValue}] of Object.entries(changes)) {
        if (settingKeys.includes(key)) settings[key] = newValue ?? defaults[key];
      }
      invalidate();
    });
  } catch(e) {}

  // ── Helpers ───────────────────────────────────────────────────────────────

  function editableRoot(el) {
    if (!(el instanceof HTMLElement)) return null;
    if (el.isContentEditable) {
      while (el.parentElement?.isContentEditable) el = el.parentElement;
    }
    return el;
  }

  function isEditable(el) {
    if (!el || el.disabled || el.readOnly) return false;
    // Exclude credentials, one-time codes, payment fields, and explicit opt-outs.
    if (el.closest('[data-writewise="off"], [data-sensitive="true"]')) return false;
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/(password|username|one-time-code|cc-)/.test(autocomplete)) return false;
    if (el.tagName === 'INPUT') return el.type === 'text' || el.type === 'search';
    return el.tagName === 'TEXTAREA' || el.isContentEditable;
  }

  function allowed(el) {
    return settingsLoaded && settings.enabled && settings.dataSharingConsent === true && settings.providerConsentVersion === 2 &&
      !settings.pausedSites?.includes(location.hostname) && isEditable(el) && el.isConnected &&
      ['spelling','grammar','clarity','tone'].some(k => settings[k]);
  }

  function getText(el) {
    return el.isContentEditable ? el.innerText : (el.value || '');
  }

  function invalidate() {
    requestVersion++;
    clearTimeout(debounceTimer);
    suggestion = null;
    correctedText = '';
    originalText = '';
    changeCount = 0;
    clearTimeout(badgeHideTimer);
    correctionApplied = false;
    undoState = null;
    hideBubble();
    if (bubble) bubble.replaceChildren();
    hideAnchor();
    if (badge) badge.classList.remove('visible');
  }

  function snapshot(el, selected = false) {
    const fullText = getText(el);
    let start = 0, end = fullText.length;
    let raw = fullText;
    if (selected) {
      if (el.isContentEditable) {
        const selection = window.getSelection();
        if (!selection?.rangeCount || !el.contains(selection.anchorNode) || !el.contains(selection.focusNode)) return null;
        raw = selection.toString();
      } else {
        start = el.selectionStart; end = el.selectionEnd;
        if (start === null || end === null || start === end) return null;
        raw = fullText.slice(start, end);
      }
    }
    // Keep surrounding whitespace and the rest of a selected field untouched.
    start += raw.length - raw.trimStart().length;
    end -= raw.length - raw.trimEnd().length;
    return { el, fullText, start, end, text: raw.trim(),
      html: el.isContentEditable ? el.innerHTML : null };
  }

  function unchanged(check) {
    return allowed(check.el) && getText(check.el) === check.fullText &&
      (check.html === null || check.el.innerHTML === check.html);
  }

  function setText(el, text) {
    // Rich-text editors are copy-only; never replace their DOM or framework state.
    if (el.isContentEditable) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) return false;
    el.__writewiseApplying = true;
    try {
      setter.call(el, text);
      el.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertReplacementText', data:text}));
    } finally {
      el.__writewiseApplying = false;
    }
    return true;
  }

  function wordCount(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // Word-level diff
  function buildDiff(a, b) {
    const aTok = a.split(/(\s+)/);
    const bTok = b.split(/(\s+)/);
    const dp = Array.from({length: aTok.length+1}, () => new Uint16Array(bTok.length+1));
    for (let i = aTok.length-1; i >= 0; i--)
      for (let j = bTok.length-1; j >= 0; j--)
        dp[i][j] = aTok[i]===bTok[j] ? dp[i+1][j+1]+1 : Math.max(dp[i+1][j], dp[i][j+1]);
    let i=0, j=0, html='', changes=0;
    while (i < aTok.length || j < bTok.length) {
      if (i<aTok.length && j<bTok.length && aTok[i]===bTok[j]) {
        html += escHtml(aTok[i]); i++; j++;
      } else if (j<bTok.length && (i>=aTok.length || dp[i+1]?.[j]<=dp[i]?.[j+1])) {
        if (!/^\s+$/.test(bTok[j])) { html += `<span class="__ww-ins">${escHtml(bTok[j])}</span>`; changes++; }
        else html += escHtml(bTok[j]);
        j++;
      } else {
        if (!/^\s+$/.test(aTok[i])) { html += `<span class="__ww-del">${escHtml(aTok[i])}</span>`; changes++; }
        else html += escHtml(aTok[i]);
        i++;
      }
    }
    return { html, changes };
  }

  // ── Badge ─────────────────────────────────────────────────────────────────

  function initBadge() {
    if (badge) return;
    badge = document.createElement('div');
    badge.id = '__writewise-badge';
    badge.innerHTML = `<div class="__ww-dot"></div><span class="__ww-blabel">WriteWise</span><span class="__ww-chip" id="__ww-chip">·</span>`;
    document.body.appendChild(badge);
    refreshProviderChip();
  }

  function refreshProviderChip() {
    try {
      chrome.storage.sync.get(['provider'], (d) => {
        const p = d.provider || 'openai';
        const tag = document.getElementById('__ww-chip');
        if (tag) {
          tag.textContent = { openai:'OpenAI', deepseek:'DeepSeek' }[p] || 'OpenAI';
          tag.className = '__ww-chip ' + p;
        }
      });
    } catch(e) {}
  }

  function setBadge(state) {
    if (!badge) initBadge();
    clearTimeout(badgeHideTimer);
    badge.className = '__ww-' + state;
    badge.classList.add('visible');
    const label = badge.querySelector('.__ww-blabel');
    const msgs = { typing:'Waiting…', checking:'Checking…', done:'Reviewed ✓', idle:'Active' };
    if (label && msgs[state]) label.textContent = msgs[state];
    refreshProviderChip();
    if (state === 'idle') badgeHideTimer = setTimeout(() => badge.classList.remove('visible'), 2000);
    else if (state === 'done') badgeHideTimer = setTimeout(() => setBadge('idle'), 2500);
  }

  // ── Anchor dot ────────────────────────────────────────────────────────────

  const STARBURST_SVG = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg">
    <line x1="6.5" y1="0.5" x2="6.5" y2="12.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="0.5" y1="6.5" x2="12.5" y2="6.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="1.55" y1="1.55" x2="11.45" y2="11.45" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="11.45" y1="1.55" x2="1.55" y2="11.45" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`;

  function initAnchor() {
    if (anchor) return;
    anchor = document.createElement('button');
    anchor.type = 'button';
    anchor.setAttribute('data-writewise', 'true');
    anchor.setAttribute('aria-label', 'Check with WriteWise');
    anchor.addEventListener('mousedown', e => e.preventDefault());
    anchor.id = '__writewise-anchor';
    anchor.innerHTML = '<div class="__ww-anchor-fill"><div class="__ww-anchor-arc"></div><span class="__ww-anchor-icon"></span></div>';
    document.body.appendChild(anchor);
    anchor.addEventListener('click', onAnchorClick);
    // Tab applies a validated plain-text suggestion; Enter keeps its native behavior.
    document.addEventListener('keydown', onKeyDown, true);
  }

  function onKeyDown(e) {
    if (!e.isTrusted) return;
    if (e.key === 'Escape') { hideBubble(); return; }
    if (!bubble || bubble.style.display === 'none' || !suggestion || suggestion.el.isContentEditable) return;
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey &&
        !e.isComposing && document.activeElement === suggestion.el && unchanged(suggestion)) {
      e.preventDefault();
      e.stopPropagation();
      applyCorrection();
    }
  }

  function onAnchorClick(e) {
    if (!e.isTrusted) return;
    if (!anchorEl || !allowed(anchorEl)) return;
    if (correctionApplied && undoState?.el === anchorEl) {
      showBubble(anchorEl, 'applied');
    } else if (suggestion && unchanged(suggestion)) {
      showBubble(suggestion.el, 'suggestion');
    } else {
      triggerCorrection(anchorEl);
    }
  }

  function positionAnchor(el) {
    if (!anchor) initAnchor();
    const rect = el.getBoundingClientRect();
    const dotSize = 26;
    const half = dotSize / 2;
    // #12 — anchor repositioning: outside field (right + 8) instead of overlapping
    anchor.style.top  = (rect.bottom + window.scrollY - half) + 'px';
    anchor.style.left = (rect.right  + window.scrollX + 8) + 'px';
    anchor.style.display = 'flex';
    anchorEl = el;
  }

  function showAnchor(el, state) {
    positionAnchor(el);
    anchor.className = '__ww-anchor-' + state;
    const icon = anchor.querySelector('.__ww-anchor-icon');
    const fill = anchor.querySelector('.__ww-anchor-fill');
    if (!icon || !fill) return;

    if (state === 'done' || state === 'applied') {
      icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      // #7 — tooltip showing change count
      const tip = changeCount > 0 ? `${changeCount} change${changeCount !== 1 ? 's' : ''} — click to review` : 'Text looks good';
      anchor.title = tip;
    } else if (state === 'checking') {
      icon.innerHTML = STARBURST_SVG;
      anchor.title = 'Checking…';
    } else {
      icon.innerHTML = STARBURST_SVG;
      anchor.title = 'Click to check';
    }
  }

  function hideAnchor() {
    if (anchor) { anchor.style.display = 'none'; anchor.className = ''; anchor.title = ''; }
    anchorEl = null;
  }

  window.addEventListener('scroll', () => {
    if (anchor?.style.display !== 'none' && anchorEl) positionAnchor(anchorEl);
    if (bubble?.style.display !== 'none' && activeElement) positionBubble(activeElement);
  }, true);
  window.addEventListener('resize', () => {
    if (anchor?.style.display !== 'none' && anchorEl) positionAnchor(anchorEl);
    if (bubble?.style.display !== 'none' && activeElement) positionBubble(activeElement);
  });

  // ── Input events ──────────────────────────────────────────────────────────

  document.addEventListener('input',    onInput,    true);
  document.addEventListener('focusin',  onFocus,    true);
  document.addEventListener('focusout', onFocusOut, true);

  document.addEventListener('compositionstart', () => { composing = true; invalidate(); }, true);
  document.addEventListener('compositionend', (e) => { composing = false; onInput(e); }, true);

  function onFocus(e) {
    const el = editableRoot(e.target);
    if (!isEditable(el)) { if (!e.target.closest?.('[data-writewise]')) invalidate(); return; }
    if (el !== activeElement) invalidate();
    activeElement = el;
  }

  function onFocusOut() {
    setTimeout(() => {
      if (!isEditable(editableRoot(document.activeElement)) &&
          !document.activeElement?.closest?.('[data-writewise]')) {
        invalidate();
      }
    }, 200);
  }

  function onInput(e) {
    if (e.isTrusted === false) return;
    const el = editableRoot(e.target);
    if (el?.__writewiseApplying) return;
    if (!settingsLoaded) { pendingInputEl = el; return; }
    invalidate();
    if (!allowed(el) || composing || e.isComposing) return;
    activeElement = el;
    const text = getText(el).trim();
    if (text.length < 10) return;
    showAnchor(el, 'unchecked');
    if (wordCount(text) > MAX_WORDS || text.length > 12000) {
      anchor.title = 'Text too long — select up to 500 words and 12,000 characters';
      return;
    }
    if (settings.autoCheckEnabled) {
      setBadge('typing');
      const version = requestVersion;
      const delay = Math.max(500, Math.min(4000, Number(settings.delay) || 2000));
      debounceTimer = setTimeout(() => {
        if (version === requestVersion && document.activeElement === el) triggerCorrection(el);
      }, delay);
    }
  }

  // ── API call ──────────────────────────────────────────────────────────────

  async function triggerCorrection(el, selected = false, pending = null) {
    if (!allowed(el) || composing) return;
    const check = pending || snapshot(el, selected);
    if (!check || !unchanged(check) || check.text.length < 10) return;
    const text = check.text;
    if (wordCount(text) > MAX_WORDS || text.length > 12000) {
      showBubble(el, 'error', 'Select up to 500 words and 12,000 characters to check.');
      return;
    }
    const version = requestVersion;
    clearTimeout(debounceTimer);
    const elapsed = Date.now() - lastTriggerTime;
    if (isProcessing || (lastTriggerTime > 0 && elapsed < MIN_CHECK_INTERVAL)) {
      debounceTimer = setTimeout(() => {
        if (version === requestVersion && unchanged(check)) triggerCorrection(el, selected, check);
      }, Math.max(250, MIN_CHECK_INTERVAL - elapsed));
      return;
    }
    lastTriggerTime = Date.now();
    isProcessing = true;
    suggestion = null;
    correctedText = '';
    showBubble(el, 'checking');
    setBadge('checking');
    showAnchor(el, 'checking');
    try {
      const response = await new Promise((resolve, reject) => {
        try {
          if (!chrome.runtime?.id) {
            resolve({ success: false, error: 'CONTEXT_INVALIDATED' });
            return;
          }
          chrome.runtime.sendMessage({ type:'CORRECT_TEXT', text }, (res) => {
            if (chrome.runtime.lastError) {
              const msg = chrome.runtime.lastError.message || '';
              if (msg.includes('context invalidated') || msg.includes('Extension context')) {
                resolve({ success: false, error: 'CONTEXT_INVALIDATED' });
              } else {
                reject(new Error(msg));
              }
              return;
            }
            resolve(res);
          });
        } catch(e) {
          resolve({ success: false, error: 'CONTEXT_INVALIDATED' });
        }
      });

      if (version !== requestVersion || !unchanged(check)) return;
      if (!response?.success) {
        const err = response?.error || '';
        if (['PAUSED', 'CONSENT_REQUIRED', 'NO_FIXES'].includes(err)) { invalidate(); return; }
        if (err === 'CONTEXT_INVALIDATED') { hideBubble(); hideAnchor(); return; }

        // #11 — timeout handling
        if (err === 'TIMEOUT') {
          showBubble(el, 'error', 'Took too long — tap ✳ to retry');
          showAnchor(el, 'unchecked');
          anchor.title = 'Tap to retry';
          return;
        }

        const isQuota = err.startsWith('quota_exceeded') || err.toLowerCase().includes('quota') || err.includes('429');
        const isInvalidKey = err === 'INVALID_API_KEY';
        if (err === 'NO_API_KEY' || isInvalidKey) {
          showBubble(el, 'no-key'); showAnchor(el, 'unchecked');
        } else if (isQuota) {
          const parts = err.split('|');
          const detail = parts.length > 2 ? `${parts[1]}: ${parts[2]}` : null;
          showBubble(el, 'rate-limit', el, null, detail);
          showAnchor(el, 'unchecked');
        } else {
          const messages = { INCOMPLETE_RESPONSE:'The AI response was incomplete. Your text is unchanged. Try a shorter selection.',
            NETWORK_ERROR:'Could not connect. Check your connection and try again.',
            TEXT_LIMIT:'Select up to 500 words and 12,000 characters to check.' };
          showBubble(el, 'error', messages[err] || 'The provider could not check this text. Check your key and try again.'); showAnchor(el, 'unchecked');
        }
        return;
      }

      const corrected = response.result;
      if (typeof corrected !== 'string' || !corrected.trim() || corrected.length > 24000 || wordCount(corrected) > 1000) {
        showBubble(el, 'error', 'The AI returned an invalid response. Your text is unchanged.');
        return;
      }
      if (corrected === text) {
        changeCount = 0;
        setBadge('idle'); showAnchor(el, 'done'); showBubble(el, 'ok');
        return;
      }
      originalText = text;
      correctedText = corrected;
      suggestion = { ...check, corrected };
      changeCount = buildDiff(originalText, correctedText).changes;
      showBubble(el, 'suggestion');
      setBadge('done'); showAnchor(el, 'done');
    } catch (err) {
      if (version === requestVersion && unchanged(check)) {
        showBubble(el, 'error', 'Could not check this text. Reload the page and try again.');
        showAnchor(el, 'unchecked');
      }
    } finally {
      isProcessing = false;
    }
  }

  // ── Context menu handler (#14) ────────────────────────────────────────────
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'CHECK_SELECTION') {
        const el = editableRoot(document.activeElement);
        if (allowed(el)) {
          invalidate();
          activeElement = el;
          triggerCorrection(el, true);
        }
      }
    });
  } catch(e) {}

  // ── Bubble ────────────────────────────────────────────────────────────────

  function createBubble() {
    const el = document.createElement('div');
    el.id = '__writewise-bubble';
    el.setAttribute('data-writewise', 'true');
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'WriteWise suggestion');
    el.addEventListener('mousedown', e => e.preventDefault());
    document.body.appendChild(el);
    return el;
  }

  function positionBubble(target) {
    if (!bubble) return;
    const rect    = target.getBoundingClientRect();
    const scrollY = window.scrollY, scrollX = window.scrollX;
    const bw = Math.min(360, window.innerWidth - 24), bh = bubble.offsetHeight || 180;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    let top;
    if (spaceBelow < bh + 12 && spaceAbove > bh + 12) {
      top = rect.top + scrollY - bh - 8;
      bubble.classList.add('__ww-above');
    } else {
      top = rect.bottom + scrollY + 8;
      bubble.classList.remove('__ww-above');
    }

    let left = rect.left + scrollX;
    if (left + bw > window.innerWidth + scrollX - 12) left = window.innerWidth + scrollX - bw - 12;
    if (left < scrollX + 8) left = scrollX + 8;

    bubble.style.top  = top  + 'px';
    bubble.style.left = left + 'px';
  }

  function showBubble(target, state, errorMsgOrEl, categories, rateLimitDetail) {
    if (!bubble) bubble = createBubble();
    bubble.style.position = '';

    if (state === 'checking') {
      // #11 — loading skeleton
      bubble.innerHTML = `<div class="__ww-checking-state">
  <div class="__ww-skel-header">
    <span class="__ww-spinner"></span>
    <span class="__ww-skel-title">Analysing your text…</span>
  </div>
  <div class="__ww-skel-lines">
    <div class="__ww-skel-line" style="width:92%"></div>
    <div class="__ww-skel-line" style="width:75%"></div>
    <div class="__ww-skel-line" style="width:58%"></div>
  </div>
</div>`;

    } else if (state === 'suggestion') {
      const { html: diffHtml, changes } = buildDiff(originalText, correctedText);
      const changeLabel = changes === 1 ? '1 change' : `${changes} changes`;
      // #16 — category badges
      const cats = (categories || []).filter(c => ['spelling','grammar','clarity','tone'].includes(c));
      const catBadges = cats.length > 0
        ? cats.map(c => `<span class="__ww-cat-badge __ww-cat-${c}">${c}</span>`).join('')
        : '';
      bubble.innerHTML = `
        <div class="__ww-header">
          <span class="__ww-icon">${STARBURST_SVG}</span>
          <span class="__ww-title">Suggestion ready</span>
          ${catBadges}
          <button class="__ww-close" data-action="close">✕</button>
        </div>
        <div class="__ww-diff">${diffHtml}</div>
        <div class="__ww-actions">
          <span class="__ww-change-count">${changeLabel}</span>
          <span class="__ww-shortcut-hint">${suggestion?.el.isContentEditable ? 'Copy to preserve formatting' : 'Tab to apply'}</span>
          <button class="__ww-btn __ww-btn-dismiss" data-action="dismiss">Dismiss</button>
          <button class="__ww-btn __ww-btn-apply" data-action="${suggestion?.el.isContentEditable ? 'copy' : 'apply'}">${suggestion?.el.isContentEditable ? 'Copy correction' : '✓ Apply'}</button>
        </div>`;
      bubble.addEventListener('click', onBubbleClick);

    } else if (state === 'applied') {
      bubble.innerHTML = `
        <div class="__ww-row __ww-applied">
          <span class="__ww-applied-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3 3 7-7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
          <div>
            <div class="__ww-applied-title">Correction applied</div>
            <div class="__ww-applied-sub">Undo is available until you edit this field.</div>
          </div>
          <button class="__ww-recheck-btn" data-action="undo">Undo</button>
        </div>`;
      bubble.addEventListener('click', onBubbleClick);

    } else if (state === 'no-key') {
      bubble.innerHTML = `
        <div class="__ww-nokey">
          <div class="__ww-nokey-title">Add an API key</div>
          <div class="__ww-nokey-sub">Click the WriteWise icon in your toolbar to add your API key and start checking.</div>
        </div>`;

    } else if (state === 'rate-limit') {
      const detailLine = rateLimitDetail ? `<div class="__ww-nokey-sub" style="margin-top:6px;color:currentColor;font-size:11px">${escHtml(rateLimitDetail)}</div>` : '';
      bubble.innerHTML = `
        <div class="__ww-nokey">
          <div class="__ww-nokey-title">Provider limit reached</div>
          <div class="__ww-nokey-sub">Your AI provider has reached a usage limit. Try again later or choose another provider in WriteWise settings.</div>
          ${detailLine}
          <button class="__ww-close" data-action="close" style="position:absolute;top:10px;right:10px">✕</button>
        </div>`;
      bubble.style.display = 'block';
      const anchorTarget = errorMsgOrEl || activeElement;
      if (anchorTarget) requestAnimationFrame(() => positionBubble(anchorTarget));
      bubble.addEventListener('click', onBubbleClick);
      return;

    } else if (state === 'error') {
      bubble.innerHTML = `
        <div class="__ww-row __ww-warn">
          <span>${escHtml(errorMsgOrEl || 'Something went wrong')}</span>
          <button class="__ww-close" data-action="close">✕</button>
        </div>`;
      bubble.addEventListener('click', onBubbleClick);
    } else if (state === 'ok') {
      bubble.innerHTML = `
        <div class="__ww-row __ww-ok">
          <div class="__ww-ok-icon">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="8" fill="#5cb87a"/>
              <path d="M4 8L7 11L12 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <span>Text looks great — no changes needed.</span>
        </div>`;
    }

    bubble.style.display = 'block';
    requestAnimationFrame(() => positionBubble(target));
    if (state === 'ok') setTimeout(() => hideBubble(), 2500);
  }

  function onBubbleClick(e) {
    if (!e.isTrusted) return;
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'apply')   applyCorrection();
    if (action === 'dismiss') invalidate();
    if (action === 'copy') copyCorrection();
    if (action === 'close')   hideBubble();
    if (action === 'undo')    undoCorrection();
    if (action === 'recheck' && anchorEl) {
      const el = anchorEl;
      invalidate();
      triggerCorrection(el);
    }
  }

  function hideBubble() {
    if (bubble) bubble.style.display = 'none';
  }

  // Undo is bound to the same field and exact applied value, including whitespace.
  let undoState = null;

  function undoCorrection() {
    const undo = undoState;
    if (!undo || !allowed(undo.el) || getText(undo.el) !== undo.after) { invalidate(); return; }
    undo.el.focus();
    if (!allowed(undo.el) || getText(undo.el) !== undo.after) { invalidate(); return; }
    setText(undo.el, undo.before);
    invalidate();
  }

  async function copyCorrection() {
    const check = suggestion;
    if (!check || !unchanged(check)) { invalidate(); return; }
    try {
      await navigator.clipboard.writeText(check.corrected);
      if (suggestion === check) {
        hideBubble();
        setBadge('idle');
      }
    } catch {
      if (suggestion !== check || !unchanged(check)) return;
      bubble.innerHTML = `<div class="__ww-row">Copy was blocked. Select and copy this correction:</div><div class="__ww-diff">${escHtml(check.corrected)}</div>`;
      bubble.style.display = 'block';
    }
  }

  function applyCorrection() {
    const check = suggestion;
    if (!check || check.el.isContentEditable || !unchanged(check)) { invalidate(); return; }
    const el = check.el;
    const next = check.fullText.slice(0, check.start) + check.corrected + check.fullText.slice(check.end);
    el.focus();
    if (!unchanged(check)) { invalidate(); return; }
    if (!setText(el, next)) return;
    const applied = getText(el);
    if (applied !== next) { invalidate(); return; }
    undoState = { el, before:check.fullText, after:next };
    correctedText = '';
    suggestion = null;
    correctionApplied = true;
    showAnchor(el, 'applied');
    try { chrome.runtime.sendMessage({type:'RECORD_APPLY'}, () => { void chrome.runtime.lastError; }); } catch {}
    showBubble(el, 'applied');
  }

})();
