// Exercises src/vocab.js in Node with a chrome.storage stub.
import {
  normalizeWord, normalizeList, saveWord, listWords, deleteWord, clearWords,
  reviewWord, gradeWord, dueWords, isDue, statsOf, toCsv, toAnkiTsv, toJson,
  VOCAB_KEY, VOCAB_LIMIT, INTERVALS, MAX_BOX,
} from '../src/vocab.js';

let failures = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  if (!cond) failures++;
};

const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (keys == null) return { ...store };
        if (typeof keys === 'string') return { [keys]: store[keys] };
        return Object.fromEntries(Object.keys(keys).map((k) => [k, store[k] === undefined ? keys[k] : store[k]]));
      },
      set: async (obj) => { Object.assign(store, obj); },
    },
    onChanged: { addListener() {}, removeListener() {} },
  },
};

// normalize
ok('normalize: rejects empty', normalizeWord({ word: '', translation: 'x' }) === null);
ok('normalize: rejects missing translation', normalizeWord({ word: 'hi' }) === null);
const n = normalizeWord({ word: '  sentance  ', translation: 'zdanie', box: 9, reviews: -2, context: 'a '.repeat(300) });
ok('normalize: trims word', n.word === 'sentance');
ok('normalize: clamps box', n.box === MAX_BOX, n.box);
ok('normalize: clamps reviews', n.reviews === 0);
ok('normalize: clips context', n.context.length <= 280, n.context.length);
ok('normalize: assigns id', typeof n.id === 'string' && n.id.length > 3);
ok('normalize: default due now', isDue(n) === true);

// save
await clearWords();
const a = await saveWord({ word: 'leverage', translation: 'dźwignia', source: 'English', target: 'Polski (pl)', context: 'We can leverage this.', host: 'example.com' });
ok('save: first word', a.ok && a.total === 1 && a.duplicate === false, a.total);
const b = await saveWord({ word: 'LEVERAGE', translation: 'dźwignia', source: 'English', target: 'Polski (pl)' });
ok('save: case-insensitive dedupe', b.total === 1 && b.updated === true, b);
const c = await saveWord({ word: 'leverage', translation: 'dźwignia', source: 'English', target: 'Deutsch (de)' });
ok('save: different target is a new word', c.total === 2, c.total);
const d = await saveWord({ word: 'resilience', translation: 'odporność', target: 'Polski (pl)' });
ok('save: newest first', (await listWords())[0].word === 'resilience');
ok('save: context kept', (await listWords()).find((e) => e.word === 'leverage' && e.target === 'Polski (pl)').context === 'We can leverage this.');

// delete
const list1 = await listWords();
const del = await deleteWord(list1[0].id);
ok('delete: removes one', del.ok && del.total === list1.length - 1, del.total);

// grading
const base = { box: 0, reviews: 0, dueAt: new Date(0).toISOString() };
const again = gradeWord(base, 'again');
const good = gradeWord(base, 'good');
const easy = gradeWord(base, 'easy');
ok('grade: again stays box 0', again.box === 0);
ok('grade: good moves to box 1', good.box === 1, good.box);
ok('grade: easy moves to box 2', easy.box === 2, easy.box);
ok('grade: intervals respected', Date.parse(good.dueAt) - Date.now() > INTERVALS[1] * 86400000 - 5000, 'due in ~2d');
ok('grade: reviews increments', good.reviews === 1);
const maxed = gradeWord({ box: MAX_BOX }, 'easy');
ok('grade: box capped', maxed.box === MAX_BOX, maxed.box);

// reviewWord persists
const target = (await listWords())[0];
const rev = await reviewWord(target.id, 'good');
ok('review: returns entry', rev.ok && rev.entry.box === 1, rev.entry?.box);
ok('review: persisted', (await listWords()).find((e) => e.id === target.id).box === 1);
ok('review: unknown id', (await reviewWord('nope', 'good')).ok === false);

// stats + due
store[VOCAB_KEY] = [
  { id: '1', word: 'a', translation: 'b', box: 0, reviews: 0, dueAt: new Date(0).toISOString() },
  { id: '2', word: 'c', translation: 'd', box: 1, reviews: 2, dueAt: new Date(Date.now() + 86400000 * 3).toISOString() },
  { id: '3', word: 'e', translation: 'f', box: 4, reviews: 9, dueAt: new Date(0).toISOString() },
];
const st = statsOf(await listWords());
ok('stats: totals', st.total === 3, st);
ok('stats: due count', st.due === 2, st.due);
ok('stats: fresh/learning/known', st.fresh === 1 && st.learning === 1 && st.known === 1, st);
ok('dueWords sorts', dueWords(await listWords()).length === 2);

// exports
const rows = await listWords();
const csv = toCsv(rows);
ok('csv: header', csv.split('\r\n')[0].startsWith('word,translation'));
const tricky = toCsv([{ ...rows[0], context: 'He said "hi", then left' }]);
ok('csv: quotes escaped', /"He said ""hi"", then left"/.test(tricky), tricky.split('\r\n')[1]);
const tsv = toAnkiTsv([{ ...rows[0], word: 'a\tb', context: 'x\ny' }]);
ok('anki: tabs and newlines stripped', !/\t\t|\n.*\n/.test(tsv) && tsv.split('\t').length === 3, tsv);
ok('json export', JSON.parse(toJson(rows)).length === rows.length);

// limit
store[VOCAB_KEY] = Array.from({ length: VOCAB_LIMIT }, (_, i) => ({
  id: `x${i}`, word: `w${i}`, translation: `t${i}`, dueAt: new Date(0).toISOString(),
}));
const full = await saveWord({ word: 'newest', translation: 'najnowszy' });
ok('limit: stays at cap', full.total === VOCAB_LIMIT, full.total);
ok('limit: keeps newest', (await listWords())[0].word === 'newest');

// clear
ok('clear: empties', (await clearWords()).total === 0 && (await listWords()).length === 0);

console.log(failures === 0 ? '\nALL VOCAB TESTS PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
