/*! WriteWise in-page card — content/ui.js (v2)
 *
 *  Classic content script: no imports, no ES modules.
 *
 *  Public API (window.__wwUI):
 *    mount()                       idempotent; builds host + shadow root, adopts CSS
 *    show(anchorEl, state, data)   render + position + reveal
 *    hide()
 *    isVisible()                   boolean
 *    setTheme('system'|'dark'|'light')
 *    onAction(fn)                  fn(action), action ∈
 *                                  'apply'|'dismiss'|'undo'|'recheck'|'retry'|'open-settings'
 *
 *  States: checking | suggestion | clean | applied | error | setup
 *
 *  Owns: #__ww-host (position:absolute, zero-size, pointer-events:none),
 *        the shadow root, the .ww-tokens wrapper, card DOM, positioning, keyboard.
 *  Everything visual lives in the shadow root; page CSS cannot reach in and
 *  none of our rules leak out.
 */
(() => {
  'use strict';

  if (window.__wwUI && window.__wwUI.mount) return; // already injected

  const CARD_WIDTH = 380;
  const GAP = 8; // gap between anchor and card
  const EDGE = 8; // viewport margin for clamping

  const MARK_SVG =
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<path d="M8 1.2v13.6M1.2 8h13.6M3.2 3.2l9.6 9.6M12.8 3.2l-9.6 9.6" ' +
    'stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  const SPEAK_SVG =
    '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true" focusable="false">' +
    '<path d="M2 5.4h2.2L7 3v8L4.2 8.6H2a.6.6 0 0 1-.6-.6V6a.6.6 0 0 1 .6-.6Z" ' +
    'stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>' +
    '<path d="M9.1 5.1a2.6 2.6 0 0 1 0 3.8M10.9 3.4a5 5 0 0 1 0 7.2" ' +
    'stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>';

  const CLOSE_SVG =
    '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">' +
    '<path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round"/></svg>';

  const FALLBACK_CSS = [
    '.ww-tokens{position:absolute;top:0;left:0;display:block;color:#f2ede6;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:left;direction:ltr}',
    '.ww-card{display:flex;flex-direction:column;width:380px;max-width:calc(100vw - 16px);max-height:320px;padding:12px;background:#141413;color:#f2ede6;border:1px solid #262521;border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.42);pointer-events:auto;overflow:hidden}',
    '.ww-head{display:flex;align-items:center;gap:8px}', '.ww-mark{color:#e2673a;display:inline-flex}',
    '.ww-title{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ww-chip{font-size:10px;color:#aeaaa3;border:1px solid #33322c;border-radius:99px;padding:1px 7px}',
    '.ww-x{width:24px;height:24px;border:0;background:none;color:#8c8882;cursor:pointer}',
    '.ww-body{flex:1;min-height:0;overflow:auto;margin-top:10px}', '.ww-foot{display:flex;gap:8px;align-items:center;margin-top:12px;padding-top:10px;border-top:1px solid #262521}',
    '.ww-meta{flex:1;min-width:0;font-size:11px;color:#aeaaa3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ww-btn{height:30px;padding:0 12px;border-radius:8px;font:600 12px/1 inherit;cursor:pointer;border:1px solid transparent;background:none;color:#f2ede6}',
    '.ww-btn-ghost{color:#aeaaa3;border-color:#33322c}', '.ww-btn-primary{background:#c7502a;color:#fff}',
    '.ww-ins{background:rgba(92,184,122,.15);color:#5cb87a;text-decoration:underline;text-decoration-color:#5cb87a}',
    '.ww-del{background:rgba(217,83,79,.15);color:#e27d79;text-decoration:line-through;text-decoration-color:#e27d79}',
    '.ww-sub,.ww-msg{margin:0;color:#aeaaa3}', '.ww-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}', '.ww-skel{height:8px;border-radius:4px;background:#24231f;margin:0 0 8px}',
  ].join('\n');

  /* ── state ─────────────────────────────────────────────────────────── */

  let host = null;
  let shadow = null;
  let wrap = null;
  let card = null;

  let mounted = false;
  let stylesReady = false;
  let stylesPromise = null;
  let fallbackInstalled = false;

  let visible = false;
  let anchorEl = null;
  let curState = null;
  let curData = null;
  let actionFn = null;

  let themeMode = 'system';
  let themeMq = null;

  let elapsedTimer = null;
  let elapsedStart = 0;
  let elapsedEl = null;

  let posRaf = 0;
  let posFallback = 0;
  let lastLeft = null;
  let lastTop = null;
  let enterTimer = null;

  /* ── helpers ───────────────────────────────────────────────────────── */

  const str = (v) => (typeof v === 'string' ? v : '');

  function num(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
      c === '&' ? '&amp;' :
      c === '<' ? '&lt;' :
      c === '>' ? '&gt;' :
      c === '"' ? '&quot;' : '&#39;'
    ));
  }

  function formatMs(ms) {
    const n = num(ms);
    if (n === null || n < 0) return '';
    if (n < 1000) return Math.round(n) + ' ms';
    return (n / 1000).toFixed(1) + ' s';
  }

  function changesLabel(n) {
    if (!n) return 'No changes';
    return n === 1 ? '1 change' : n + ' changes';
  }

  function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
  }

  function extURL(path) {
    try {
      if (typeof chrome !== 'undefined' && chrome && chrome.runtime &&
          typeof chrome.runtime.getURL === 'function') {
        return chrome.runtime.getURL(path);
      }
    } catch (e) { /* fall through */ }
    return path;
  }

  function warn() {
    try {
      const args = Array.prototype.slice.call(arguments);
      console.warn.apply(console, ['[WriteWise]'].concat(args));
    } catch (e) {}
  }

  /* ── styles ────────────────────────────────────────────────────────── */

  function fetchCSS(path) {
    return fetch(extURL(path), { cache: 'force-cache' }).then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + path);
      return res.text();
    });
  }

  function loadStyles() {
    if (stylesPromise) return stylesPromise;
    stylesPromise = Promise.all([
      fetchCSS('shared/tokens.css'),
      fetchCSS('content/ui.css'),
    ]).then((sheets) => {
      const sheetA = new CSSStyleSheet();
      sheetA.replaceSync(sheets[0]);
      const sheetB = new CSSStyleSheet();
      sheetB.replaceSync(sheets[1]);
      shadow.adoptedStyleSheets = [sheetA, sheetB];
      stylesReady = true;
      applyTheme();
      revealIfPending();
    }).catch((err) => {
      warn('card styles failed to load — using inline fallback', err);
      installFallback();
      stylesReady = true;
      revealIfPending();
    });
    return stylesPromise;
  }

  function installFallback() {
    if (fallbackInstalled || !shadow) return;
    fallbackInstalled = true;
    const style = document.createElement('style');
    style.textContent = FALLBACK_CSS;
    shadow.insertBefore(style, wrap);
  }

  function revealIfPending() {
    if (!visible || !card) return;
    card.style.visibility = '';
    positionCard();
    card.setAttribute('data-enter', '1');
  }

  /* ── build ─────────────────────────────────────────────────────────── */

  function build() {
    host = document.createElement('div');
    host.id = '__ww-host';
    host.setAttribute('data-writewise', 'host');

    // Inline + !important: survives hostile page CSS, including
    // `* { all: unset !important }` (inline !important outranks any selector).
    const s = (k, v) => host.style.setProperty(k, v, 'important');
    s('all', 'initial');
    s('position', 'absolute');
    s('top', '0');
    s('left', '0');
    s('display', 'block');
    s('width', '0');
    s('height', '0');
    s('margin', '0');
    s('padding', '0');
    s('border', '0');
    s('background', 'none');
    s('overflow', 'visible');
    s('pointer-events', 'none');
    s('z-index', '2147483647');
    s('transform', 'translate(-9999px,-9999px)');
    s('transition', 'none');
    s('animation', 'none');
    s('opacity', '1');
    s('visibility', 'visible');

    const root = document.documentElement || document.body;
    if (!root) { warn('no document root; card not mounted'); return; }
    root.appendChild(host);

    shadow = host.attachShadow({ mode: 'open' });

    wrap = document.createElement('div');
    wrap.className = 'ww-tokens';
    wrap.setAttribute('data-theme', 'dark');
    shadow.appendChild(wrap);

    card = document.createElement('div');
    card.className = 'ww-card';
    card.tabIndex = -1;
    card.style.display = 'none';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'WriteWise suggestion');
    wrap.appendChild(card);

    card.addEventListener('click', onCardClick, false);
    card.addEventListener('mousedown', onCardMouseDown, true);
  }

  /* ── theme ─────────────────────────────────────────────────────────── */

  function applyTheme() {
    if (!wrap) return;
    const resolved = themeMode === 'system'
      ? (themeMq && themeMq.matches ? 'light' : 'dark')
      : themeMode;
    wrap.setAttribute('data-theme', resolved);
  }

  function onThemeChange() {
    applyTheme();
  }

  function setTheme(mode) {
    themeMode = (mode === 'light' || mode === 'dark') ? mode : 'system';
    if (themeMq && typeof themeMq.removeEventListener === 'function') {
      try { themeMq.removeEventListener('change', onThemeChange); } catch (e) {}
    }
    try { themeMq = window.matchMedia('(prefers-color-scheme: light)'); }
    catch (e) { themeMq = null; }
    if (themeMq && typeof themeMq.addEventListener === 'function') {
      try { themeMq.addEventListener('change', onThemeChange); } catch (e) {}
    }
    applyTheme();
  }

  /* ── render ────────────────────────────────────────────────────────── */

  function headHTML(opts) {
    const chip = str(opts.chip);
    const chipTitle = str(opts.chipTitle);
    return '<div class="ww-head">' +
      '<span class="ww-mark">' + MARK_SVG + '</span>' +
      (opts.spinner ? '<span class="ww-spin" aria-hidden="true"></span>' : '') +
      '<span class="ww-title">' + esc(opts.title) + '</span>' +
      (opts.timer ? '<span class="ww-timer" data-ww-elapsed></span>' : '') +
      (chip
        ? '<span class="ww-chip"' + (chipTitle ? ' title="' + esc(chipTitle) + '"' : '') + '>' +
          esc(chip) + '</span>'
        : '') +
      (opts.speak
        ? '<button type="button" class="ww-x ww-speak" data-ww-action="speak"' +
          ' aria-label="Play pronunciation" aria-pressed="false" title="Play pronunciation">' +
          '<span class="ww-sr">Play pronunciation</span>' + SPEAK_SVG + '</button>'
        : '') +
      '<button type="button" class="ww-x" data-ww-action="dismiss" aria-label="Dismiss">' +
        '<span class="ww-sr">Dismiss</span>' + CLOSE_SVG + '</button>' +
      '</div>';
  }

  function btnHTML(action, label, primary) {
    return '<button type="button" class="ww-btn ' + (primary ? 'ww-btn-primary' : 'ww-btn-ghost') + '"' +
      ' data-ww-action="' + esc(action) + '">' + esc(label) + '</button>';
  }

  function actionHTML(action, primary) {
    if (!action || typeof action !== 'object' || !action.id) return '';
    const fallback = action.id === 'retry' ? 'Try again'
      : action.id === 'open-settings' ? 'Add key'
        : 'Continue';
    return btnHTML(action.id, str(action.label) || fallback, primary);
  }

  function footHTML(meta, buttons) {
    if (!buttons) return '';
    return '<div class="ww-foot">' +
      '<span class="ww-meta">' + esc(meta) + '</span>' +
      buttons + '</div>';
  }

  function countDiff(diff) {
    if (!Array.isArray(diff)) return 0;
    let ins = 0;
    let del = 0;
    for (let i = 0; i < diff.length; i++) {
      const p = diff[i];
      if (!p) continue;
      const hasText = /\S/.test(String(p.v == null ? '' : p.v));
      if (!hasText) continue;
      if (p.t === 'ins') ins++;
      else if (p.t === 'del') del++;
    }
    return Math.max(ins, del);
  }

  function fillDiff(diff, data) {
    const holder = card && card.querySelector('[data-ww-diff]');
    if (!holder) return;
    holder.textContent = '';
    if (Array.isArray(diff) && diff.length) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < diff.length; i++) {
        const part = diff[i];
        if (!part) continue;
        const value = String(part.v == null ? '' : part.v);
        if (!value) continue;
        if (part.t === 'ins' || part.t === 'del') {
          const el = document.createElement(part.t === 'ins' ? 'ins' : 'del');
          el.className = part.t === 'ins' ? 'ww-ins' : 'ww-del';
          el.textContent = value;
          frag.appendChild(el);
        } else {
          frag.appendChild(document.createTextNode(value));
        }
      }
      holder.appendChild(frag);
      return;
    }
    const plain = str(data.corrected) || str(data.text);
    holder.textContent = plain || 'Suggested changes are ready.';
  }

  function render(state, data) {
    if (!card) return;
    const provider = str(data.provider);
    const model = str(data.model);
    const chip = provider || model;
    const chipTitle = (model && model !== chip) ? model : '';

    let head = '';
    let body = '';
    let foot = '';

    if (state === 'checking') {
      head = headHTML({ title: str(data.title) || 'Checking…', spinner: true, timer: true, chip: chip, chipTitle: chipTitle });
      body = '<div class="ww-body">' +
        '<div class="ww-skel" style="width:92%"></div>' +
        '<div class="ww-skel" style="width:76%"></div>' +
        '<div class="ww-skel" style="width:54%"></div>' +
        '</div>';
    } else if (state === 'suggestion') {
      const diff = Array.isArray(data.diff) ? data.diff : null;
      const reported = num(data.changes);
      const changes = reported !== null ? Math.max(0, Math.round(reported)) : countDiff(diff);
      const ms = formatMs(data.ms);
      head = headHTML({ title: 'Suggested fix', chip: chip, chipTitle: chipTitle });
      body = '<div class="ww-body"><div class="ww-diff" data-ww-diff></div></div>';
      foot = footHTML(ms ? changesLabel(changes) + ' · ' + ms : changesLabel(changes),
        btnHTML('apply', 'Apply', true));
    } else if (state === 'clean') {
      head = headHTML({ title: 'Looks good', chip: chip, chipTitle: chipTitle });
      body = '<div class="ww-body"><p class="ww-sub">No changes needed.</p></div>';
      if (data.canRecheck) foot = footHTML('', btnHTML('recheck', 'Recheck', false));
    } else if (state === 'applied') {
      head = headHTML({ title: 'Applied', chip: chip, chipTitle: chipTitle });
      body = '<div class="ww-body"><p class="ww-sub">Your text has been updated.</p></div>';
      foot = footHTML('', data.canUndo === false ? '' : btnHTML('undo', 'Undo', false));
    } else if (state === 'translation') {
      const translation = str(data.translation);
      const source = str(data.sourceLanguage);
      const target = str(data.targetLabel);
      const ms = formatMs(data.ms);
      const metaBits = [];
      if (data.saved) metaBits.push('Saved');
      if (target) metaBits.push(target);
      if (ms) metaBits.push(ms);
      const copyLabel = data.copied ? 'Copied' : 'Copy';

      let buttons = '';
      let primaryUsed = false;
      if (data.canReplace) {
        buttons += btnHTML('copy', copyLabel, false);
        if (data.canSave && !data.saved) buttons += btnHTML('save', 'Save', false);
        buttons += btnHTML('replace', 'Replace', true);
        primaryUsed = true;
      } else if (data.canSave && !data.saved) {
        buttons += btnHTML('copy', copyLabel, false) + btnHTML('save', 'Save word', true);
        primaryUsed = true;
      }
      if (!primaryUsed) buttons += btnHTML('copy', copyLabel, true);

      head = headHTML({
        title: 'Translation',
        chip: chip,
        chipTitle: chipTitle,
        speak: speechAvailable() && !!translation,
      });
      body = '<div class="ww-body">' +
        '<p class="ww-trans" data-ww-trans>' + esc(translation) + '</p>' +
        (source ? '<p class="ww-src">from ' + esc(source) + '</p>' : '') +
        '</div>';
      foot = footHTML(metaBits.join(' · '), buttons);
    } else if (state === 'error' || state === 'setup') {
      const title = str(data.title) || (state === 'setup' ? 'Add your API key' : 'Could not check');
      const message = str(data.body) ||
        (state === 'setup'
          ? 'Add a DeepSeek or OpenAI key to start fixing as you type.'
          : 'Something went wrong. Try again in a moment.');
      head = headHTML({ title: title, chip: chip, chipTitle: chipTitle });
      body = '<div class="ww-body"><p class="ww-msg">' + esc(message) + '</p></div>';
      foot = footHTML('', actionHTML(data.action, true));
    } else {
      // unknown state — degrade to a readable card rather than throwing
      head = headHTML({ title: 'WriteWise' });
      body = '<div class="ww-body"><p class="ww-msg">' +
        esc(str(data.body) || 'Nothing to show.') + '</p></div>';
    }

    const isDialog = state === 'suggestion' || state === 'applied' || state === 'translation';
    const role = isDialog ? 'dialog'
      : (state === 'error' || state === 'setup') ? 'alert'
        : 'status';
    card.setAttribute('role', role);
    if (role === 'alert') card.setAttribute('aria-live', 'assertive');
    else if (role === 'status') card.setAttribute('aria-live', 'polite');
    else card.removeAttribute('aria-live');

    const label = state === 'suggestion' ? 'WriteWise suggestion'
      : state === 'applied' ? 'WriteWise correction applied'
        : state === 'checking' ? 'WriteWise checking text'
          : state === 'translation' ? 'WriteWise translation'
            : state === 'clean' ? 'WriteWise result'
            : (str(data.title) || 'WriteWise');
    card.setAttribute('aria-label', label);
    card.setAttribute('data-state', state);

    card.innerHTML = head + body + foot;

    if (state === 'suggestion') fillDiff(Array.isArray(data.diff) ? data.diff : null, data);
  }

  /* ── positioning ───────────────────────────────────────────────────── */

  function viewport() {
    const de = document.documentElement;
    return {
      vw: (de && de.clientWidth) || window.innerWidth || 0,
      vh: (de && de.clientHeight) || window.innerHeight || 0,
      sx: window.scrollX || window.pageXOffset || 0,
      sy: window.scrollY || window.pageYOffset || 0,
    };
  }

  function positionCard() {
    if (!card || !host) return;
    const vp = viewport();
    const vw = vp.vw;
    const vh = vp.vh;
    const sx = vp.sx;
    const sy = vp.sy;
    const h = card.offsetHeight || 0;
    const w = Math.min(CARD_WIDTH, Math.max(240, vw - EDGE * 2));

    let rect = null;
    if (anchorEl && anchorEl.isConnected) {
      try { rect = anchorEl.getBoundingClientRect(); } catch (e) { rect = null; }
    }

    let left;
    let top;
    let side = 'below';

    if (rect) {
      // measure the card first, then decide which side it fits on
      const spaceBelow = vh - rect.bottom;
      const spaceAbove = rect.top;
      if (spaceBelow < h + 12 && spaceAbove > h + 12) side = 'above';

      top = side === 'above' ? rect.top - h - GAP : rect.bottom + GAP;
      left = rect.left;

      const maxTop = vh - h - EDGE;
      if (top > maxTop) top = Math.max(EDGE, maxTop);
      if (top < EDGE) top = EDGE;

      if (left + w > vw - EDGE) left = vw - w - EDGE;
      if (left < EDGE) left = EDGE;

      top += sy;
      left += sx;
    } else if (lastLeft !== null && lastTop !== null) {
      // anchor gone: keep the last spot, but keep it on screen
      left = lastLeft - sx;
      top = lastTop - sy;
      side = card.getAttribute('data-side') || 'below';
      if (top < EDGE) top = EDGE;
      if (top + h > vh - EDGE) top = Math.max(EDGE, vh - h - EDGE);
      if (left < EDGE) left = EDGE;
      if (left + w > vw - EDGE) left = vw - w - EDGE;
      top += sy;
      left += sx;
    } else {
      top = sy + EDGE * 9;
      left = sx + EDGE;
    }

    card.setAttribute('data-side', side);
    lastLeft = Math.round(left);
    lastTop = Math.round(top);
    host.style.setProperty(
      'transform',
      'translate(' + lastLeft + 'px,' + lastTop + 'px)',
      'important'
    );
  }

  function repositionNow() {
    if (!visible) return;
    if (!anchorEl || !anchorEl.isConnected) { hide(); return; }
    positionCard();
  }

  function schedulePosition() {
    if (!visible || posRaf) return;
    posRaf = requestAnimationFrame(() => {
      posRaf = 0;
      if (posFallback) { clearTimeout(posFallback); posFallback = 0; }
      repositionNow();
    });
    // A throttled / occluded tab may never hand us a frame. Without this the
    // rAF guard would stay set forever and the card would stop following the
    // anchor (and stop hiding when the field disappears).
    posFallback = setTimeout(() => {
      posFallback = 0;
      if (!posRaf) return;
      try { cancelAnimationFrame(posRaf); } catch (e) {}
      posRaf = 0;
      repositionNow();
    }, 120);
  }

  /* ── elapsed counter ───────────────────────────────────────────────── */

  function startElapsed() {
    stopElapsed();
    elapsedStart = (window.performance && performance.now) ? performance.now() : Date.now();
    elapsedEl = card ? card.querySelector('[data-ww-elapsed]') : null;
    tickElapsed();
    elapsedTimer = setInterval(tickElapsed, 100);
  }

  function tickElapsed() {
    if (!elapsedEl) {
      elapsedEl = card ? card.querySelector('[data-ww-elapsed]') : null;
      if (!elapsedEl) return;
    }
    const now = (window.performance && performance.now) ? performance.now() : Date.now();
    elapsedEl.textContent = formatMs(now - elapsedStart);
  }

  function stopElapsed() {
    if (elapsedTimer !== null) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
    elapsedEl = null;
  }

  /* ── events ────────────────────────────────────────────────────────── */

  function speech() {
    return (typeof window !== 'undefined' && window.WriteWiseSpeech) || null;
  }

  function speechAvailable() {
    const api = speech();
    return !!(api && api.available());
  }

  /** Speak the translation on screen; the header button owns the state. */
  function speakCurrent(btn) {
    const api = speech();
    const text = str(curData.translation);
    if (!api || !btn || !text) return;
    const lang = str(curData.targetCode) || str(curData.targetLabel) || 'en';
    btn.classList.add('ww-playing');
    btn.setAttribute('aria-pressed', 'true');
    const done = () => {
      btn.classList.remove('ww-playing');
      btn.setAttribute('aria-pressed', 'false');
    };
    if (!api.speak(text, { lang: lang, onend: done })) done();
  }

  function emit(action) {
    if (!action || typeof actionFn !== 'function') return;
    try { actionFn(action); } catch (err) { warn('onAction handler threw', err); }
  }

  function onCardClick(e) {
    const t = e.target;
    const btn = (t && t.closest) ? t.closest('[data-ww-action]') : null;
    if (!btn || !card.contains(btn)) return;
    const action = btn.getAttribute('data-ww-action');
    e.preventDefault();
    e.stopPropagation();
    if (action === 'speak') {
      speakCurrent(btn);
      return;
    }
    emit(action);
    if (action === 'dismiss') hide();
  }

  function onCardMouseDown(e) {
    // page drag/selection handlers must not react to our card
    e.stopPropagation();
  }

  function isInsideCard(e) {
    if (typeof e.composedPath === 'function') {
      const path = e.composedPath();
      if (host && path && path.indexOf(host) !== -1) return true;
    }
    return !!host && e.target === host;
  }

  /** A press anywhere outside the card dismisses it. */
  function onDocPointerDown(e) {
    if (!visible) return;
    if (isInsideCard(e)) return;
    emit('dismiss');
    hide();
  }

  function onKeyDown(e) {
    if (!visible) return;

    if (e.key === 'Escape') {
      e.stopPropagation();
      emit('dismiss');
      hide();
      return;
    }

    if (e.key === 'Enter') {
      // only when focus is inside the card; never steal Enter/Tab from the page field
      const inner = shadow ? shadow.activeElement : null;
      if (!inner || !card.contains(inner)) return;
      if (curState === 'suggestion') {
        e.preventDefault();
        e.stopPropagation();
        emit('apply');
      } else if (curState === 'translation') {
        e.preventDefault();
        e.stopPropagation();
        emit('copy');
      }
      // other states: let native button activation happen
    }
  }

  /* ── public API ────────────────────────────────────────────────────── */

  function mount() {
    if (mounted) return stylesPromise || Promise.resolve();
    mounted = true;
    build();
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onDocPointerDown, true);
    window.addEventListener('scroll', schedulePosition, { passive: true, capture: true });
    window.addEventListener('resize', schedulePosition, { passive: true });
    setTheme(themeMode);
    return loadStyles();
  }

  function show(anchor, state, data) {
    if (!mounted) mount();
    if (!card) return;
    const isAnchor = anchor && (anchor.nodeType === 1 ||
      (typeof anchor === 'object' && typeof anchor.getBoundingClientRect === 'function'));
    if (isAnchor) anchorEl = anchor;

    const wasVisible = visible;
    curState = str(state) || 'checking';
    curData = (data && typeof data === 'object') ? data : {};

    stopElapsed();
    try {
      render(curState, curData);
    } catch (err) {
      warn('render failed', err);
      curState = 'error';
      curData = { title: 'Could not show suggestion', body: 'Something went wrong while rendering.' };
      try { render('error', curData); } catch (e) { return; }
    }

    card.style.display = 'flex';
    card.style.visibility = stylesReady ? '' : 'hidden';
    positionCard();
    if (stylesReady) card.style.visibility = '';

    visible = true;
    if (!wasVisible) {
      card.removeAttribute('data-enter');
      void card.offsetWidth; // reflow so the entrance restarts on re-show
      if (enterTimer !== null) { clearTimeout(enterTimer); enterTimer = null; }
      if (!reducedMotion()) {
        card.setAttribute('data-enter', '1');
        // safety: never let fill-mode pin the card at opacity 0 if the
        // animation is never painted (e.g. the tab is in the background)
        enterTimer = setTimeout(() => {
          enterTimer = null;
          if (card) card.removeAttribute('data-enter');
        }, 260);
      }
    }
    if (curState === 'checking') startElapsed();
  }

  function hide() {
    visible = false;
    const api = speech();
    if (api) api.cancel();
    stopElapsed();
    if (posRaf) { try { cancelAnimationFrame(posRaf); } catch (e) {} posRaf = 0; }
    if (posFallback) { clearTimeout(posFallback); posFallback = 0; }
    if (enterTimer !== null) { clearTimeout(enterTimer); enterTimer = null; }
    if (card) {
      card.style.display = 'none';
      card.removeAttribute('data-enter');
    }
    if (host) host.style.setProperty('transform', 'translate(-9999px,-9999px)', 'important');
    lastLeft = null;
    lastTop = null;
  }

  function isVisible() {
    return !!visible;
  }

  function onAction(fn) {
    actionFn = typeof fn === 'function' ? fn : null;
  }

  window.__wwUI = {
    version: 2,
    mount: mount,
    show: show,
    hide: hide,
    isVisible: isVisible,
    setTheme: setTheme,
    onAction: onAction,
  };
})();
