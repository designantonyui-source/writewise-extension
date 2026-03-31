(() => {
  if (window.__writewiseLoaded) return;
  window.__writewiseLoaded = true;

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
  let lastAppliedText  = '';
  let changeCount      = 0;
  let countInterval    = null; // #17 — rate limit countdown

  const MAX_WORDS = 500;

  let settings = { spelling:true, grammar:true, clarity:true, tone:true, delay:1500, enabled:true, pausedSites:[], autoCheck:false };

  try {
    chrome.storage.sync.get(['spelling','grammar','clarity','tone','delay','enabled','pausedSites','autoCheck'], (d) => {
      ['spelling','grammar','clarity','tone','delay','enabled','pausedSites','autoCheck'].forEach(k => { if (d[k] !== undefined) settings[k] = d[k]; });
    });
    chrome.storage.onChanged.addListener((changes) => {
      for (const [k, {newValue}] of Object.entries(changes)) { if (k in settings) settings[k] = newValue; }
    });
  } catch(e) {}

  // ── Helpers ───────────────────────────────────────────────────────────────

  function isEditable(el) {
    if (!el) return false;
    const tag = el.tagName;
    // #12 — exclude password fields
    if (tag === 'INPUT') {
      const type = (el.type || '').toLowerCase();
      if (type === 'password') return false;
      return ['text','email','search','url',''].includes(type);
    }
    if (tag === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function getText(el) {
    return el.isContentEditable ? el.innerText : (el.value || '');
  }

  function setText(el, text) {
    if (el.isContentEditable) {
      el.innerText = text;
      const r = document.createRange(), s = window.getSelection();
      r.selectNodeContents(el); r.collapse(false);
      s.removeAllRanges(); s.addRange(r);
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) { setter.call(el, text); el.dispatchEvent(new Event('input', {bubbles:true})); }
      else el.value = text;
      el.selectionStart = el.selectionEnd = text.length;
    }
  }

  function wordCount(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // #9 — smarter trivial change detection (ignore whitespace + punctuation-only changes)
  function isTrivialChange(applied, current) {
    if (!applied || !current) return false;
    const norm = s => s.replace(/[\s.,!?;:]+/g, ' ').trim().toLowerCase();
    if (norm(applied) === norm(current)) return true;
    if (current.startsWith(applied) && current.slice(applied.length).trim().length < 8) return true;
    return false;
  }

  // Word-level diff
  function buildDiff(a, b) {
    const aTok = a.split(/(\s+)/);
    const bTok = b.split(/(\s+)/);
    const dp = Array.from({length: aTok.length+1}, () => new Array(bTok.length+1).fill(0));
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
        const p = d.provider || 'gemini';
        const tag = document.getElementById('__ww-chip');
        if (tag) { tag.textContent = p === 'claude' ? 'Claude' : 'Gemini'; tag.className = '__ww-chip ' + p; }
      });
    } catch(e) {}
  }

  function setBadge(state) {
    if (!badge) initBadge();
    clearTimeout(badgeHideTimer);
    badge.className = '__ww-' + state;
    badge.classList.add('visible');
    const label = badge.querySelector('.__ww-blabel');
    const msgs = { typing:'Waiting…', checking:'Checking…', done:'Fixed ✓', idle:'Active' };
    if (label && msgs[state]) label.textContent = msgs[state];
    refreshProviderChip();
    if (state === 'idle') badgeHideTimer = setTimeout(() => badge.classList.remove('visible'), 2000);
    else if (state === 'done') badgeHideTimer = setTimeout(() => setBadge('idle'), 2500);
  }

  // ── Anchor dot ────────────────────────────────────────────────────────────

  const STARBURST_SVG = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg">
    <line x1="6.5" y1="0.5" x2="6.5" y2="12.5" stroke="#e2673a" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="0.5" y1="6.5" x2="12.5" y2="6.5" stroke="#e2673a" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="1.55" y1="1.55" x2="11.45" y2="11.45" stroke="#e2673a" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="11.45" y1="1.55" x2="1.55" y2="11.45" stroke="#e2673a" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`;

  function initAnchor() {
    if (anchor) return;
    anchor = document.createElement('div');
    anchor.id = '__writewise-anchor';
    anchor.innerHTML = '<div class="__ww-anchor-fill"><div class="__ww-anchor-arc"></div><span class="__ww-anchor-icon"></span></div>';
    document.body.appendChild(anchor);
    anchor.addEventListener('click', onAnchorClick);
    // #6 — keyboard shortcut: Tab or Enter applies correction
    document.addEventListener('keydown', onKeyDown, true);
  }

  // #6 — apply with Tab or Enter when bubble is visible
  function onKeyDown(e) {
    if (!bubble || bubble.style.display === 'none') return;
    if (!correctedText) return;
    if (e.key === 'Tab' || e.key === 'Enter') {
      // Only intercept if the active element is the field we're correcting
      if (document.activeElement === anchorEl || document.activeElement === activeElement) {
        e.preventDefault();
        e.stopPropagation();
        applyCorrection();
      }
    }
    if (e.key === 'Escape') {
      hideBubble();
    }
  }

  function onAnchorClick() {
    if (!anchorEl) return;
    if (correctionApplied) {
      showBubble(anchorEl, 'applied');
    } else if (correctedText) {
      showBubble(anchorEl, 'suggestion');
    } else {
      const text = getText(anchorEl).trim();
      if (text.length >= 10) triggerCorrection(anchorEl, text);
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
      fill.style.cssText = 'width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#5cb87a;border:none;box-shadow:0 2px 8px rgba(92,184,122,0.5);';
      icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      // #7 — tooltip showing change count
      const tip = changeCount > 0 ? `${changeCount} change${changeCount !== 1 ? 's' : ''} — click to review` : 'Text looks good';
      anchor.title = tip;
    } else if (state === 'checking') {
      fill.style.cssText = 'width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(226,103,58,0.15);border:1.5px solid rgba(226,103,58,0.5);box-shadow:none;';
      icon.innerHTML = STARBURST_SVG;
      anchor.title = 'Checking…';
    } else {
      fill.style.cssText = 'width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(226,103,58,0.12);border:1.5px solid rgba(226,103,58,0.4);box-shadow:none;';
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

  function onFocus(e) {
    if (!isEditable(e.target)) return;
    activeElement = e.target;
    if (correctedText && e.target === anchorEl) showAnchor(e.target, 'done');
  }

  function onFocusOut(e) {
    setTimeout(() => {
      if (!document.activeElement || !isEditable(document.activeElement)) {
        hideBubble();
        if (badge) badge.classList.remove('visible');
      }
    }, 200);
  }

  function onInput(e) {
    if (!settings.enabled || !isEditable(e.target) || e.target.__writewiseApplying) return;

    // #4 — per-site pause
    const domain = location.hostname;
    if (settings.pausedSites && settings.pausedSites.includes(domain)) return;

    activeElement = e.target;
    clearTimeout(debounceTimer);
    hideBubble();

    const text = getText(e.target).trim();

    // #9 — smarter trivial change detection
    if (lastAppliedText && isTrivialChange(lastAppliedText, text)) {
      setBadge('done');
      showAnchor(e.target, 'applied');
      correctionApplied = true;
      return;
    }

    setBadge('typing');
    correctionApplied = false;
    correctedText = '';
    lastAppliedText = '';
    changeCount = 0;
    if (text.length < 10) return;

    // #8 — skip very long texts
    if (wordCount(text) > MAX_WORDS) {
      showAnchor(e.target, 'unchecked');
      anchor.title = 'Text too long — select a section to check';
      return;
    }

    showAnchor(e.target, 'unchecked');

    // In manual mode: show the anchor but never auto-fire — user clicks to check
    if (!settings.autoCheck) return;

    debounceTimer = setTimeout(() => triggerCorrection(e.target, text), settings.delay || 1500);
  }

  // ── API call ──────────────────────────────────────────────────────────────

  async function triggerCorrection(el, text) {
    if (isProcessing) return;
    isProcessing = true;

    showBubble(el, 'checking');
    setBadge('checking');
    showAnchor(el, 'checking');

    try {
      const response = await new Promise((resolve, reject) => {
        try {
          chrome.runtime.sendMessage({ type:'CORRECT_TEXT', text, options:settings }, (res) => {
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

      if (!response.success) {
        const err = response.error || '';
        if (err === 'CONTEXT_INVALIDATED') { hideBubble(); hideAnchor(); return; }

        // #11 — timeout handling
        if (err === 'TIMEOUT') {
          showBubble(el, 'error', 'Took too long — tap ✳ to retry');
          showAnchor(el, 'unchecked');
          anchor.title = 'Tap to retry';
          return;
        }

        const isQuota = err === 'quota_exceeded' || err.toLowerCase().includes('quota') || err.includes('429');
        const isInvalidKey = err.includes('400') || err.toLowerCase().includes('api key not valid') || err.toLowerCase().includes('invalid api key');
        if (err === 'NO_API_KEY' || isInvalidKey) {
          showBubble(el, 'no-key'); showAnchor(el, 'unchecked');
        } else if (isQuota) {
          showBubble(el, 'rate-limit', el);
          showAnchor(el, 'unchecked');
        } else {
          showBubble(el, 'error', err); showAnchor(el, 'unchecked');
        }
        return;
      }

      const corrected = response.result;
      const categories = response.categories || [];
      const current = getText(el).trim();
      if (current !== text) { hideBubble(); return; }

      if (corrected === text) {
        hideBubble(); setBadge('idle');
        changeCount = 0;
        showAnchor(el, 'done');
        correctedText = '';
        return;
      }

      originalText  = text;
      correctedText = corrected;

      // Pre-compute diff to get change count for tooltip
      const { changes } = buildDiff(originalText, correctedText);
      changeCount = changes;

      showBubble(el, 'suggestion', null, categories);
      setBadge('done');
      showAnchor(el, 'done');

      // #10 — persist correction in sessionStorage
      try {
        sessionStorage.setItem('__ww_last', JSON.stringify({ orig: text, fixed: corrected, changes }));
      } catch(e) {}

    } catch (err) {
      showBubble(el, 'error', err.message);
      showAnchor(el, 'unchecked');
    } finally {
      isProcessing = false;
    }
  }

  // ── Context menu handler (#14) ────────────────────────────────────────────
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'CHECK_SELECTION') {
        const el = document.activeElement;
        if (el && isEditable(el)) {
          activeElement = el;
          triggerCorrection(el, getText(el).trim() || msg.text);
        }
      }
    });
  } catch(e) {}

  // ── Bubble ────────────────────────────────────────────────────────────────

  function createBubble() {
    const el = document.createElement('div');
    el.id = '__writewise-bubble';
    el.setAttribute('data-writewise', 'true');
    document.body.appendChild(el);
    return el;
  }

  function positionBubble(target) {
    if (!bubble) return;
    const rect    = target.getBoundingClientRect();
    const scrollY = window.scrollY, scrollX = window.scrollX;
    const bw = 380, bh = bubble.offsetHeight || 180;
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

  function showBubble(target, state, errorMsgOrEl, categories) {
    if (!bubble) bubble = createBubble();

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
      const cats = categories || [];
      const catBadges = cats.length > 0
        ? cats.map(c => `<span class="__ww-cat-badge __ww-cat-${c}">${c}</span>`).join('')
        : '';
      bubble.innerHTML = `
        <div class="__ww-header">
          <span class="__ww-icon">✳</span>
          <span class="__ww-title">Suggestion ready</span>
          ${catBadges}
          <button class="__ww-close" data-action="close">✕</button>
        </div>
        <div class="__ww-diff">${diffHtml}</div>
        <div class="__ww-actions">
          <span class="__ww-change-count">${changeLabel}</span>
          <span class="__ww-shortcut-hint">Tab to apply</span>
          <button class="__ww-btn __ww-btn-dismiss" data-action="dismiss">Dismiss</button>
          <button class="__ww-btn __ww-btn-apply" data-action="apply">✓ Apply</button>
        </div>`;
      bubble.addEventListener('click', onBubbleClick);

    } else if (state === 'applied') {
      bubble.innerHTML = `
        <div class="__ww-row __ww-applied">
          <span class="__ww-applied-icon">✓</span>
          <div>
            <div class="__ww-applied-title">Correction applied</div>
            <div class="__ww-applied-sub">Want a fresh check on the updated text?</div>
          </div>
          <button class="__ww-recheck-btn" data-action="recheck">Recheck</button>
        </div>`;
      bubble.addEventListener('click', onBubbleClick);

    } else if (state === 'no-key') {
      bubble.innerHTML = `
        <div class="__ww-nokey">
          <div class="__ww-nokey-title">⚠ No API key set</div>
          <div class="__ww-nokey-sub">Click the WriteWise icon in your toolbar to add your API key and start checking.</div>
        </div>`;

    } else if (state === 'rate-limit') {
      bubble.innerHTML = `
        <div class="__ww-nokey">
          <div class="__ww-nokey-title">⚠ Gemini quota reached</div>
          <div class="__ww-nokey-sub">Your free Gemini API key has hit its daily limit (1,500 req/day). It resets at midnight Pacific time.<br><br>Switch to <strong>Claude</strong> in the WriteWise popup — or wait until tomorrow.</div>
          <button class="__ww-close" data-action="close" style="position:absolute;top:10px;right:10px">✕</button>
        </div>`;
      bubble.style.position = 'relative';
      bubble.style.display = 'block';
      const anchorTarget = errorMsgOrEl || activeElement;
      if (anchorTarget) requestAnimationFrame(() => positionBubble(anchorTarget));
      bubble.addEventListener('click', onBubbleClick);
      return;

    } else if (state === 'error') {
      bubble.innerHTML = `
        <div class="__ww-row __ww-warn">
          <span>⚠ ${escHtml(errorMsgOrEl || 'Something went wrong')}</span>
          <button class="__ww-close" data-action="close">✕</button>
        </div>`;
      bubble.addEventListener('click', onBubbleClick);
    }

    bubble.style.display = 'block';
    requestAnimationFrame(() => positionBubble(target));
  }

  function onBubbleClick(e) {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'apply')   applyCorrection();
    if (action === 'dismiss') { hideBubble(); hideAnchor(); correctedText = ''; changeCount = 0; }
    if (action === 'close')   hideBubble();
    if (action === 'undo')    undoCorrection();
    if (action === 'recheck') {
      hideBubble();
      correctionApplied = false;
      correctedText = '';
      changeCount = 0;
      const text = getText(anchorEl).trim();
      if (text.length >= 10) triggerCorrection(anchorEl, text);
    }
  }

  function hideBubble() {
    // #17 — clear rate limit countdown on hide
    if (countInterval) { clearInterval(countInterval); countInterval = null; }
    if (bubble) bubble.style.display = 'none';
  }

  // ── Undo state (#5 & #8) ─────────────────────────────────────────────────
  let undoText = '';
  let undoInterval = null;

  function undoCorrection() {
    if (!activeElement || !undoText) return;
    if (undoInterval) { clearInterval(undoInterval); undoInterval = null; }
    activeElement.__writewiseApplying = true;
    setText(activeElement, undoText);
    setTimeout(() => { if (activeElement) activeElement.__writewiseApplying = false; }, 100);
    hideBubble();
    lastAppliedText = '';
    correctionApplied = false;
    correctedText = '';
    undoText = '';
  }

  function applyCorrection() {
    if (!activeElement || !correctedText) return;
    undoText = getText(activeElement).trim(); // #5 — store original for undo
    activeElement.__writewiseApplying = true;
    setText(activeElement, correctedText);
    setTimeout(() => { if (activeElement) activeElement.__writewiseApplying = false; }, 100);
    lastAppliedText = correctedText;
    const appliedEl = activeElement;
    correctedText = '';
    correctionApplied = true;
    showAnchor(appliedEl, 'applied');
    setTimeout(() => hideAnchor(), 3000);

    // #6 — session stats
    const today = new Date().toDateString();
    chrome.storage.local.get(['wwStats'], (d) => {
      const s = (d.wwStats?.date === today) ? d.wwStats : { date: today, count: 0, fields: 0 };
      s.count++;
      chrome.storage.local.set({ wwStats: s });
    });

    // #5 & #8 — show undo bubble with 4-second countdown
    if (undoInterval) { clearInterval(undoInterval); undoInterval = null; }
    if (!bubble) bubble = createBubble();

    const DURATION_MS = 4000;
    const CIRCUMFERENCE = 81.7;
    let elapsed = 0;
    const TICK = 100;

    bubble.innerHTML = `<div class="__ww-row __ww-applied">
  <span class="__ww-applied-icon">✓</span>
  <div style="flex:1">
    <div class="__ww-applied-title">Correction applied</div>
    <div class="__ww-applied-sub" id="__ww-undo-sub">Want a fresh check?</div>
  </div>
  <button class="__ww-recheck-btn" data-action="recheck">Recheck</button>
  <button class="__ww-btn __ww-btn-dismiss" data-action="dismiss">Dismiss</button>
</div>`;
    bubble.style.display = 'block';
    requestAnimationFrame(() => positionBubble(appliedEl));
    bubble.addEventListener('click', onBubbleClick);

    undoInterval = setInterval(() => {
      elapsed += TICK;
      const progress = elapsed / DURATION_MS;
      const offset = progress * CIRCUMFERENCE;
      const arc = bubble?.querySelector('.__ww-undo-arc');
      if (arc) arc.style.strokeDashoffset = offset;
      if (elapsed >= DURATION_MS) {
        clearInterval(undoInterval);
        undoInterval = null;
        hideBubble();
      }
    }, TICK);
  }

})();
