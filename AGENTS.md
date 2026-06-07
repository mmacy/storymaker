# AGENTS.md

Guidance for AI agents and human contributors working in this repository.

## What this is

Storymaker is a **GitHub Copilot CLI extension** that opens a native desktop window (a "webview") in which two local [Ollama](https://ollama.com) models collaboratively write a story, taking turns. The finished story can be **narrated aloud** with a local [Kokoro](https://github.com/hexgrad/kokoro) text-to-speech model. All code lives under `.github/extensions/storymaker/`.

## Architecture

```
Page (Chromium webview)  ──WebSocket──►  Extension (Node, main.mjs)  ──HTTP──►  Ollama
   content/*.js,html,css                  generation loop + callbacks            localhost:11434
                                          Kokoro TTS (kokoro-js, onnxruntime, CPU)
```

- **The extension owns all model work** — both Ollama generation *and* Kokoro narration. The page never calls Ollama or runs the TTS model. It invokes extension callbacks via the bridge (`window.copilot.<name>(...)`) and receives live updates when the extension runs `window.sm.<name>(...)` in the page through `webview.eval(...)`.
- **One WebSocket** connects page and extension; the reusable library in `lib/` manages the window lifecycle, the HTTP/WS server, and the `window.copilot` bridge.
- The extension registers a slash command `/storymaker` and three tools: `storymaker_show`, `storymaker_eval`, `storymaker_close`.

## Key files

| File | Responsibility |
| --- | --- |
| `.github/extensions/storymaker/main.mjs` | **The only file with app logic.** Ollama client (`listOllamaModels`, `openChat`/`streamChat`), prompt construction, the turn loop (`generateStory`), `cancel`, `saveStory`, Kokoro narration (`getTTS`, `narrate`, `saveAudio`, `floatsToWav`), and webview wiring. |
| `.github/extensions/storymaker/content/index.html` | UI markup. Must keep `<script src="/__bridge.js">` before `main.js`. |
| `.github/extensions/storymaker/content/main.js` | Page logic: model dropdowns, the `window.sm.*` live-update handlers, copy/save/stop, and the narration controls (voice picker + Web Audio playback queue). |
| `.github/extensions/storymaker/content/style.css` | Audible-inspired dark theme. |
| `.github/extensions/storymaker/extension.mjs` | 3-line bootstrapper. **Do not** add static npm imports here. |
| `.github/extensions/storymaker/lib/*` | Reusable webview library. **Copy verbatim — do not edit.** |

## How generation works (don't break these invariants)

- `generateStory({ starter, modelA, modelB, sentences, turns })` runs the whole loop and returns `{ ok, fullText, timing }` (the stopped/error path also returns `timing`). It is the **authoritative** source of story text.
- A running `story` string accumulates the starter plus every segment. **Each turn sends the full story so far** to the model (`buildPrompt`), so authors always have complete context. Keep this — partial context degrades coherence.
- **Conclusion step:** after the turn loop, if `conclude` is set (default true), the *opening* author (`authors[0]`, Author A) writes a closing segment of `sentences × concludeMultiplier` (1–4, default 2) sentences using `buildConcludeSystem`/`buildConcludePrompt`. It is pushed with `kind: "conclusion"` and included in `story`.
- Streaming: `streamChat` reads Ollama's newline-delimited JSON stream, yields `message.content` deltas, and **ignores `message.thinking`** so reasoning never leaks into the story.
- Requests send `think: false` to disable reasoning, with a fallback that retries without the flag if a model rejects it. Preserve both paths.
- Live UI updates are pushed via `push(method, payload)` → `webview.eval`. **All payloads are `JSON.stringify`-encoded** and the page renders text with `textContent` (never `innerHTML`). Do not interpolate raw model text into eval strings or HTML.
- A `busy` flag prevents overlapping generations; `cancel()` aborts the in-flight `fetch` via `AbortController`. The `busy` flag is cleared in `finally`.
- **Generation timing:** `generateStory` measures wall-clock start/end/total plus per-author average *turn* durations (regular turns only; the conclusion is timed separately) and returns them as `timing`. The page stashes `res.timing` on `state.meta`, and `buildFrontMatter` emits them as numeric YAML fields (`generation_seconds`, `author_a_avg_turn_seconds`, `conclusion_seconds`, …) for later analysis. Keep these numeric/unquoted so they parse as numbers.

## How narration works (Kokoro TTS)

- Narration runs **entirely in the extension**, like the Ollama loop — the page never touches the model. `kokoro-js` loads the 82M Kokoro model (`onnx-community/Kokoro-82M-v1.0-ONNX`, dtype `q8`) via `onnxruntime-node` and synthesizes 24 kHz mono audio on the **CPU**. No Python, server, or system `espeak-ng` is needed (espeak is bundled as WASM inside `kokoro-js`).
- The model is **lazy-loaded on first narration** (`getTTS`, memoized in `ttsPromise`), not at startup. The first load downloads ~103 MB; `env.cacheDir` is redirected to `~/.storymaker/models` so the download **survives `npm install`/reinstalls** (the transformers.js default cache lives inside `node_modules` and would be wiped). Coarse download progress is pushed to the page via `onNarrationStatus`.
- **Chunked synthesis:** a single `generate()` truncates at ~510 tokens, so `narrate` **pre-splits** the text into sentences with a `TextSplitterStream` (push, then **`close()`** — `tts.stream(string)` leaves its splitter open and would hang), then synthesizes each sentence with `tts.generate()`. Pre-splitting also yields an accurate sentence `total` for the progress bar. Each sentence's WAV (`audio.toWav()`) is base64-encoded and pushed as `onNarrationChunk { seq, total }`; the page decodes it with the **Web Audio API** into a cached per-sentence buffer.
- **One primary button, phase-driven** (`narration.phase`: `idle`/`loading`/`generating`/`playing`). Labels: **"Generate audio"** (no cached audio) → **"Generating…"** → **"Play"** (audio ready) → **"Playing…"**. Clicking synthesizes silently when there's no audio for the current story+voice, and plays the cached buffers (gapless, scheduled on the Web Audio clock) once there is. A **progress bar** shows the model download (indeterminate/percent via `onNarrationStatus { loadProgress }`), then determinate per-sentence synthesis (`received/total`), then playback position (rAF over the audio clock).
- **Auto-generate:** the "Generate audio when complete" checkbox (persisted via `setAutoNarrate` → `~/.storymaker/state.json`) triggers a silent `generateNarration()` from `weave()` *after* `setGenerating(false)` (not from `onComplete`, which fires before generation state clears). Auto is silent on purpose — auto-playing audio would be jarring and can hit autoplay policy.
- **Run isolation:** every narration run has a monotonic `requestId`; `narrate({ …, requestId })` echoes it in every pushed event, and the page ignores events whose id ≠ the current run. Stop/new-story bump the id so late chunks/errors can't corrupt a later run; `extBusy` keeps the button disabled until an in-flight `narrate()` unwinds (e.g. Stop pressed during the first-run model download). The page **awaits all decodes (`narration.chain`) before judging completion**, so a run doesn't "finish" before its chunks decode. Starting a new story calls `cancelNarration` so CPU-heavy TTS stops instead of racing Ollama.
- The extension concatenates every sentence's PCM into one WAV (`floatsToWav`) and keeps it in `lastNarration` **only on full success** (a stopped/partial run is not saved and is discarded page-side: button reverts to "Generate audio", Save stays disabled — stopping *playback*, by contrast, keeps the complete cache). `saveAudio` then writes the file without the page re-sending several MB of base64. `narrate` returns `{ ok, requestId, key, durationSec }` (or `{ ok:false, stopped }`); a `narrating` flag + `narrationAbort` (`AbortController`) mirror the generation `busy`/`cancel` pattern.
- Voices: `listVoices` returns a curated subset of Kokoro's 28 voices (the engine still accepts any id), the persisted `lastVoice`, and the `autoNarrate` flag. Narration is **single-voice** (one narrator for the whole story).
- **No parallelization.** Concurrent `generate()` calls on one onnxruntime-node session give **zero speedup** (measured 1/2/3/4-way ≈ 20.2s, RTF ~0.50 flat on a 10-core M-series) because one inference already saturates the CPU via intra-op threads. True parallelism would need multiple model instances in workers (N× RAM, splitting the same cores) — not worth it. Latency is instead mitigated by streaming: playback/availability begins as the first sentence finishes. `saveStatePatch` serializes writes so `lastVoice`/`autoNarrate`/`lastSaveDir` can't clobber each other.

## Conventions / gotchas

- **stdout is reserved for JSON-RPC.** Never use `console.log()` in extension code. Use `session.log(...)`.
- Tool names are global across all loaded extensions; keep the `storymaker_` prefix to avoid collisions.
- The page bridge buffers calls until the socket opens, so `copilot.*` is safe to call on load.
- Saving opens the platform's **native "Save As" dialog** (`osSaveDialog`: macOS `osascript`, Windows PowerShell `SaveFileDialog`, Linux `zenity`/`kdialog`) — the page no longer writes to `process.cwd()`. `osSaveDialog` takes `title` and `kind` (`"text"` | `"audio"`) to label the dialog and pick the file-type filter; the **story** save (`saveStory`, `.txt` + YAML front matter) and the **audio** save (`saveAudio`, `.wav` from `lastNarration`) both go through it. The last-used directory is persisted to `~/.storymaker/state.json` (`loadState`/`saveStatePatch`) and used as the dialog's default location next time. Both return `{ ok, path }`, `{ canceled: true }`, or `{ ok:false, error }`. The story file begins with a YAML front matter block (`buildFrontMatter`) built from the page-supplied `meta` (models + params + generation timing); the clipboard copy stays plain. When generation ends, the page prefills the filename box with a slug of Author A's model (`slugifyModel`: lowercase, alphanumeric + hyphens, `.txt`); the audio filename reuses the same slug with `.wav`.
- **kokoro-js / onnxruntime is a heavy dependency** (`node_modules` ~400 MB + a one-time ~103 MB model download). It is **dynamically imported** (`loadKokoro`) only when narration is first used, so startup stays fast. Its model load and onnxruntime/espeak logging go to **stderr**, not stdout, so the JSON-RPC channel stays clean (verified) — but still never add `console.log` of your own.
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

The **first narration** downloads the Kokoro model (~103 MB) to `~/.storymaker/models`; subsequent runs load from cache in ~2 s. CPU synthesis is roughly 2× faster than realtime.

There is no automated test suite or build step (vanilla HTML/JS, no bundler). Keep it that way unless a change genuinely requires it.

## When extending

- New page→extension actions: add a callback to the `callbacks` object in `main.mjs`, then call it from the page as `await copilot.<name>(...)`.
- New extension→page updates: add a handler to `window.sm` in `content/main.js`, then push it from the extension via `push("<name>", payload)`.
- Keep changes surgical and within `.github/extensions/storymaker/`. Don't edit `lib/`.
