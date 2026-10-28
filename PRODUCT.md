# WriteWise

A quiet proofreader for any text field on the web. It waits for you to pause,
shows what it would change, and lets you accept it with one key.

## Who it is for

One person who writes in browser text fields all day — email, tickets, chat,
posts — and wants correct prose without switching to a chatbot, a doc, or a
web app. Their own API key, their own data.

## Providers

- **DeepSeek** (default) — `deepseek-flash`, thinking mode disabled for latency.
- **OpenAI** — `gpt-6-luna` default, `gpt-6.1-terra` for quality work.

Both go through one OpenAI-compatible client in `src/providers.js`. Adding a
third compatible provider means adding one object to `PROVIDERS`, nothing else.

## Jobs

1. While I type, silently fix spelling, grammar, clarity and tone in the field.
2. Never interrupt: no card while I'm still typing, no card for short or
   password/payment/OTP fields, no card on paused sites.
3. Show a compact diff I can trust in two seconds, then apply it into the field
   without destroying undo or the host page's editor state.
4. Tell me exactly what went wrong (key, model, quota, network) and give me one
   action to fix it.
5. Let me do it by hand when I want: ⌥⇧W on the focused field, or right-click →
   "Fix selection".
6. Translate a word I do not know, and keep it — with its sentence — in a local
   vocabulary I can review later and export to my own tools.

## Principles

- **Silence is the default state.** The card only exists when it has something
  to say, and it leaves when dismissed.
- **The text field is the product.** We never take over typing, never steal Tab,
  never move focus.
- **Two providers, no matrix.** No provider zoo, no model pickers for models we
  cannot keep current.
- **Keys are secrets.** `storage.local`, never `storage.sync`, never a server of
  ours. There is no backend.
- **Learning is local.** The vocabulary is a file on this device; export is how
  you take it with you.
- **No build step.** Load unpacked, read the source, edit it, reload.

## Non-goals

- Canvas-based editors (Google Docs, Figma) — they do not expose editable DOM.
- Sending text anywhere except the provider the user picked.
- Accounts, telemetry, analytics, "AI features" beyond fixing the sentence.

## Out of scope but decided

- Chrome Web Store listing; publishing is a later, deliberate step.
