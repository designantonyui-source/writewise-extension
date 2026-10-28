# WriteWise — Chrome extension

Check spelling, grammar, clarity, and tone with OpenAI or DeepSeek. Every correction requires your review.

## Install or update (Chrome 114+)

1. Download the source and run `npm ci` followed by `npm run build`, or use the packaged extension ZIP.
2. Extract the ZIP if using a package.
3. Open `chrome://extensions` and enable **Developer mode**.
4. Choose **Load unpacked** and select the folder containing `manifest.json`.
5. For an existing installation, replace the files in its folder, click **Reload**, and refresh open website tabs.
6. Open WriteWise, read the updated privacy disclosure, and choose **Allow checks and continue** if you agree. Existing users must accept the new provider disclosure too.
7. Choose OpenAI or DeepSeek and save your API key. OpenAI uses GPT-5.4 mini; DeepSeek uses DeepSeek Flash with thinking disabled. Keys are not validated until your first check; provider usage and pricing limits apply.

## Check your writing

- Type at least 10 characters in a supported field, then click the **✳** beside it.
- Review the changes and choose **Apply** (or press Tab). Enter keeps its normal typing behavior.
- **Undo** restores the exact previous value while the applied text is unchanged. Further editing invalidates undo.
- To check part of a draft, select text inside its field and choose **Check selection with WriteWise** from the right-click menu. Only the selection is sent and replaced.
- Rich-text editors offer **Copy correction**, preserving editor formatting and state. Paste the correction yourself where needed.
- Checks accept up to **500 words and 12,000 characters** per request. Incomplete or empty AI responses cannot be applied.

## Settings

The compact popup shows provider and writing controls first. Expand **Manage** to edit your API key, or **More preferences** to choose tone, timing, or revoke consent.

- **Master toggle** pauses all checks. **Pause here** pauses checks on the current hostname, including its context-menu checks.
- **Check automatically** is off by default. Turning it on sends eligible field text to your selected provider after you pause (0.5–4 seconds), with at least 8 seconds between checks per page. Switch it off for manual checks.
- Turn individual fix categories on or off. Turning all categories off prevents checks.
- **Stop sharing text** revokes consent and disables automatic checks. A request already sent to a provider cannot be recalled.
- Clear a provider key and choose **Save** to delete it from this installation.

## Privacy and compatibility

See [the privacy policy](PRIVACY.md), also available inside the extension. Text is sent directly to your selected provider over HTTPS. Avoid checking confidential information.

API keys persist in device-local Chrome extension storage restricted to trusted extension contexts. They are not encrypted by WriteWise and are not an operating-system credential vault. OpenAI and DeepSeek keys found in Chrome sync storage migrate locally; their sync entries are removed after a successful write. Keys for removed providers (Gemini, Claude, and Groq) are deleted from extension storage on upgrade. Other devices running older versions should also be updated.

Checked drafts and corrections stay in content-script memory; WriteWise no longer stores them in a website's Web Storage. The visible suggestion is part of the host page DOM and can be read by that page. Settings may sync through Chrome; local daily statistics contain only a date and count.

Supported fields: text/search inputs, textareas, and copy-only contenteditable editors on ordinary HTTP/HTTPS pages. Passwords, email/URL inputs, read-only fields, recognized credential/payment autocomplete fields, and fields inside `data-writewise="off"` or `data-sensitive="true"` containers are excluded. These filters cannot recognize every sensitive field. Chrome internal pages, closed shadow roots, embedded frame editors, and specialized editors such as Google Docs are not supported.

The extension injects its writing controls on HTTP/HTTPS sites. Host permissions are limited to the two AI API origins. `storage`, `activeTab`, and `contextMenus` support preferences/keys, identifying the current site when opening settings, and checking selections.

## Development and verification

```sh
npm ci
npx playwright install chromium
npm run build
npm test
npm run test:e2e
```

Use `HEADED=1 npm run test:e2e` to inspect the browser. Browser tests load the actual unpacked extension in a temporary Chromium profile and mock provider responses in the service worker. They use fake keys, make no paid AI requests, and cover the writing workflow, consent, pauses, selected ranges, rich-text preservation, stale responses, and popup settings. Unit tests cover credential migration, worker authorization, input limits, and completion handling for both providers.

Before a Chrome Web Store submission, publish the privacy policy at an accessible URL, enter it in the developer dashboard, and complete the store data disclosures. Review the policy whenever providers or behavior change.

Provider API references: [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/).
