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
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14 14.8135V9.18646C14 6.04126 14 4.46866 13.0747 4.0773C12.1494 3.68593 11.0603 4.79793 8.88232 7.02192C7.75439 8.17365 7.11085 8.42869 5.50604 8.42869C4.10257 8.42869 3.40084 8.42869 2.89675 8.77262C1.85035 9.48655 2.00852 10.882 2.00852 12C2.00852 13.118 1.85035 14.5134 2.89675 15.2274C3.40084 15.5713 4.10257 15.5713 5.50604 15.5713C7.11085 15.5713 7.75439 15.8264 8.88232 16.9781C11.0603 19.2021 12.1494 20.3141 13.0747 19.9227C14 19.5313 14 17.9587 14 14.8135Z" vector-effect="non-scaling-stroke"/><path d="M17 9C17.6254 9.81968 18 10.8634 18 12C18 13.1366 17.6254 14.1803 17 15" vector-effect="non-scaling-stroke"/><path d="M20 7C21.2508 8.36613 22 10.1057 22 12C22 13.8943 21.2508 15.6339 20 17" vector-effect="non-scaling-stroke"/></svg>';

  const COPY_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M7.5 14.5C7.5 11.2002 7.5 9.55025 8.52513 8.52513C9.55025 7.5 11.2002 7.5 14.5 7.5C17.7998 7.5 19.4497 7.5 20.4749 8.52513C21.5 9.55025 21.5 11.2002 21.5 14.5C21.5 17.7998 21.5 19.4497 20.4749 20.4749C19.4497 21.5 17.7998 21.5 14.5 21.5C11.2002 21.5 9.55025 21.5 8.52513 20.4749C7.5 19.4497 7.5 17.7998 7.5 14.5Z" vector-effect="non-scaling-stroke"/><path d="M7.5 16.5C6.10355 16.5 5.40533 16.5 4.84402 16.3036C3.83866 15.9518 3.0482 15.1613 2.69641 14.156C2.5 13.5947 2.5 12.8964 2.5 11.5V9.5C2.5 6.20017 2.5 4.55025 3.52513 3.52513C4.55025 2.5 6.20017 2.5 9.5 2.5H11.5C12.8964 2.5 13.5947 2.5 14.156 2.69641C15.1613 3.0482 15.9518 3.83866 16.3036 4.84402C16.5 5.40533 16.5 6.10355 16.5 7.5" vector-effect="non-scaling-stroke"/></svg>';

  const CHECK_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 14L8.5 17.5L19 6.5" vector-effect="non-scaling-stroke"/></svg>';

  const BOOKMARK_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4.5 18.212V8.23515C4.5 5.53157 4.5 4.17979 5.32376 3.33989C6.14752 2.5 7.47335 2.5 10.125 2.5H13.875C16.5267 2.5 17.8525 2.5 18.6762 3.33989C19.5 4.17979 19.5 5.53158 19.5 8.23515V18.212C19.5 20.1274 19.5 21.0852 18.8987 21.4076C18.2975 21.7301 17.5234 21.1875 15.9753 20.1024L14.1245 18.805C13.0964 18.0843 12.5824 17.724 12 17.724C11.4176 17.724 10.9036 18.0843 9.87552 18.805L8.02469 20.1024C6.47657 21.1875 5.70252 21.7301 5.10126 21.4076C4.5 21.0852 4.5 20.1274 4.5 18.212Z" vector-effect="non-scaling-stroke"/></svg>';

  const CLOSE_SVG =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18.9991 19L5 5.00098" vector-effect="non-scaling-stroke"/><path d="M19 5L5.00092 18.999" vector-effect="non-scaling-stroke"/></svg>';

  const FALLBACK_CSS = [
    '.ww-tokens{position:absolute;top:0;left:0;display:block;color:#f2f2f0;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:left;direction:ltr}',
    '.ww-card{display:flex;flex-direction:column;width:380px;max-width:calc(100vw - 16px);max-height:320px;padding:14px;background:#131313;color:#f2f2f0;border-radius:20px;corner-shape:squircle;box-shadow:0 10px 28px rgba(0,0,0,.38),0 1px 3px rgba(0,0,0,.24);pointer-events:auto;overflow:hidden}',
    '.ww-head{display:flex;align-items:center;gap:8px}', '.ww-mark{color:#d6adf2;display:inline-flex}',
    '.ww-title{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ww-x{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:999px;corner-shape:squircle;background:none;color:#8d8d89;cursor:pointer}', '.ww-tools{display:flex;align-items:center;gap:2px;margin:-4px -6px -4px 0}',
    '.ww-pair{display:flex;flex-wrap:wrap;align-items:flex-start;gap:2px 6px;min-width:0}',
    '.ww-unit{display:inline-flex;align-items:flex-start;gap:3px;min-width:0;max-width:100%}', '.ww-unit-trans{flex:1 1 auto}',
    '.ww-arrow{color:#8d8d89;font-size:12px;line-height:1.45}',
    '.ww-og{margin:0;max-width:18ch;color:#aeaeaa;font-size:13px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ww-say{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:20px;height:20px;margin:0;padding:0;border:0;border-radius:999px;background:none;color:#8d8d89;cursor:pointer}',
    '.ww-body{flex:1;min-height:0;overflow:auto;margin-top:12px}', '.ww-foot{display:flex;gap:8px;align-items:center;margin-top:14px}',
    '.ww-meta{flex:1;min-width:0;font-size:11px;color:#aeaeaa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ww-btn{height:30px;padding:0 14px;border-radius:999px;corner-shape:squircle;font:600 12px/1 inherit;cursor:pointer;border:1px solid transparent;background:none;color:#f2f2f0}',
    '.ww-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:0;border-radius:999px;corner-shape:squircle;background:none;color:#aeaeaa;cursor:pointer}', '.ww-icon-btn.ww-copied{color:#5cb87a}',
    '.ww-btn-ghost{color:#aeaeaa;border-color:#343434}', '.ww-btn-primary{background:#d6adf2;color:#1a1a18}',
    '.ww-ins{background:rgba(92,184,122,.15);color:#5cb87a;text-decoration:underline;text-decoration-color:#5cb87a;border-radius:6px}', '.ww-ins + .ww-del,.ww-del + .ww-ins{margin-left:3px}', '.ww-del{background:rgba(217,83,79,.15);color:#e27d79;text-decoration:line-through;text-decoration-color:#e27d79;border-radius:6px}',
    '.ww-sub,.ww-msg{margin:0;color:#aeaeaa}', '.ww-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}', '.ww-skel{height:8px;border-radius:4px;background:#232323;margin:0 0 8px}',
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

  /* Only the live "checking" clock uses this now; results no longer report
     how long the model took. */
  /* Old saved entries and older payloads can still carry "Polski (pl)"; the
     code is not information the reader needs. */
  function plainLabel(value) {
    return String(value == null ? '' : value).replace(/\s*\([a-z]{2}(?:-[a-z]{2})?\)\s*$/i, '');
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
    return '<div class="ww-head">' +
      '<span class="ww-mark">' + MARK_SVG + '</span>' +
      (opts.spinner ? '<span class="ww-spin" aria-hidden="true"></span>' : '') +
      '<span class="ww-title">' + esc(opts.title) + '</span>' +
      (opts.timer ? '<span class="ww-timer" data-ww-elapsed></span>' : '') +
      '<span class="ww-tools">' +
        '<button type="button" class="ww-x" data-ww-action="dismiss" aria-label="Dismiss">' +
          '<span class="ww-sr">Dismiss</span>' + CLOSE_SVG + '</button>' +
      '</span>' +
      '</div>';
  }

  function btnHTML(action, label, primary) {
    return '<button type="button" class="ww-btn ' + (primary ? 'ww-btn-primary' : 'ww-btn-ghost') + '"' +
      ' data-ww-action="' + esc(action) + '">' + esc(label) + '</button>';
  }

  /* A line's own speaker: the card can pronounce the original and the
     translation, so the button lives on the line it reads aloud instead of in
     the header where it could only mean one of them. */
  function sayHTML(voice, label, title) {
    return '<button type="button" class="ww-say" data-ww-action="speak"' +
      ' data-ww-voice="' + esc(voice) + '"' +
      ' aria-label="' + esc(label) + '" aria-pressed="false" title="' + esc(title || label) + '">' +
      '<span class="ww-sr">' + esc(label) + '</span>' + SPEAK_SVG + '</button>';
  }

  /* Secondary actions in the card's footer are glyph buttons: the word the
     action produces is not the label, so a 13px icon plus a screen-reader
     string is quieter than a light pill with dark text in it. The primary
     action always keeps its label. */
  function iconBtnHTML(action, label, title, svg, extraClass) {
    return '<button type="button" class="ww-icon-btn' + (extraClass ? ' ' + extraClass : '') + '"' +
      ' data-ww-action="' + esc(action) + '"' +
      ' aria-label="' + esc(label) + '" title="' + esc(title || label) + '">' +
      '<span class="ww-sr">' + esc(label) + '</span>' + svg + '</button>';
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
    let head = '';
    let body = '';
    let foot = '';

    if (state === 'checking') {
      head = headHTML({ title: str(data.title) || 'Checking…', spinner: true, timer: true });
      body = '<div class="ww-body">' +
        '<div class="ww-skel" style="width:92%"></div>' +
        '<div class="ww-skel" style="width:76%"></div>' +
        '<div class="ww-skel" style="width:54%"></div>' +
        '</div>';
    } else if (state === 'suggestion') {
      const diff = Array.isArray(data.diff) ? data.diff : null;
      const reported = num(data.changes);
      const changes = reported !== null ? Math.max(0, Math.round(reported)) : countDiff(diff);
      head = headHTML({ title: 'Suggested fix' });
      body = '<div class="ww-body"><div class="ww-diff" data-ww-diff></div></div>';
      foot = footHTML(changesLabel(changes), btnHTML('apply', 'Apply', true));
    } else if (state === 'clean') {
      head = headHTML({ title: 'Looks good' });
      body = '<div class="ww-body"><p class="ww-sub">No changes needed.</p></div>';
      if (data.canRecheck) foot = footHTML('', btnHTML('recheck', 'Recheck', false));
    } else if (state === 'applied') {
      head = headHTML({ title: 'Applied' });
      body = '<div class="ww-body"><p class="ww-sub">Your text has been updated.</p></div>';
      foot = footHTML('', data.canUndo === false ? '' : btnHTML('undo', 'Undo', false));
    } else if (state === 'translation') {
      const translation = str(data.translation);
      const source = plainLabel(str(data.sourceLanguage));
      const target = plainLabel(str(data.targetLabel));
      const metaBits = [];
      if (data.saved) metaBits.push('Saved');
      if (source && target) metaBits.push(source + ' → ' + target);
      else if (target) metaBits.push(target);
      const copyLabel = data.copied ? 'Copied' : 'Copy';
      const copyIcon = iconBtnHTML('copy', copyLabel, copyLabel,
        data.copied ? CHECK_SVG : COPY_SVG, data.copied ? 'ww-copied' : '');

      let buttons = '';
      let primaryUsed = false;
      if (data.canReplace) {
        buttons += copyIcon;
        if (data.canSave && !data.saved) {
          buttons += iconBtnHTML('save', 'Save', 'Save word', BOOKMARK_SVG);
        }
        buttons += btnHTML('replace', 'Replace', true);
        primaryUsed = true;
      } else if (data.canSave && !data.saved) {
        buttons += copyIcon + btnHTML('save', 'Save word', true);
        primaryUsed = true;
      }
      if (!primaryUsed) buttons += btnHTML('copy', copyLabel, true);

      const spoken = speechAvailable();
      const original = str(data.source);
      head = headHTML({ title: 'Translation' });
      body = '<div class="ww-body">' +
        '<div class="ww-pair">' +
          (original
            ? '<span class="ww-unit">' +
                '<span class="ww-og" data-ww-source title="' + esc(original) + '">' + esc(original) + '</span>' +
                (spoken ? sayHTML('source', 'Play original pronunciation', 'Play the original word') : '') +
              '</span>' +
              '<span class="ww-arrow" aria-hidden="true">→</span>'
            : '') +
          '<span class="ww-unit ww-unit-trans">' +
            '<span class="ww-trans" data-ww-trans>' + esc(translation) + '</span>' +
            (spoken && translation
              ? sayHTML('target', 'Play translation pronunciation', 'Play the translation')
              : '') +
          '</span>' +
        '</div>' +
        '</div>';
      foot = footHTML(metaBits.join(' · '), buttons);
    } else if (state === 'error' || state === 'setup') {
      const title = str(data.title) || (state === 'setup' ? 'Add your API key' : 'Could not check');
      const message = str(data.body) ||
        (state === 'setup'
          ? 'Add a DeepSeek or OpenAI key to start fixing as you type.'
          : 'Something went wrong. Try again in a moment.');
      head = headHTML({ title: title });
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

  /** Speak the line that owns the button — the original or the translation. */
  function speakCurrent(btn) {
    const api = speech();
    if (!api || !btn) return;
    const voice = btn.getAttribute('data-ww-voice') === 'source' ? 'source' : 'target';
    const text = voice === 'source' ? str(curData.source) : str(curData.translation);
    if (!text) return;
    const lang = voice === 'source'
      ? (str(curData.sourceCode) || str(curData.sourceLanguage) || 'en')
      : (str(curData.targetCode) || str(curData.targetLabel) || 'en');
    const label = voice === 'source'
      ? (plainLabel(str(curData.sourceLanguage)) || 'this language')
      : (plainLabel(str(curData.targetLabel)) || 'this language');
    btn.classList.add('ww-playing');
    btn.setAttribute('aria-pressed', 'true');
    clearVoiceNote();
    const done = () => {
      btn.classList.remove('ww-playing');
      btn.setAttribute('aria-pressed', 'false');
    };
    const spoke = api.speak(text, { lang: lang, onend: done, onmissing: () => showVoiceNote(label, voice) });
    if (!spoke) done();
  }

  /* No local voice for the language on this line: say so once and offer the
     one thing that fixes it — the neural voice — instead of letting the OS read
     Ukrainian with an English voice. */
  let voiceGap = 'target';

  function clearVoiceNote() {
    const note = card && card.querySelector('[data-ww-note]');
    if (note && note.parentNode) note.parentNode.removeChild(note);
  }

  function showVoiceNote(label, voice) {
    if (!card) return;
    const body = card.querySelector('.ww-body');
    if (!body) return;
    voiceGap = voice === 'source' ? 'source' : 'target';
    let note = card.querySelector('[data-ww-note]');
    if (!note) {
      note = document.createElement('div');
      note.className = 'ww-note';
      note.setAttribute('data-ww-note', '');
      body.appendChild(note);
    }
    note.innerHTML = '<span class="ww-note-text">No voice for ' + esc(label) + ' on this computer.</span>' +
      '<button type="button" class="ww-note-btn" data-ww-action="neural">Use neural voice</button>';
  }

  /** Re-run the speaker a line already carries — used after a voice is enabled. */
  function replay(which) {
    if (!card) return false;
    const line = (which === 'source' || which === 'target') ? which : voiceGap;
    const btn = card.querySelector('[data-ww-voice="' + line + '"]');
    if (!btn) return false;
    speakCurrent(btn);
    return true;
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
    replay: replay,
  };
})();
