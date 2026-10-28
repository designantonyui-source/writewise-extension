# WriteWise privacy policy

Effective date: 28 October 2026. Applies to WriteWise 1.0.4.

## Writing checks

After you allow checks, WriteWise sends text directly from your browser to the AI provider you select: OpenAI or DeepSeek. Manual writing checks send the current eligible field's text; selection checks send only the selected text. Double-clicking a word sends that word for translation. Selecting text shows a Translate action; text is sent when you choose that action or the Translate selection context-menu item. The target language can be English, Polish, Russian, or Ukrainian. Changing the target in an open translation panel sends the same selection again in the new language. If you turn on automatic checking, eligible field text is sent after a typing pause. Automatic checking is off by default. Writing requests also include instructions and your selected fix categories/tone. Translation requests include instructions and your selected target language. The source language is detected by the provider. Your API key is sent only to its corresponding provider to authenticate the request.

WriteWise does not operate an intermediary server. Provider handling, retention, training policies, and charges depend on your provider account and terms. Read [OpenAI's privacy policy](https://openai.com/policies/privacy-policy/) and [DeepSeek's privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html). Avoid checking confidential information.

## Data on your device

API keys are saved in Chrome extension local storage restricted to trusted extension pages and its service worker. They are not synced by WriteWise. This storage is not encrypted by WriteWise and is not an operating-system credential vault. Clearing a key and saving removes it from this installation. OpenAI and DeepSeek keys found in Chrome sync storage are copied locally; their sync entries are removed only after the local write succeeds. Keys for removed providers (Gemini, Claude, and Groq) are deleted from both local and sync extension storage on upgrade. Previously synced copies may exist on other devices or older installations. The updated disclosure covering webpage selections and double-click translation requires consent again before writing checks or translations can run.

Preferences, consent, and paused hostnames use Chrome sync storage and may sync if Chrome sync is enabled. Local daily usage statistics contain only the date and number of corrections applied. They are not sent to the developer.

Drafts and corrections are held in content-script memory until invalidated or the page closes; WriteWise does not persist them in website storage. Visible suggestions are inserted into the website DOM, so that website can read them. Copying a correction places it on your system clipboard. Website scripts may already have access to text typed into their own fields.

## Your controls

You can pause all checks and translations, pause a hostname, disable selection translation, turn automatic writing checks off, remove keys, or choose **Stop sharing text** to revoke consent. Revoking consent prevents new checks and hides pending suggestions; requests already transmitted cannot be recalled. Removing the extension clears its local extension data. Chrome controls synced preference data and any browser/account backups. Data already received by a provider is subject to that provider's controls and policies.

WriteWise has no developer analytics or advertising requests and does not sell writing data. API calls are used only to provide the writing check you requested or enabled. No browsing history is sent as part of those API requests. Field filters exclude known credential/payment fields but cannot recognize every sensitive field.

## Contact and changes

Questions or privacy issues can be raised in the [WriteWise repository](https://github.com/designantonyui-source/writewise-extension/issues). Do not include keys or private writing in public issues. This policy must be updated before changing data handling, and new uses require appropriate disclosure and consent.
