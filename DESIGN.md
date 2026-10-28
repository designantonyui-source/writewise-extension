# WriteWise design system

Surface mode: **Operate**. The user is mid-sentence; the interface gets about
two seconds of attention. Restraint is the feature. Personality lives in the ✳
mark, the warm neutrals, and the diff typography — nowhere else.

## Tokens

`shared/tokens.css` is the single source. Never hardcode a colour, radius,
duration or font in a component file.

| Token | Meaning |
|---|---|
| `--ww-accent` / `--ww-accent-hi` | ✳ mark and focus accents / filled buttons (white text ≥ 4.5:1) |
| `--ww-jade` / `--ww-danger` | insertions / deletions |
| `--ww-bg`, `--ww-surface`, `--ww-surface-2`, `--ww-surface-3` | depth ladder |
| `--ww-border`, `--ww-border-2` | hairlines |
| `--ww-tx`, `--ww-tx-2`, `--ww-tx-3` | primary, secondary, tertiary text |
| `--ww-fs-10 … --ww-fs-18` | type scale (10/11/12/13/15/18) |
| `--ww-1 … --ww-6` | 4/8/12/16/20/24 spacing |
| `--ww-r-sm`, `--ww-r`, `--ww-r-lg`, `--ww-r-pill` | 8/12/16/999 |
| `--ww-control-h`, `--ww-touch-h` | 32px controls, 36px touch target |
| `--ww-shadow`, `--ww-shadow-sm` | only two depths exist |
| `--ww-ease`, `--ww-dur`, `--ww-dur-slow` | 140ms / 200ms, one easing curve |

Dark is the default. Light follows `prefers-color-scheme` or an explicit
`[data-theme]` on `:root` (extension pages) / `.ww-tokens` (shadow card).

## Type

System UI stack. No webfonts — a popup that waits on a font download is a popup
that feels broken. Hierarchy comes from size, weight, and colour, in that order.
Sentence case everywhere. Tertiary text is for metadata only, never for
instructions.

## Components

- **Switch** — 36×20, real `<input type="checkbox">` + styled track. React to
  `change` only. Never re-toggle `.checked` in a click handler; that is the bug
  that broke v1.
- **Segmented control** — 2–3 equal segments, 32px tall, selected segment gets
  `--ww-surface-2` + 1px border, never a fill of the accent.
- **Key row** — password input + `Test` button + status dot (jade = connected,
  danger = rejected, muted = untested).
- **Fix row** — icon-less label + switch. No emoji, no decorative glyphs.
- **Pills** — tone presets, 24px, muted until active.
- **Card** — 380px, 12px padding, 14px radius, one shadow, hairline border.
- **Diff** — inline `<ins>` jade with underline, `<del>` danger with strike.
  Never colour alone: the underline/strike carries the meaning too.

## Motion

One entrance (180ms, opacity + 4px rise). Everything else 140ms. Nothing loops,
nothing spins forever, no springy overshoot. `prefers-reduced-motion: reduce`
removes the entrance and the spinner rotation.

## Copy

- Say what happened and what to do: “Key rejected — check it in settings.”
- No exclamation marks, no “Oops!”, no “AI magic”.
- The card speaks in the product's voice, not the model's.
- Numbers are specific: “8 changes · 1.1 s”, not “some changes”.

## Accessibility floor

- Text contrast ≥ 4.5:1 in both themes; interactive targets ≥ 32px (36px in the
  popup where rows are roomy).
- `:focus-visible` 2px `--ww-focus` with 2px offset on every control.
- The card is `role="dialog"` (suggestion/applied) or `role="status"` with
  `aria-live` (checking/clean); errors are `role="alert"`.
- Keyboard: `Esc` dismisses, `Enter` applies only when the card has focus.
  Tab is never intercepted.
- Focus: one warm ring (`--ww-focus`, accent-derived, 2px + 2px offset) on
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
  keeps a fixed height so revealing does not jump the layout.
- **Empty states** are copy, not illustration: what happened, and the one action
  that fixes it.
- Destructive actions confirm inline (`Clear all? Cancel / Clear`), never with
  `window.confirm`.

## Icons

`icons/icon.svg` is the source; `icon16/48/128.png` are rendered from it at each
size with a size-dependent stroke so the mark survives a 16px toolbar slot:
accent tile, white eight-ray mark, rounded caps.
