/**
 * Saved words — the page behind the vocabulary list.
 *
 * Two views in one document: the list (search, filters, expand, add, export,
 * clear) and review (due queue, reveal, grade). All persistence lives in
 * ../src/vocab.js; this file only renders and routes.
 */

import {
  listWords,
  saveWord,
  deleteWord,
  clearWords,
  reviewWord,
  dueWords,
  statsOf,
  isDue,
  toCsv,
  toAnkiTsv,
  toJson,
  INTERVALS,
} from '../src/vocab.js';
import { codeForLanguageName, codeFromLabel, languageDisplayLabel } from '../src/languages.js';

/* ── small helpers ───────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

let dateFmt = null;
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    if (!dateFmt) dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
    return dateFmt.format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

const byNewest = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

/* Older entries stored "Polski (pl)"; the code is for speech, not for reading. */
const plainLabel = (v) => String(v == null ? '' : v).replace(/\s*\([a-z]{2}(?:-[a-z]{2})?\)\s*$/i, '');
const pairOf = (w) => [plainLabel(w.source), plainLabel(w.target)].filter(Boolean).join(' → ');

function progressLabel(w) {
  const box = Math.min(Math.max(Number(w.box) || 0, 0), INTERVALS.length - 1);
  return `Learning ${box + 1}/${INTERVALS.length}`;
}

/* ── state ───────────────────────────────────────────────────────────── */

const state = {
  words: [],
  query: '',
  filter: 'all', // 'all' | 'due'
  expanded: null,
  view: 'list', // 'list' | 'review'
  queue: [],
  index: 0,
  revealed: false,
  clearArmed: false,
};

const el = {};
let notices = [];

const TRASH_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18.8516 16.3743L19.5 6H4.5L5.14839 16.3743C5.315 19.0401 5.39831 20.373 6.26426 21.1865C7.13021 22 8.46571 22 11.1367 22H12.8633C15.5343 22 16.8698 22 17.7357 21.1865C18.6017 20.373 18.685 19.0401 18.8516 16.3743Z" vector-effect="non-scaling-stroke"/><path d="M15.5 6H21M15.5 6L15.3721 4.97683C15.1595 3.2762 13.7139 2 12 2C10.2861 2 8.84047 3.2762 8.6279 4.97683L8.5 6M15.5 6H8.5M3 6H8.5" vector-effect="non-scaling-stroke"/><path d="M9.5 11V17M14.5 11V17" vector-effect="non-scaling-stroke"/></svg>';

const SPEAK_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14 14.8135V9.18646C14 6.04126 14 4.46866 13.0747 4.0773C12.1494 3.68593 11.0603 4.79793 8.88232 7.02192C7.75439 8.17365 7.11085 8.42869 5.50604 8.42869C4.10257 8.42869 3.40084 8.42869 2.89675 8.77262C1.85035 9.48655 2.00852 10.882 2.00852 12C2.00852 13.118 1.85035 14.5134 2.89675 15.2274C3.40084 15.5713 4.10257 15.5713 5.50604 15.5713C7.11085 15.5713 7.75439 15.8264 8.88232 16.9781C11.0603 19.2021 12.1494 20.3141 13.0747 19.9227C14 19.5313 14 17.9587 14 14.8135Z" vector-effect="non-scaling-stroke"/><path d="M17 9C17.6254 9.81968 18 10.8634 18 12C18 13.1366 17.6254 14.1803 17 15" vector-effect="non-scaling-stroke"/><path d="M20 7C21.2508 8.36613 22 10.1057 22 12C22 13.8943 21.2508 15.6339 20 17" vector-effect="non-scaling-stroke"/></svg>';

/* ── pronunciation ──────────────────────────────────────────────────── */

const speech = () => (typeof window !== 'undefined' && window.WriteWiseSpeech) || null;
const canSpeak = () => {
  const api = speech();
  return !!(api && api.available());
};

/** The language a saved entry is worth hearing in: target, else source. */
const entryLang = (w, which) => {
  if (which === 'source') return w.sourceCode || codeForLanguageName(w.source) || '';
  return w.targetCode || codeFromLabel(w.target) || '';
};

function play(btn, text, lang, done) {
  const api = speech();
  if (!api || !btn || !text) return;
  hideNotice();
  btn.classList.add('is-playing');
  btn.setAttribute('aria-pressed', 'true');
  const reset = () => {
    btn.classList.remove('is-playing');
    btn.setAttribute('aria-pressed', 'false');
    if (typeof done === 'function') done();
  };
  if (!api.speak(text, { lang: lang || 'en', onend: reset, onmissing: showNotice })) reset();
}

/* The machine has no voice for this language. Speaking it with another
   language's voice is what this notice exists to replace. */
let noticeTimer = 0;

function showNotice(locale) {
  if (!notices.length) return;
  const code = String(locale || '').split('-')[0].toLowerCase();
  const name = languageDisplayLabel(code) || 'this language';
  const message =
    `No voice for ${name} on this computer. Turn on the neural voice in settings to hear it.`;
  for (const note of notices) {
    note.textContent = message;
    note.hidden = false;
  }
  announce(message);
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(hideNotice, 6000);
}

function hideNotice() {
  clearTimeout(noticeTimer);
  for (const note of notices) note.hidden = true;
}

function stopSpeech() {
  const api = speech();
  if (api) api.cancel();
}

/* ── data ────────────────────────────────────────────────────────────── */

async function refresh({ keepScroll = true } = {}) {
  const y = keepScroll ? window.scrollY : 0;
  try {
    state.words = (await listWords()).sort(byNewest);
  } catch (err) {
    state.words = [];
    announce('Could not load saved words.');
    console.warn('[WriteWise] vocab load failed', err);
  }
  if (state.expanded && !state.words.some((w) => w.id === state.expanded)) state.expanded = null;
  if (state.view === 'list') renderList();
  else renderReview();
  if (keepScroll) window.scrollTo(0, y);
}

/* ── list view ───────────────────────────────────────────────────────── */

function visibleWords() {
  const q = state.query.trim().toLowerCase();
  let list = state.words;
  if (state.filter === 'due') list = list.filter((w) => isDue(w));
  if (!q) return list;
  return list.filter((w) =>
    `${w.word}\n${w.translation}\n${w.context}\n${w.host}`.toLowerCase().includes(q));
}

function renderList() {
  const stats = statsOf(state.words);
  const list = visibleWords();

  el.dueCount.hidden = stats.due === 0;
  el.dueCount.textContent = String(stats.due);
  el.reviewBtn.disabled = stats.due === 0;
  el.reviewBtn.title = stats.due === 0 ? 'Nothing is due for review' : `Review ${plural(stats.due, 'word', 'words')}`;
  el.filterAll.setAttribute('aria-pressed', String(state.filter === 'all'));
  el.filterDue.setAttribute('aria-pressed', String(state.filter === 'due'));

  const hasWords = stats.total > 0;
  el.listWrap.hidden = list.length === 0;
  el.foot.hidden = !hasWords;
  el.emptyWords.hidden = hasWords;
  el.emptyMatch.hidden = !(hasWords && list.length === 0);

  el.list.innerHTML = list.map(rowHtml).join('');

  if (!el.emptyMatch.hidden) {
    const searching = state.query.trim().length > 0;
    el.emptyMatchTitle.textContent = searching ? 'No matches' : 'Nothing due today';
    el.emptyMatchText.textContent = searching
      ? `Nothing here matches “${state.query.trim()}”.`
      : 'Every saved word has been reviewed. Come back tomorrow.';
    el.clearSearchBtn.textContent = searching ? 'Clear search' : 'Show all';
  }

  const bits = [plural(stats.total, 'word', 'words'), `${stats.due} due`];
  if (stats.known > 0) bits.push(`${stats.known} known`);
  if (list.length !== stats.total) bits.push(`${list.length} shown`);
  el.footStats.textContent = bits.join(' · ');

  el.clearConfirm.hidden = !state.clearArmed;
  el.clearBtn.hidden = state.clearArmed;

  const noWords = stats.total === 0;
  for (const btn of [el.exportCsv, el.exportAnki, el.exportJson]) btn.disabled = noWords;
}

function rowHtml(w) {
  const open = state.expanded === w.id;
  const due = isDue(w);
  const pair = pairOf(w);
  const context = w.context || '';

  return `<article class="word-row" data-id="${esc(w.id)}" tabindex="0" aria-expanded="${open}">
  <div class="wr-top">
    <div class="wr-wordline">
      <div class="wr-word" title="${esc(w.word)}">${esc(w.word)}</div>
      ${speakButton(w)}
    </div>
    <div class="wr-context" title="${esc(context)}">${context ? esc(context) : 'No context'}</div>
    <div class="wr-trans-line">
      <div class="wr-translation" title="${esc(w.translation)}">${esc(w.translation)}</div>
    </div>
    <div class="wr-meta">
      ${pair ? `<span class="wr-pair">${esc(pair)}</span>` : ''}
      ${w.host ? `<span class="wr-host" title="${esc(w.host)}">${esc(w.host)}</span>` : ''}
    </div>
    <div class="wr-side">
      ${due ? '<span class="due-pill">Due</span>' : ''}
      <button type="button" class="icon-btn" data-action="delete" aria-label="Delete ${esc(w.word)}">
        ${TRASH_SVG}
      </button>
    </div>
  </div>
  <div class="wr-detail"${open ? '' : ' hidden'}>
    ${context ? `<p class="detail-context">${esc(context)}</p>` : ''}
    <dl class="detail-meta">
      <div><dt>Added</dt><dd>${fmtDate(w.createdAt)}</dd></div>
      <div><dt>Last review</dt><dd>${w.lastReviewedAt ? fmtDate(w.lastReviewedAt) : 'Never'}</dd></div>
      <div><dt>Progress</dt><dd>${progressLabel(w)}</dd></div>
      <div><dt>Reviews</dt><dd>${w.reviews || 0}</dd></div>
    </dl>
  </div>
</article>`;
}

function speakButton(w) {
  if (!canSpeak() || !w.word) return '';
  const lang = entryLang(w, 'source') || entryLang(w, 'target');
  return `<button type="button" class="icon-btn speak-btn" data-action="speak"
    data-text="${esc(w.word)}" data-lang="${esc(lang)}"
    aria-label="Play pronunciation of ${esc(w.word)}" title="Play pronunciation">
    ${SPEAK_SVG}
  </button>`;
}

function focusRow(id) {
  const row = el.list.querySelector(`.word-row[data-id="${id}"]`);
  if (row) row.focus();
}

function toggleExpand(id) {
  state.expanded = state.expanded === id ? null : id;
  renderList();
  focusRow(id);
}

async function onDelete(id) {
  const rows = [...el.list.querySelectorAll('.word-row')];
  const index = Math.max(0, rows.findIndex((r) => r.dataset.id === id));
  const word = state.words.find((w) => w.id === id);
  await deleteWord(id);
  await refresh();
  announce(word ? `Deleted ${word.word}.` : 'Word deleted.');
  const next = el.list.querySelectorAll('.word-row')[Math.min(index, el.list.querySelectorAll('.word-row').length - 1)];
  if (next) next.focus();
}

/* ── add form ────────────────────────────────────────────────────────── */

function openAdd() {
  el.addForm.hidden = false;
  el.addBtn.setAttribute('aria-expanded', 'true');
  el.addError.textContent = '';
  el.addWord.focus();
}

function closeAdd() {
  el.addForm.hidden = true;
  el.addBtn.setAttribute('aria-expanded', 'false');
  el.addError.textContent = '';
  el.addForm.reset();
}

async function submitAdd(e) {
  e.preventDefault();
  const word = el.addWord.value.trim();
  const translation = el.addTranslation.value.trim();
  const context = el.addContext.value.trim();

  if (!word || !translation) {
    el.addError.textContent = 'A word and a translation are both needed.';
    (!word ? el.addWord : el.addTranslation).focus();
    return;
  }

  const result = await saveWord({ word, translation, context });
  if (!result || !result.ok) {
    el.addError.textContent = 'Could not save that word.';
    return;
  }

  closeAdd();
  state.query = '';
  state.filter = 'all';
  el.searchInput.value = '';
  await refresh({ keepScroll: false });
  announce(result.updated ? `Updated ${word}.` : `Saved ${word}.`);
  el.searchInput.focus();
}

/* ── exports ─────────────────────────────────────────────────────────── */

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function exportAs(kind) {
  const words = state.words;
  if (!words.length) return;
  if (kind === 'csv') download('writewise-words.csv', toCsv(words), 'text/csv;charset=utf-8');
  else if (kind === 'anki') download('writewise-anki.txt', toAnkiTsv(words), 'text/tab-separated-values;charset=utf-8');
  else download('writewise-words.json', toJson(words), 'application/json;charset=utf-8');
  announce(`Exported ${plural(words.length, 'word', 'words')}.`);
}

/* ── review view ─────────────────────────────────────────────────────── */

function enterReview() {
  const queue = dueWords(state.words);
  state.view = 'review';
  state.queue = queue;
  state.index = 0;
  state.revealed = false;
  state.expanded = null;
  el.listView.hidden = true;
  el.reviewView.hidden = false;
  window.scrollTo(0, 0);
  el.reviewDone.hidden = true;
  el.reviewCard.hidden = false;
  renderReview();
}

function exitReview() {
  stopSpeech();
  state.view = 'list';
  state.queue = [];
  state.index = 0;
  state.revealed = false;
  el.reviewView.hidden = true;
  el.listView.hidden = false;
  renderList();
  el.reviewBtn.focus();
}

function currentCard() {
  return state.queue[state.index] || null;
}

function renderReview() {
  const total = state.queue.length;
  const w = currentCard();

  if (!w) {
    showDone(total === 0 && state.words.length === 0 ? 'empty' : 'finished');
    return;
  }

  el.reviewDone.hidden = true;
  el.reviewCard.hidden = false;

  el.reviewCount.textContent = `${state.index + 1} / ${total}`;
  el.progress.setAttribute('aria-valuemax', String(total));
  el.progress.setAttribute('aria-valuenow', String(state.index + 1));
  el.progressFill.style.width = `${((state.index + 1) / total) * 100}%`;

  el.reviewHint.textContent = [pairOf(w), w.host].filter(Boolean).join(' · ') || 'Saved word';
  el.reviewWord.textContent = w.word;

  const wordLang = entryLang(w, 'source');
  el.wordSpeak.hidden = !(canSpeak() && w.word && wordLang);
  el.wordSpeak.dataset.text = w.word;
  el.wordSpeak.dataset.lang = wordLang;
  el.wordSpeak.setAttribute('aria-label', `Play pronunciation of ${w.word}`);

  if (!state.revealed) {
    el.revealWrap.hidden = false;
    el.translationWrap.hidden = true;
    el.grades.hidden = true;
    el.revealBtn.focus();
    return;
  }

  el.revealWrap.hidden = true;
  el.translationWrap.hidden = false;
  el.translationText.textContent = w.translation;
  el.reviewContext.textContent = w.context || '';
  el.reviewContext.hidden = !w.context;
  el.grades.hidden = false;
  const first = el.grades.querySelector('[data-grade="again"]');
  if (first) first.focus();
}

function showDone(kind) {
  stopSpeech();
  el.reviewCard.hidden = true;
  el.grades.hidden = true;
  el.reviewDone.hidden = false;
  el.progressFill.style.width = '100%';
  el.progress.setAttribute('aria-valuenow', String(state.queue.length));
  el.progress.setAttribute('aria-valuemax', String(state.queue.length));

  const heading = el.reviewDone.querySelector('h2');
  if (heading) heading.textContent = kind === 'empty' ? 'Nothing due today.' : 'Nothing due.';
  const n = state.words.length;
  el.doneStats.textContent = n === 0
    ? 'Save a word from any page and it will show up here.'
    : `${plural(n, 'word is', 'words are')} saved. Come back when the next one is due.`;
  el.doneBack.focus();
}

function reveal() {
  if (state.view !== 'review' || state.revealed || !currentCard()) return;
  state.revealed = true;
  renderReview();
  const w = currentCard();
  if (w) announce(`${w.word}: ${w.translation}`);
}

async function grade(g) {
  if (state.view !== 'review' || !state.revealed) return;
  const w = currentCard();
  if (!w) return;
  stopSpeech();
  state.revealed = false;
  try {
    await reviewWord(w.id, g);
  } catch (err) {
    console.warn('[WriteWise] review failed', err);
  }
  state.index += 1;
  try {
    state.words = (await listWords()).sort(byNewest);
  } catch {
    /* keep the stale list; the queue still advances */
  }
  renderReview();
  announce(g === 'again' ? 'Again.' : g === 'easy' ? 'Easy.' : 'Good.');
}

/* ── announcements ───────────────────────────────────────────────────── */

let announceTimer = 0;
function announce(message) {
  if (!el.live) return;
  clearTimeout(announceTimer);
  el.live.textContent = '';
  announceTimer = setTimeout(() => {
    el.live.textContent = message;
  }, 30);
}

/* ── wiring ──────────────────────────────────────────────────────────── */

function bind() {
  el.backBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') });
  });

  /* search + filters */
  el.searchInput.addEventListener('input', () => {
    state.query = el.searchInput.value;
    renderList();
  });
  el.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.searchInput.value) {
      e.preventDefault();
      el.searchInput.value = '';
      state.query = '';
      renderList();
    }
  });
  el.filterAll.addEventListener('click', () => {
    state.filter = 'all';
    renderList();
  });
  el.filterDue.addEventListener('click', () => {
    state.filter = 'due';
    renderList();
  });
  el.clearSearchBtn.addEventListener('click', () => {
    if (state.query.trim()) {
      el.searchInput.value = '';
      state.query = '';
    } else {
      state.filter = 'all';
    }
    renderList();
    el.searchInput.focus();
  });

  /* list: expand + delete (delegated) */
  el.list.addEventListener('click', (e) => {
    const del = e.target.closest('[data-action="delete"]');
    const speak = e.target.closest('[data-action="speak"]');
    const row = e.target.closest('.word-row');
    if (!row) return;
    if (speak) {
      e.stopPropagation();
      play(speak, speak.dataset.text, speak.dataset.lang);
      return;
    }
    if (del) {
      e.stopPropagation();
      void onDelete(row.dataset.id);
      return;
    }
    toggleExpand(row.dataset.id);
  });
  el.list.addEventListener('keydown', (e) => {
    const row = e.target.closest('.word-row');
    if (!row || e.target !== row) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand(row.dataset.id);
    }
  });

  /* add form */
  el.addBtn.addEventListener('click', () => {
    if (el.addForm.hidden) openAdd();
    else closeAdd();
  });
  el.emptyAddBtn.addEventListener('click', openAdd);
  el.addCancel.addEventListener('click', () => {
    closeAdd();
    el.addBtn.focus();
  });
  el.addForm.addEventListener('submit', (e) => void submitAdd(e));
  el.addForm.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAdd();
      el.addBtn.focus();
    }
  });

  /* exports */
  el.exportCsv.addEventListener('click', () => exportAs('csv'));
  el.exportAnki.addEventListener('click', () => exportAs('anki'));
  el.exportJson.addEventListener('click', () => exportAs('json'));

  /* clear all — inline confirmation, never window.confirm */
  el.clearBtn.addEventListener('click', () => {
    state.clearArmed = true;
    renderList();
    el.clearYes.focus();
  });
  el.clearCancel.addEventListener('click', () => {
    state.clearArmed = false;
    renderList();
    el.clearBtn.focus();
  });
  el.clearYes.addEventListener('click', async () => {
    state.clearArmed = false;
    await clearWords();
    state.expanded = null;
    await refresh();
    announce('All saved words cleared.');
    el.addBtn.focus();
  });
  el.clearConfirm.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      state.clearArmed = false;
      renderList();
      el.clearBtn.focus();
    }
  });

  /* review */
  el.reviewBtn.addEventListener('click', () => {
    if (el.reviewBtn.disabled) return;
    enterReview();
  });
  el.wordSpeak.addEventListener('click', () => {
    const w = currentCard();
    if (w) play(el.wordSpeak, w.word, entryLang(w, 'source'));
  });
  el.revealBtn.addEventListener('click', reveal);
  el.reviewExit.addEventListener('click', exitReview);
  el.doneBack.addEventListener('click', exitReview);
  el.grades.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-grade]');
    if (btn) void grade(btn.dataset.grade);
  });

  /* global keys */
  document.addEventListener('keydown', (e) => {
    if (state.view !== 'review') {
      if (e.key === 'Escape' && state.clearArmed) {
        state.clearArmed = false;
        renderList();
        el.clearBtn.focus();
      }
      return;
    }

    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === 'Escape') {
      e.preventDefault();
      exitReview();
      return;
    }

    if (!el.reviewDone.hidden) return;

    if (!state.revealed) {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        reveal();
        return;
      }
    }

    if (e.key === 'p' || e.key === 'P') {
      const w = currentCard();
      if (!w) return;
      e.preventDefault();
      play(el.wordSpeak, w.word, entryLang(w, 'source'));
      return;
    }

    if (!state.revealed) return;

    if (e.key === '1' || e.key === '2' || e.key === '3') {
      e.preventDefault();
      void grade(e.key === '1' ? 'again' : e.key === '2' ? 'good' : 'easy');
    }
  });

  /* external changes (another tab, the in-page card saving a word) */
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.ww_settings) void applyTheme();
      if (!changes.ww_vocab) return;
      void refresh({ keepScroll: state.view === 'list' }).then(() => {
        if (state.view !== 'review') return;
        // The card we were showing may have been deleted elsewhere.
        if (state.revealed && !currentCard()) {
          state.revealed = false;
          renderReview();
        } else if (!state.revealed && !currentCard() && state.index >= state.queue.length) {
          showDone('finished');
        }
      });
    });
  }
}

async function applyTheme() {
  try {
    const got = await chrome.storage.local.get('ww_settings');
    const theme = got && got.ww_settings && got.ww_settings.theme;
    if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  } catch {
    /* system theme is the default */
  }
}

function cache() {
  const ids = [
    'backBtn', 'searchInput', 'filterAll', 'filterDue', 'dueCount', 'reviewBtn',
    'exportCsv', 'exportAnki', 'exportJson', 'addBtn', 'addForm', 'addWord',
    'addTranslation', 'addContext', 'addError', 'addCancel', 'addSave',
    'listWrap', 'list', 'emptyWords', 'emptyAddBtn', 'emptyMatch',
    'emptyMatchTitle', 'emptyMatchText', 'clearSearchBtn',
    'foot', 'footStats', 'clearBtn', 'clearConfirm', 'clearCancel', 'clearYes',
    'listView', 'reviewView', 'reviewCount', 'progress', 'progressFill',
    'reviewCard', 'reviewHint', 'reviewWord', 'wordSpeak', 'revealWrap', 'revealBtn',
    'translationWrap', 'translationText', 'reviewContext', 'grades',
    'reviewDone', 'doneStats', 'doneBack', 'reviewExit', 'live',
  ];
  for (const id of ids) el[id] = $(id);
  notices = [...document.querySelectorAll('.speak-notice')];
}

async function boot() {
  cache();
  if (window.WriteWiseSpeech && window.WriteWiseSpeech.connectRemote) {
    window.WriteWiseSpeech.connectRemote();
  }
  await applyTheme();
  bind();
  await refresh({ keepScroll: false });
}

void boot();
