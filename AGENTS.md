# AGENTS.md — Lumi Chrome Extension

## Project overview

Chrome Extension (Manifest V3) named **Lumi** — an autonomous browser agent powered by the DeepSeek API. Loads as an unpacked extension in Chrome; no build step, no package manager, no Node.js tooling.

## How to load and test

- Load the repo root as an **unpacked Chrome extension** via `chrome://extensions` → Developer mode → Load unpacked.
- There is no build, bundler, or package manager. All JS is loaded raw by Chrome.
- A **DeepSeek API key** (`sk-...`) is required; enter it in the side panel setup screen on first launch.
- The side panel is available on all non-internal tabs (disabled on `chrome://`, `chrome-extension://`, `about:` pages). Click the extension icon to open it.

## Architecture

| File | Role |
|------|------|
| `background.js` | Service worker: API orchestration, tool execution, message routing, history/storage management |
| `content.js` | Content script (isolated world): overlay UI, delegates page extraction & actions |
| `js/dom-mapper.js` | `DOMMapper` class: extracts interactive page structure, maps spatial positions, executes click/type/scroll/hover/upload_file actions, plus programmatic fallback actions |
| `js/error-tracker.js` | Injected in **MAIN world** at `document_start`: intercepts `console.error`, `window.onerror`, unhandled promises, XHR/fetch errors for QA mode |
| `js/sidepanel.js` | Side panel UI: chat messages, settings, image paste with OCR, test mode toggle |
| `ocr-sandbox.html` | Sandboxed page that runs Tesseract.js OCR (required by CSP sandbox policy) |
| `vendor/tesseract/` | Bundled Tesseract.js (wasm-based OCR) |

### Content script injection order (critical)

Two content scripts are declared in `manifest.json`, and their order matters:

1. **`js/error-tracker.js`** — `run_at: document_start`, `world: MAIN` — must load first to intercept errors from page load onward.
2. **`js/dom-mapper.js` + `content.js`** — `run_at: document_idle`, isolated world — depends on DOM being ready.

The error tracker uses `window.postMessage` to send errors to the isolated content script; they are *separate execution worlds*.

### Page extraction retry logic

`extractPageSafe()` in `background.js` retries up to 4 times with increasing waits: first via existing content script, then force-injects both scripts (`dom-mapper.js` + `content.js`) via `chrome.scripting.executeScript`, then waits longer for SPA/dynamic pages (Google, YouTube). Waits up to 15s for the page to finish loading before first extraction attempt.

### Two-tier action execution

Actions (click, type, hover, right_click, press_key) use a two-tier system:
1. **Debugger API** (primary): `chrome.debugger` attaches, dispatches native-level mouse/key events, then immediately detaches. The debugger badge flashes briefly.
2. **Programmatic fallback** (when debugger fails): DOM events are dispatched directly via `dispatchEvent` (MouseEvent, KeyboardEvent, input/change events). Handled by `DOMMapper.executeProgrammatic()`.

Do NOT remove the immediate debugger detach — it prevents the "debugger attached" banner from persisting.

## Key behaviors

- **Chat history is scoped** by tab group ID (`group_X`) or single tab ID (`tab_X`). Switching tabs switches the context/group, which changes the active chat history.
- **Multi-tab groups**: When tabs are in the "Lumi" group, all tab DOMs are extracted and labeled as `[TAB ID: X]` in the context.
- **50-action loop limit**: The agent terminates if it runs 50 consecutive tool calls without a final text response.
- **OCR**: The `take_screenshot_and_read` tool requires the side panel to be open (it sends a message to the side panel's sandboxed iframe). Will timeout after 15 seconds otherwise.
- **History sanitation**: Before sending to the API, `getChatHistory()` strips orphaned tool calls/tool results to prevent DeepSeek API errors about insufficient tool messages.
- **Navigation**: `navigate_to` waits up to 20s for the page to fully load before extracting context. Works on Google, Gmail, and any other site.

## Color palette

Defined in `.agents/PALETTE.md`. Primary: `#00a8ff` (Lumi Cyan). Gradients use `#00d2ff` → `#a800ff`. The old orange `#ff6600` is banned. Use gradients, not solid colors, for buttons and premium elements.

## DeepSeek API

- Endpoint: `https://api.deepseek.com/chat/completions`
- Model: `deepseek-chat`
- Balance check: `GET https://api.deepseek.com/user/balance`

## Storage keys (chrome.storage.local)

- `deepseekApiKey` — user's API key
- `chatHistories` — all chat history objects
- `userPreferences` — long-term memory key-value store
- `uiTheme`, `uiSize`, `qaTestMode`, `showQaBtn` — UI settings
