/**
 * Saved words — the learning side of WriteWise.
 *
 * One local list, one entry shape, one small Leitner scheduler. No accounts,
 * no cloud: the vault is a file in chrome.storage.local that the vocabulary
 * page can export at any time.
 */

export const VOCAB_KEY = 'ww_vocab';
export const VOCAB_LIMIT = 2000;

/** Days until the next review, by box (0 = just saved / forgotten). */
export const INTERVALS = [1, 2, 4, 8, 16];
export const MAX_BOX = INTERVALS.length - 1;

const DAY = 24 * 60 * 60 * 1000;

const str = (v) => (typeof v === 'string' ? v : '');
const clip = (v, n) => str(v).replace(/\s+/g, ' ').trim().slice(0, n);

const newId = () =>
  `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export function normalizeWord(raw) {
  const w = raw && typeof raw === 'object' ? raw : {};
  const word = clip(w.word, 80);
  const translation = clip(w.translation, 200);
  if (!word || !translation) return null;
  const box = Number.isFinite(Number(w.box))
    ? Math.max(0, Math.min(MAX_BOX, Math.round(Number(w.box))))
    : 0;
  return {
    id: str(w.id) || newId(),
    word,
    translation,
    source: clip(w.source, 40),
    sourceCode: clip(w.sourceCode, 8).toLowerCase(),
    target: clip(w.target, 40),
    targetCode: clip(w.targetCode, 8).toLowerCase(),
    context: clip(w.context, 280),
    host: clip(w.host, 80),
    createdAt: str(w.createdAt) || new Date().toISOString(),
    box,
    reviews: Number.isFinite(Number(w.reviews)) ? Math.max(0, Math.round(Number(w.reviews))) : 0,
    dueAt: str(w.dueAt) || new Date().toISOString(),
    lastReviewedAt: str(w.lastReviewedAt) || null,
  };
}

export const dedupeKey = (word, target) =>
  `${clip(word, 80).toLowerCase()}|${clip(target, 40).toLowerCase()}`;

export function normalizeList(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map(normalizeWord).filter(Boolean).slice(0, VOCAB_LIMIT);
}

export async function listWords() {
  const got = await chrome.storage.local.get(VOCAB_KEY);
  return normalizeList(got[VOCAB_KEY]);
}

async function writeList(list) {
  const normalized = normalizeList(list);
  await chrome.storage.local.set({ [VOCAB_KEY]: normalized });
  return normalized;
}

/**
 * Save a word. Duplicates (same word + same target language) update the
 * existing entry instead of creating a second row.
 */
export async function saveWord(raw) {
  const entry = normalizeWord(raw);
  if (!entry) return { ok: false, error: 'NEEDS_WORD' };

  const list = await listWords();
  const key = dedupeKey(entry.word, entry.target);
  const existingIndex = list.findIndex((e) => dedupeKey(e.word, e.target) === key);

  if (existingIndex !== -1) {
    const existing = list[existingIndex];
    const merged = {
      ...existing,
      translation: entry.translation || existing.translation,
      context: entry.context || existing.context,
      source: entry.source || existing.source,
      sourceCode: entry.sourceCode || existing.sourceCode,
      targetCode: entry.targetCode || existing.targetCode,
    };
    list[existingIndex] = merged;
    const next = await writeList(list);
    return { ok: true, duplicate: false, updated: true, entry: merged, total: next.length };
  }

  list.unshift(entry);
  // Keep the newest words; the oldest fall off rather than blocking saves.
  const next = await writeList(list.slice(0, VOCAB_LIMIT));
  return { ok: true, duplicate: false, updated: false, entry, total: next.length };
}

export async function deleteWord(id) {
  const list = await listWords();
  const next = await writeList(list.filter((e) => e.id !== id));
  return { ok: true, total: next.length };
}

export async function clearWords() {
  await chrome.storage.local.set({ [VOCAB_KEY]: [] });
  return { ok: true, total: 0 };
}

/** Feed a review answer back into the schedule. */
export function gradeWord(entry, grade) {
  const box = entry.box ?? 0;
  let nextBox = box;
  if (grade === 'again') nextBox = 0;
  else if (grade === 'good') nextBox = Math.min(MAX_BOX, box + 1);
  else if (grade === 'easy') nextBox = Math.min(MAX_BOX, box + 2);
  return {
    ...entry,
    box: nextBox,
    reviews: (entry.reviews || 0) + 1,
    lastReviewedAt: new Date().toISOString(),
    dueAt: new Date(Date.now() + INTERVALS[nextBox] * DAY).toISOString(),
  };
}

export async function reviewWord(id, grade) {
  const list = await listWords();
  const index = list.findIndex((e) => e.id === id);
  if (index === -1) return { ok: false, error: 'NOT_FOUND' };
  list[index] = gradeWord(list[index], grade);
  const next = await writeList(list);
  return { ok: true, entry: list[index], total: next.length };
}

// ── derived views ──────────────────────────────────────────────────────────

export const isDue = (entry, now = Date.now()) => {
  const at = Date.parse(entry.dueAt);
  return !Number.isFinite(at) || at <= now;
};

export function dueWords(list, now = Date.now()) {
  return list.filter((e) => isDue(e, now)).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}

export function statsOf(list) {
  const due = list.filter((e) => isDue(e)).length;
  const fresh = list.filter((e) => (e.reviews || 0) === 0).length;
  const learning = list.filter((e) => (e.reviews || 0) > 0 && (e.box ?? 0) < 3).length;
  const known = list.filter((e) => (e.box ?? 0) >= 3).length;
  return { total: list.length, due, fresh, learning, known };
}

// ── export ─────────────────────────────────────────────────────────────────

const csvCell = (value) => {
  const v = String(value ?? '');
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

export function toCsv(list) {
  const head = ['word', 'translation', 'source', 'target', 'context', 'host', 'created_at', 'box', 'reviews'];
  const rows = list.map((e) => [
    e.word, e.translation, e.source, e.target, e.context, e.host, e.createdAt, e.box, e.reviews,
  ].map(csvCell).join(','));
  return [head.join(','), ...rows].join('\r\n');
}

/** Tab-separated, ready for Anki's "Text separated by tabs" import. */
export function toAnkiTsv(list) {
  const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  return list.map((e) => [clean(e.word), clean(e.translation), clean(e.context)].join('\t')).join('\n');
}

export function toJson(list) {
  return JSON.stringify(list, null, 2);
}
