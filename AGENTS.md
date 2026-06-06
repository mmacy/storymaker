# AGENTS.md

Guidance for AI agents and human contributors working in this repository.

## What this is

Storymaker is a **GitHub Copilot CLI extension** that opens a native desktop window (a "webview") in which two local [Ollama](https://ollama.com) models collaboratively write a story, taking turns. All code lives under `.github/extensions/storymaker/`.

## Architecture

```
Page (Chromium webview)  ──WebSocket──►  Extension (Node, main.mjs)  ──HTTP──►  Ollama
   content/*.js,html,css                  generation loop + callbacks            localhost:11434
```

- **The extension owns all model work.** The page never calls Ollama. It invokes extension callbacks via the bridge (`window.copilot.<name>(...)`) and receives live updates when the extension runs `window.sm.<name>(...)` in the page through `webview.eval(...)`.
- **One WebSocket** connects page and extension; the reusable library in `lib/` manages the window lifecycle, the HTTP/WS server, and the `window.copilot` bridge.
- The extension registers a slash command `/storymaker` and three tools: `storymaker_show`, `storymaker_eval`, `storymaker_close`.

## Key files

| File | Responsibility |
| --- | --- |
| `.github/extensions/storymaker/main.mjs` | **The only file with app logic.** Ollama client (`listOllamaModels`, `openChat`/`streamChat`), prompt construction, the turn loop (`generateStory`), `cancel`, `saveStory`, and webview wiring. |
| `.github/extensions/storymaker/content/index.html` | UI markup. Must keep `<script src="/__bridge.js">` before `main.js`. |
| `.github/extensions/storymaker/content/main.js` | Page logic: model dropdowns, the `window.sm.*` live-update handlers, copy/save/stop. |
| `.github/extensions/storymaker/content/style.css` | Audible-inspired dark theme. |
| `.github/extensions/storymaker/extension.mjs` | 3-line bootstrapper. **Do not** add static npm imports here. |
| `.github/extensions/storymaker/lib/*` | Reusable webview library. **Copy verbatim — do not edit.** |

## How generation works (don't break these invariants)

- `generateStory({ starter, modelA, modelB, sentences, turns })` runs the whole loop and returns `{ ok, fullText }`. It is the **authoritative** source of story text.
- A running `story` string accumulates the starter plus every segment. **Each turn sends the full story so far** to the model (`buildPrompt`), so authors always have complete context. Keep this — partial context degrades coherence.
- **Conclusion step:** after the turn loop, if `conclude` is set (default true), the *opening* author (`authors[0]`, Author A) writes a closing segment of `sentences × concludeMultiplier` (1–4, default 2) sentences using `buildConcludeSystem`/`buildConcludePrompt`. It is pushed with `kind: "conclusion"` and included in `story`.
- Streaming: `streamChat` reads Ollama's newline-delimited JSON stream, yields `message.content` deltas, and **ignores `message.thinking`** so reasoning never leaks into the story.
- Requests send `think: false` to disable reasoning, with a fallback that retries without the flag if a model rejects it. Preserve both paths.
- Live UI updates are pushed via `push(method, payload)` → `webview.eval`. **All payloads are `JSON.stringify`-encoded** and the page renders text with `textContent` (never `innerHTML`). Do not interpolate raw model text into eval strings or HTML.
- A `busy` flag prevents overlapping generations; `cancel()` aborts the in-flight `fetch` via `AbortController`. The `busy` flag is cleared in `finally`.

## Conventions / gotchas

- **stdout is reserved for JSON-RPC.** Never use `console.log()` in extension code. Use `session.log(...)`.
- Tool names are global across all loaded extensions; keep the `storymaker_` prefix to avoid collisions.
- The page bridge buffers calls until the socket opens, so `copilot.*` is safe to call on load.
- Saving opens the platform's **native "Save As" dialog** (`osSaveDialog`: macOS `osascript`, Windows PowerShell `SaveFileDialog`, Linux `zenity`/`kdialog`) — the page no longer writes to `process.cwd()`. The last-used directory is persisted to `~/.storymaker/state.json` (`loadState`/`saveStatePatch`) and used as the dialog's default location next time. `saveStory` returns `{ ok, path }`, `{ canceled: true }`, or `{ ok:false, error }`. Each file begins with a YAML front matter block (`buildFrontMatter`) built from the page-supplied `meta` (models + params); the clipboard copy stays plain. When generation ends, the page prefills the filename box with a slug of Author A's model (`slugifyModel`: lowercase, alphanumeric + hyphens, `.txt`).
- When creating PRs/commits/issues with `gh`/`git`, don't pass a body containing backticks or parentheses via `$(cat <<'EOF' … EOF)` — the heredoc body gets mangled by shell interpretation (backticks/parens). Write the body to a file and use `--body-file`/`-F` (e.g. `gh pr create --body-file body.md`).
- The webview has **no native Edit menu** and its in-page clipboard (`navigator.clipboard`, `execCommand` copy/cut/paste) is gesture-gated/unreliable. So the page's `keydown` handler routes **copy/cut/paste through the extension's OS clipboard** (`clipboardWrite`/`clipboardRead` → `osClipboardCopy`/`osClipboardPaste`); paste inserts with `execCommand("insertText", …)` and cut deletes with `execCommand("delete")` so the field's native undo stack stays intact. Select-all is `el.select()`; undo/redo use `execCommand`. Async copy/cut/paste re-check `document.activeElement` after the await so text never lands in the wrong field.

## Developing & testing

This is a UI extension, so most verification is interactive:

1. Edit files under `.github/extensions/storymaker/`.
2. Reload: in Copilot CLI run `/reload`, or have the agent call the `extensions_reload` tool. For content-only changes, calling `storymaker_show` with `reload: true` refreshes the page.
3. Open the window with `/storymaker` (or the `storymaker_show` tool).
4. Drive/inspect the page with the `storymaker_eval` tool, e.g. read `document.getElementById('status').textContent` or click `#weave`.

Quick sanity checks before reloading:

```bash
node --check .github/extensions/storymaker/main.mjs
node --check .github/extensions/storymaker/content/main.js
```

Verify Ollama is reachable:

```bash
curl -s http://localhost:11434/api/tags | head -c 400
```

There is no automated test suite or build step (vanilla HTML/JS, no bundler). Keep it that way unless a change genuinely requires it.

## When extending

- New page→extension actions: add a callback to the `callbacks` object in `main.mjs`, then call it from the page as `await copilot.<name>(...)`.
- New extension→page updates: add a handler to `window.sm` in `content/main.js`, then push it from the extension via `push("<name>", payload)`.
- Keep changes surgical and within `.github/extensions/storymaker/`. Don't edit `lib/`.
