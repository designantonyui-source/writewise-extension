# WriteWise — Chrome Extension

Auto-corrects spelling, grammar, clarity & tone as you type, powered by Claude AI.

## Install (Developer Mode)

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle top-right)
3. Click **Load unpacked**
4. Select this `writewise-extension` folder
5. The ✳ icon appears in your toolbar

## Setup

1. Click the ✳ WriteWise icon in your toolbar
2. Enter your **Anthropic API key** (`sk-ant-…`)  
   → Get one at https://console.anthropic.com
3. Click **Save**

## How it works

- Start typing in any text field on any website
- After you pause typing (default: 1.5s), WriteWise sends your text to Claude
- A small popup appears below the field with a corrected version
- Click **✓ Apply** to replace your text, or **Dismiss** to ignore

## Settings (click the toolbar icon)

| Setting | Description |
|---|---|
| Master toggle | Enable / pause WriteWise globally |
| Spelling | Fix spelling errors |
| Grammar | Fix grammatical mistakes |
| Clarity & style | Improve sentence structure and flow |
| Tone | Refine tone to be clearer and more natural |
| Check after | How long to wait after you stop typing (0.5s – 4s) |

## Notes

- Your API key is stored locally in Chrome's sync storage
- Text is sent to Anthropic's API — avoid using on sensitive/confidential content
- The extension works on `<input>`, `<textarea>`, and `contenteditable` fields
- Short text (under 10 characters) is ignored
