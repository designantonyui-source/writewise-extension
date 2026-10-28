# WriteWise privacy policy

Effective date: 28 October 2026. Applies to WriteWise 1.0.1.

## Writing checks

After you allow checks, WriteWise sends text directly from your browser to the AI provider you select: Google Gemini, Anthropic Claude, or Groq. Manual checks send the current eligible field's text; selection checks send only the selected text. If you turn on automatic checking, eligible field text is sent after a typing pause. Automatic checking is off by default. Each request also includes writing instructions and your selected fix categories/tone. Your API key is sent only to its corresponding provider to authenticate the request.

WriteWise does not operate an intermediary server. Provider handling, retention, training policies, and charges depend on your provider account and terms. Read [Google's Gemini terms](https://ai.google.dev/gemini-api/terms), [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy), and [Groq's privacy policy](https://groq.com/privacy-policy/). Avoid checking confidential information.

## Data on your device

API keys are saved in Chrome extension local storage restricted to trusted extension pages and its service worker. They are not synced by WriteWise. This storage is not encrypted by WriteWise and is not an operating-system credential vault. Clearing a key and saving removes it from this installation. When upgrading from versions that saved keys in Chrome sync storage, WriteWise copies them locally and removes their sync entries only after the local write succeeds. Previously synced copies may exist on other devices or older installations.

Preferences, consent, and paused hostnames use Chrome sync storage and may sync if Chrome sync is enabled. Local daily usage statistics contain only the date and number of corrections applied. They are not sent to the developer.

Drafts and corrections are held in content-script memory until invalidated or the page closes; WriteWise does not persist them in website storage. Visible suggestions are inserted into the website DOM, so that website can read them. Copying a correction places it on your system clipboard. Website scripts may already have access to text typed into their own fields.

## Your controls

You can pause all checks, pause a hostname, turn automatic checking off, remove keys, or choose **Stop sharing text** to revoke consent. Revoking consent prevents new checks and hides pending suggestions; requests already transmitted cannot be recalled. Removing the extension clears its local extension data. Chrome controls synced preference data and any browser/account backups. Data already received by a provider is subject to that provider's controls and policies.

WriteWise has no developer analytics or advertising requests and does not sell writing data. API calls are used only to provide the writing check you requested or enabled. No browsing history is sent as part of those API requests. Field filters exclude known credential/payment fields but cannot recognize every sensitive field.

## Contact and changes

Questions or privacy issues can be raised in the [WriteWise repository](https://github.com/designantonyui-source/writewise-extension/issues). Do not include keys or private writing in public issues. This policy must be updated before changing data handling, and new uses require appropriate disclosure and consent.
