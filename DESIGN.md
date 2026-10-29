# WriteWise design system

Surface mode: **Operate**. The user is mid-sentence; the interface gets about
two seconds of attention. Restraint is the feature. Personality lives in the ✳
mark, the neutral greys, and the diff typography — nowhere else.

## Tokens

`shared/tokens.css` is the single source. Never hardcode a colour, radius,
duration or font in a component file.

| Token | Meaning |
|---|---|
| `--ww-accent` | the brand orchid, `#d6adf2`; dots, slider fill, progress. On white it steps to `#a878d4` so graphics keep 3.3:1 |
| `--ww-accent-hi` / `--ww-accent-ink` | accent **surfaces** (filled buttons, switch tracks) and the label that goes on them. `#d6adf2` is a light surface: ink is 9.2:1, while white would be 1.9:1 — the label is the dark one here |
| `--ww-accent-text` | accent used *as text*: `#d6adf2` on the dark ground (9.8:1), `#8448b0` on white (5.9:1) |
| `--ww-brand` | the ✳ mark only: the accent's *graphic* tone for the ground — `#d6adf2` on dark, `#a878d4` on white — never the darkened tone text has to use |
| `--ww-accent-soft` | 16–22% tint for selected pills, hint chips, hover washes |
| `--ww-jade` / `--ww-danger` | insertions / deletions |
| `--ww-bg`, `--ww-surface`, `--ww-surface-2`, `--ww-surface-3` | depth ladder |
| `--ww-border`, `--ww-border-2` | hairlines |
| `--ww-tx`, `--ww-tx-2`, `--ww-tx-3` | primary, secondary, tertiary text |
| `--ww-fs-10 … --ww-fs-18` | type scale (10/11/12/13/15/18) |
| `--ww-1 … --ww-6` | 4/8/12/16/20/24 spacing |
| `--ww-r-xs`, `--ww-r-sm`, `--ww-r`, `--ww-r-lg`, `--ww-r-xl`, `--ww-r-pill` | 6/10/14/20/24/999 — chips, glyph buttons, fields, containers, the card, capsules |
| `--ww-corner` | `squircle`: continuous corners on every rounded surface. Chrome 139+ draws them; older engines drop the declaration and keep the circular arc |
| `--ww-control-h`, `--ww-touch-h` | 32px controls, 36px touch target |
| `--ww-shadow` | the single depth: the floating card. Controls are flat |
| `--ww-ease`, `--ww-dur`, `--ww-dur-slow` | 140ms / 200ms, one easing curve |

Dark is the default. Light follows `prefers-color-scheme` or an explicit
`[data-theme]` on `:root` (extension pages) / `.ww-tokens` (shadow card).

The accent is deliberately allowed to change *role* rather than get muddied:
`#d6adf2` is unchanged where it is a surface, ink is used where a label sits on
it (a light fill cannot carry white), and the accent steps down only when it is
a graphic or text on white. Every pair below is asserted in
`_wwtest/contrast.test.mjs`, so a future palette tweak cannot quietly break AA.

The greys are neutral, not warm. A warm-grey ground plus a warm accent reads as
someone else's brand; neutral surfaces let the orchid be the only colour in the
room. Depth is equally disciplined: only the floating card has a shadow. Buttons,
switches, segmented tiles and slider thumbs are flat — a control that floats
reads as a different material from the field it sits in.

Shape carries the same discipline. Three tiers, and nothing in between: glyph
buttons are **discs**, actions are **capsules**, and containers keep a visible
corner (20px lists and callouts, 24px for the card and the review card). Fields
sit at 14px so they read as controls rather than containers. Corners are drawn
with `corner-shape: squircle` — the continuous curve starts earlier and meets
the edge without a tangent break, which is what the eye reads as "iOS" rather
than "rounded rectangle". It is set through the `--ww-corner` token so an engine
without `corner-shape` simply ignores the declaration and keeps the circular
arc; every radius is chosen to read well both ways. Inside the card there are no
rules at all — not around it, not between its body and its footer; separation
comes from spacing and from the shadow, and the hairlines that remain live in
the popup and the vocabulary page, where they separate rows rather than parts
of one object.

## Type

System UI stack. No webfonts — a popup that waits on a font download is a popup
that feels broken. Hierarchy comes from size, weight, and colour, in that order.
Sentence case everywhere. Tertiary text is for metadata only, never for
instructions.

## Components

- **Switch** — 36×20 capsule track, real `<input type="checkbox">` + styled track. React to
  `change` only. Never re-toggle `.checked` in a click handler; that is the bug
  that broke v1. Flat, no shadow; the thumb is ink on the accent track. The off track is neutral with a muted knob; the on track is
  the accent with an ink knob (`--ww-switch-thumb`), because the accent is
  brighter than a white knob can survive on.
- **Segmented control** — 2–3 equal segments, 32px tall, selected segment gets
  `--ww-surface-2` + 1px border, never a fill of the accent.
- **Key row** — password input + `Test` button + status dot (jade = connected,
  danger = rejected, muted = untested).
- **Fix row** — icon-less label + switch. No emoji, no decorative glyphs.
- **Pills** — tone presets, 24px capsules, muted until active.
- **Card** — 380px, 14px padding, 24px continuous corners, one shadow, no
  border: the edge is the shadow, not a line.
  The header is a 20px row: 16px mark, title, then a 24px close button pulled
  in 4px vertically and 6px horizontally so the glyph aligns with the padding
  while the hit area stays 24px. Head to body is 12px. The body is one
  dictionary row — `original → translation`, both words 15px/1.45 on the same
  baseline (the original muted at 400, the answer at 500, capped at 18ch with an
  ellipsis), the original followed by its 20px speaker centred on the line — and
  the language pair lives in the footer meta (`English → Polski`): the card reads
  in names, the model prompt keeps the `(pl)` code, speech uses the code.
  Stacking the original, the translation and a "from English" caption cost three
  lines and ~45px of height for three short strings; the row says the same thing
  in one, and the speaker stays attached to the word it reads. Only the original
  is spoken: a translation is text to copy or to write, not audio to hear.
- **Card footer** — no rule above it: the 14px gap does the separating, and a
  hairline through the quietest part of the card was the last piece of
  furniture in it. One labelled action per state (Apply, Replace, Undo, Add
  key). Secondary verbs are glyph buttons: copy and save-word sit on the same
  30px line as a 30px disc holding a 13px glyph, because the word "Copy" is not
  the thing the action produces and a light pill with dark text in it was the
  loudest object in a quiet card. They carry `aria-label` + `title` and a
  visually hidden name, so keyboard and screen-reader paths are unchanged; copy
  swaps its glyph for a jade tick, and the labelled primary keeps its label so
  the row still has a clear first action.
- **Diff** — inline `<ins>` jade with underline, `<del>` danger with strike.
  Never colour alone: the underline/strike carries the meaning too. A
  replacement is two chips in one slot, so `ins + del` and `del + ins` get 3px
  between them; without it "Please" and "pls" collide and read as one word.
- **Speaker** — a quiet glyph at ~`--ww-tx-3` (50–65% opacity in the wordier
  vocabulary rows), resolving to accent-on-accent-soft on hover and while
  playing. Two engines sit behind it and the caller never chooses: the OS voice
  (free, offline, quality varies by platform) and an optional neural voice
  fetched by the service worker (OpenAI audio/speech, Web Audio playback,
  cached per word). The OS voice is ranked by quality, not availability —
  premium/neural/enhanced/Siri/Google/Microsoft names beat “compact”, exact
  locale beats same language, novelty voices are excluded. Which engine runs is
  decided per language: the neural voices are English-trained, so a non-English
  language the machine can already speak natively is read natively, and the
  neural voice — told which language it is reading — covers English and the
  languages the machine cannot speak. A language with no voice anywhere is
  reported in the card rather than read with the wrong one, which is the only
  case where the button stays silent. It is a glyph button, not a labelled
  button: the word it belongs to is the label, and `aria-label` spells the word
  out for screen readers. It sits on the line it reads — in the card, after the
  original; in the vocabulary list, beside the saved word — so it never has to
  guess which of the two strings you meant, because only one of them is spoken.

## Motion

One entrance (180ms, opacity + 4px rise). Everything else 140ms. Nothing loops,
nothing spins forever, no springy overshoot — with one deliberate exception: the
speaker pulses at 1.1s while audio is playing, because that is the only signal
that sound is coming from this button. `prefers-reduced-motion: reduce` removes
the entrance, the spinner rotation and the pulse.

## Selection

- Context decides the default: **writing in an editable field gets corrected;
  selecting page content gets translated.** Selecting text in an editor checks
  that fragment when automatic checks are on. Selecting page text translates
  it (the service worker stops at 2 400 characters and says so).
- The context menu keeps explicit paths: "Fix selection" checks the selected
  writing, and "Translate selection" also works inside an editable field.

## Copy

- Say what happened and what to do: “Key rejected — check it in settings.”
- No exclamation marks, no “Oops!”, no “AI magic”.
- The card speaks in the product's voice, not the model's.
- Numbers are specific: “8 changes”, not “some changes”. Latency is not a
  number the user asked for — the card reports what it found, not how fast.

## Accessibility floor

- Text contrast ≥ 4.5:1 in both themes; interactive targets ≥ 32px (36px in the
  popup where rows are roomy).
- `:focus-visible` 2px `--ww-focus` with 2px offset on every control.
- The card is `role="dialog"` (suggestion/applied) or `role="status"` with
  `aria-live` (checking/clean); errors are `role="alert"`.
- Keyboard: `Esc` dismisses, `Enter` applies only when the card has focus.
  Tab is never intercepted.
- Any press outside the card dismisses it (and cancels the request behind it),
  so the close button is a convenience, not a requirement.
- Focus: one ring (`--ww-focus`, accent-derived, 2px + 2px offset) on
  everything. No blue focus state anywhere — it read as a different product.

## Vocabulary page

The widest surface, and the one that has to feel like software rather than a
settings pane. 1100px max content, centered, hairline-topped header bar with
the mark and wordmark.

- **Rows** are `article[tabindex]` with `aria-expanded` (not `role="button"` —
  each row contains a delete button, and nesting interactive roles is invalid).
  Word 15px/600, translation 13px, context 12px muted on a second line,
  source→target and host right-aligned at 11px, due pill, quiet delete icon at
  50% that resolves to full on hover or focus.
- **Toolbar** is one row: search, All/Due segmented, Review on the right.
  Exports are text buttons, not buttons-with-icons: they are rare, secondary
  actions and shouldn't compete with Review.
- **Review** is focus mode: centered 560px column, progress line, one card,
  word at 32px, reveal, then grade buttons with `kbd` chips (1/2/3). The card
  keeps a fixed height so revealing does not jump the layout. The word carries a
  speaker in its own language and `P` plays it — hearing the word is part of
  learning it, not a separate screen. The translation is not spoken.
- **Empty states** are copy, not illustration: what happened, and the one action
  that fixes it.
- Destructive actions confirm inline (`Clear all? Cancel / Clear`), never with
  `window.confirm`.

## Icons

`icons/icon.svg` is the source; `icon16/48/128.png` are rendered from it at each
size with a size-dependent stroke so the mark survives a 16px toolbar slot:
accent tile, ink eight-ray mark, rounded caps. Ink on accent is the same rule as
the buttons — the only white-on-accent left in the product would fail contrast.

Functional icons — search, close, chevrons, trash, volume, plus — are
[Hugeicons](https://hugeicons.com/icons/stroke-rounded) stroke-rounded glyphs
(MIT, see `LICENSES.md`), inlined as SVG on their native 24×24 grid and shown at
10–18px. They carry `vector-effect="non-scaling-stroke"` with a 1.4px stroke, so
the weight stays even whether the glyph sits in a 24px icon button or next to
11px metadata. The ✳ mark is ours and is never replaced by a stock glyph.

The card header carries no provider badge: the provider is chosen once in the
popup, and repeating its name on every card was decoration that competed with
the title.
