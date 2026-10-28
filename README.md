# WriteWise

A quiet proofreader for any text field on the web. It waits for you to pause,
shows what it would change, and applies it in one click — or one key. It also
translates — double-click a word or select a passage — and keeps a local
vocabulary of the words you want to remember.

Two providers, one key each: **DeepSeek** (default) or **OpenAI**.

![Popup, dark](docs/popup-dark.png)

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select this folder
4. Pin the ✳ icon to the toolbar

No build step, no `npm install`, no bundler. Edit a file, hit reload on
`chrome://extensions`.

## Setup

1. Click the ✳ icon
2. Pick **DeepSeek** or **OpenAI**
3. Paste a key and press **Test** — you get a green dot and the model list
   that key can actually see
4. Done. Keys are stored on this device only (`chrome.storage.local`).

Get a key: [platform.deepseek.com](https://platform.deepseek.com/api_keys) ·
[platform.openai.com](https://platform.openai.com/api-keys)

## How it works

- You type in any `input`, `textarea` or `contenteditable` field.
- After you stop for ~0.9 s, WriteWise sends the text to your provider and shows
  a card with an inline diff below the field.
- **Apply** replaces the text in place. **Dismiss** leaves it alone.
  `Undo` after applying restores the original.
- The field's own undo stack still works: textareas and inputs get a native
  value write + `input` event, contenteditable gets `execCommand('insertText')`.

Keyboard: `Enter` applies when the card is focused · `Esc` dismisses ·
`⌥⇧W` (Alt+Shift+W) checks the focused field on demand · right-click a text
selection → **Fix selection** checks only that fragment.

## Translate

- **Double-click a word** and it translates into your target language.
- **Select a passage** (up to ~240 characters) and it translates when you let go
  of the mouse.
- For anything longer, right-click → **Translate selection** (up to 2,400
  characters).
- The card shows the translation, the detected source language, and gives you
  **Copy** — or **Replace**, when the text came from a field you were editing.

![Translate card](docs/card-translate.png)

Pick the target language and switch translation on or off in the popup's
**Translate** row; turn off *Translate when I select text* under **Advanced** if
you only want double-click to translate.

## Saved words

When a translation is a single word, the card offers **Save** — it stores the
word, its translation, the sentence you found it in, and the site. Saving is
free: no API call, and nothing leaves the device.

Open the list from the popup footer (**N saved words**) for a full page with:

- search across words, translations and contexts;
- *All* / *Due today* filters and a live count;
- rows that expand to show the context, when it was added, review history and
  progress;
- **Review** — a spaced-repetition session over the due queue. Reveal with
  `Space`, grade with `1` (again) / `2` (good) / `3` (easy), `Esc` to leave.
  Intervals run 1 → 2 → 4 → 8 → 16 days;
- **Add word** for words you meet away from the browser;
- **Export CSV**, **Export Anki** (tab-separated, import straight into Anki) and
  **Export JSON**.

![Saved words](docs/vocab-dark.png)

The vault holds up to 2,000 words in `chrome.storage.local`; saving the same
word again updates its translation instead of duplicating it.

## Settings

| Setting | Meaning |
|---|---|
| Master switch | Pause everything |
| Provider + key + model | DeepSeek Flash / V4 Pro, GPT-6 Luna / 6.1 Terra / 5.4 nano |
| Check automatically | Off = only the shortcut and the context menu check |
| Wait after typing | 0.4 s – 3 s pause before a check |
| Spelling / Grammar / Clarity / Tone | What the model is allowed to touch |
| Tone preset | Professional, Casual, Formal, Friendly |
| Translate | Target language + on/off (double-click a word, or select text) |
| Saved words | Footer link to the vocabulary page, with a live count |
| On this site | Pause the current hostname |
| Advanced | Minimum characters, maximum words, tone presets, translate-on-select |

The popup also shows fixes today and an estimated spend.

## Privacy

- There is no WriteWise server. Text goes only to the provider you picked.
- Keys live in `chrome.storage.local` — not `storage.sync`, so they are not
  copied to your Google account.
- No telemetry, no analytics, no accounts.
- Password, payment (`autocomplete=cc-*`) and one-time-code fields are never
  read.
- Translation sends only the selected fragment, and only when you trigger it
  (double-click, or selecting text while that setting is on).
- Saved words never leave the device. The CSV/Anki/JSON exports are the only
  way out, and you run them yourself.

## Cost

A typical 500-word check is ~600 input + ~700 output tokens.

| Model | In / out per 1M | ≈ per check |
|---|---|---|
| `deepseek-flash` | $0.15–0.30 / $0.60–1.20 | ~$0.0005 |
| `gpt-6-luna` | $0.10 / $0.50 | ~$0.0004 |
| `gpt-6.1-terra` | $1.00 / $5.00 | ~$0.004 |

That is roughly **$0.40–0.50 per 1,000 checks** on the fast models.

## Limits

- Canvas editors (Google Docs, Figma) expose no editable DOM — out of scope.
- Fields inside iframes are not watched (content script runs in the top frame).
- Applying to a `contenteditable` replaces its content with plain text; the
  text is corrected, richer formatting inside it is not preserved.
- Very long fields are skipped above the word limit instead of being truncated.
- If a model answer is cut off (`finish_reason: length`) it is discarded rather
  than partially applied.

## Project layout

```
manifest.json          MV3, two API hosts, no broad host permissions
background.js          message router, API calls, stats, context menu
src/providers.js       one OpenAI-compatible client + error taxonomy
src/languages.js       translation targets + browser-language fallback
icons/                 generated from icon.svg (16/48/128)
src/prompt.js          the guardrail prompt and JSON envelope
src/storage.js         settings/stats shape, defaults, v1 key cleanup
vocab/                 saved words: list, search, add, exports, review
src/vocab.js           word entries, Leitner schedule, export encoders
content/ui.js|css      in-page card (shadow DOM, seven states)
content/content.js     debounce, field adapters, apply/undo, guards
popup/                 settings surface (360 px, dark + light)
shared/tokens.css      design tokens — the only source of colour/type/space
PRODUCT.md, DESIGN.md  why it exists, how it should look
```

## Tests

```bash
# unit: provider client + settings (plain node, stubbed fetch/chrome)
node _wwtest/provider.test.mjs
node _wwtest/storage.test.mjs

# end-to-end: real Chrome, real extension, mocked provider responses
_wwtest/run-all.sh
```

The e2e harness loads the unpacked extension in headless Chrome over CDP,
intercepts provider calls in the service worker, and drives the UI with real
mouse/keyboard events: auto-check debounce, request shape, apply/undo on all
three field types, error persistence, shadow-DOM isolation against hostile CSS,
per-site pause, word-limit guard, shortcut and selection paths.

## Differences from v2.1

- Saved words: a local vocabulary with spaced repetition, search, and exports.
- Professional pass: regenerated icon set, warm focus rings, tighter type and
  spacing, vocabulary page with keyboard-first review.

## Differences from v1.1

- Translation added: double-click / select / right-click, with a target language.

## Differences from v1

- Claude / Gemini / Groq removed; DeepSeek + OpenAI only.
- Checks now actually run as you type (v1 only checked on a manual click).
- The "What to fix" switches work (v1's label handler cancelled its own toggle).
- In-page UI lives in a shadow root instead of global CSS.
- Errors persist instead of flashing for 200 ms.
- Keys moved out of cloud-synced storage; the v1 keys are deleted on upgrade.
