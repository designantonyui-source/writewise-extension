# Changelog

All notable changes to WriteWise. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-10-29

Public versioning restarts at 1.0.0. The earlier `v2.10.1` GitHub release
remains an archive; this build includes the changes through source version
2.11.0.

- Improve spelling, grammar, clarity and tone while typing, with a reviewable
  diff before applying a correction.
- Translate selected text with DeepSeek or OpenAI, and save words with context
  for local spaced-repetition review.
- Use the in-page card, settings and saved-word page in light or dark theme.
- Keep API keys in local extension storage; no WriteWise account or server.

## [2.11.0] — 2026-10-29

### Removed
- Playback of the translation. The card's dictionary row keeps one speaker, on
  the original; the translation line is text to copy or to replace. The
  saved-words list and the review card follow the same rule: the word is
  spoken, the translation is not.
- Settings → Pronunciation no longer predicts a voice for the target language,
  because nothing reads that language any more.

## [2.10.2] — 2026-10-29

### Fixed
- The translation's speaker could read another language with an English voice.
  Two causes, both closed:
  - with the neural voice on, Ukrainian and Polish went to the OpenAI voice
    with no language instruction, so they came back with an English accent;
  - with the neural voice off and no system voice for the language, the OS
    borrowed its default (English) voice.
- The neural voice is now told which language it is reading (`Read this
  Ukrainian text aloud…`), and it stays on the cached path per voice+language.
- For any language that is not English, an installed native voice wins over the
  neural one: good accent beats good timbre. The neural voice is used for
  English and for languages the machine cannot speak.
- A language with no voice at all is reported instead of guessed — the card says
  so and offers the neural voice.
- Language names reaching the speech engine (`Українська`, `Polski (pl)`) are
  mapped to real locales instead of being passed through as an invalid `lang`,
  which was a third way to end up on the default voice.

### Added
- The card offers **Use neural voice** when the OS has no voice for the
  language: one click turns the neural voice on (with an OpenAI key) and reads
  the line again. Without a key it opens settings.
- Settings → Pronunciation reports what this computer can pronounce for the
  chosen target language, and what to turn on when it cannot.
- The saved-words page says the same thing, once, instead of staying silent.

## [2.10.1] — 2026-10-29

### Changed
- Two gestures, two verbs: typing is corrected, selecting is translated — a
  word, a sentence or a paragraph. Selection translation no longer has length
  heuristics; the service worker's 2 400-character ceiling is the only limit.
- Four target languages only: English, Polski, Українська, Русский.

## [2.10.0] — 2026-10-29

### Changed
- Auto-translate limited to short selections; longer selections were checked
  instead. *(Reverted in 2.10.1 — the simpler rule won.)*

## [2.9.0] — 2026-10-29

### Fixed
- An OpenAI key appeared broken: every build shipped placeholder model ids
  (`gpt-6-luna`, `deepseek-flash`, …) that no key has, so the first request
  returned 404. Real defaults are now `gpt-4o-mini` and `deepseek-chat`.

### Added
- The popup asks the provider for the models the key can use, keeps chat models
  only, and heals a saved selection that is not on that list.
- "Model unavailable" is actionable from the card: **Change model** opens
  settings, in both the fix and the translate flows.

## [2.8.4] — 2026-10-29

### Changed
- The card and the saved-word list read languages by name (`English → Polski`),
  not by code. Machine concerns (prompt, speech) keep the code.

## [2.8.3] — 2026-10-29

### Changed
- The card stopped reporting latency: `2 changes`, not `2 changes · 1.1 s`. The
  live clock in the checking state remains — it is a waiting signal.

## [2.8.2] — 2026-10-29

### Fixed
- The dictionary row is aligned to the pixel: both words 15px on one baseline,
  the arrow and both speakers centred on that line.

## [2.8.1] — 2026-10-29

### Changed
- The translation card is one dictionary row — `original → translation` — and
  the language pair moved into the footer meta. Roughly 45px shorter.

## [2.8.0] — 2026-10-29

### Added
- Neural pronunciation, opt-in, through the OpenAI key: six voices, cached per
  word, played with Web Audio, falling back to the OS voice on any failure.
- The OS voice picker ranks premium/neural/enhanced voices above compact ones
  and drops novelty voices.

## [2.7.1] — 2026-10-29

### Added
- The original and the translation each have their own speaker, in the language
  they belong to.

## [2.7.0] — 2026-10-29

### Changed
- Orchid accent `#d6adf2`: fills carry an ink label (white would be 1.9:1);
  graphics and text step down on white; the ✳ mark rides the graphic tone.

## [2.6.2] — 2026-10-29

### Changed
- The card footer lost its rule; the card is one uninterrupted surface.

## [2.6.1] — 2026-10-29

### Changed
- Copy and Save are glyph buttons; the primary action is the only labelled
  button in the footer.

## [2.6.0] — 2026-10-29

### Changed
- Continuous corners (`corner-shape: squircle`), capsules for actions, discs for
  glyph buttons, 24px card: a coherent iOS-style shape system.
- The card lost its hairline border; the shadow is the edge.

## [2.5.2] — 2026-10-28

### Changed
- Card rhythm: 14px padding, one 24px icon cluster, 12px head-to-body, 15px
  answer type, replacements with 3px between their chips.

## [2.5.1] — 2026-10-28

### Changed
- The ✳ mark keeps the button gold in both themes.

## [2.5.0] — 2026-10-28

### Changed
- Gold `#ffaf01` accent over neutral greys; flat controls; one depth (the card).

## [2.4.1] — 2026-10-28

### Changed
- Hugeicons stroke-rounded icons across the product; provider badge removed.

## [2.4.0] — 2026-10-28

### Changed
- Accent `#ff8204`.

## [2.3.1] — 2026-10-28

### Removed
- The redundant Dismiss button in card footers (Esc, ✕ and click-outside remain).

## [2.3.0] — 2026-10-28

### Added
- Saved words with spaced repetition, search and CSV/Anki/JSON export.
- Pronunciation in the card, vocabulary list and review, with `P` in review.
- Language pairs stored as codes, so a word can be played in the right language.

## [2.2.1] — 2026-10-28

### Changed
- Outside-press dismisses the card; no need to aim at the ✕.

## [2.2.0] — 2026-10-28

### Added
- Translation on double-click and selection, with a target language setting.

## [2.1.0] — 2026-10-28

### Added
- Speaker buttons and Web Speech pronunciation.

## [2.0.0] — 2026-10-28

### Added
- Rewritten UI: a shadow-DOM card with states for checking, suggestion, clean,
  applied, translation, error and setup.
- DeepSeek and OpenAI providers only; Claude, Gemini and Groq removed.
- Checks actually run as you type (v1 only checked on a manual click), and the
  "what to fix" switches work.

## [1.x]

The first version: a popup with a manual check, global CSS in the page, and four
providers. Superseded by 2.0.
