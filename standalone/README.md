# Storymaker (standalone)

> Two local minds, one collaborative story — in your browser, no Copilot CLI required.

This is a self-contained version of [Storymaker](../README.md) that runs as a plain local web app. It reuses the extension's engine (the Ollama turn loop and Kokoro narration) and its UI **unchanged** — only the transport differs. Instead of a native window driven over a WebSocket, a small Node server serves the page and bridges it with two browser-native primitives:

- `POST /api/rpc` — request/reply, backing the page's `window.copilot.<method>(...)` calls.
- `GET /api/events` — Server-Sent Events, carrying the live updates the engine pushes into `window.sm.*`.

The page in `content/` is byte-for-byte identical to the extension's, so both flavors look and behave the same.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer (for global `fetch` and web streams).
- [Ollama](https://ollama.com) running locally (default `http://localhost:11434`) with at least one pulled model:

  ```bash
  ollama pull llama3.2
  ollama pull qwen2.5
  ```

- For audio narration only: the `@huggingface/transformers` + `kokoro-js` dependencies (installed by `npm install` below). They are heavy (`node_modules` is a few hundred MB) and the Kokoro voice model (~103 MB) downloads on first use. Story generation itself needs no npm dependencies.

## Running it

```bash
cd standalone
npm install        # pulls the narration deps; story generation works without them
npm start          # or: node server.mjs
```

The server prints its URL and opens your default browser:

```
  Storymaker is live
     http://127.0.0.1:4757/
```

Then it works exactly like the extension: enter starter text, pick a model for each author, set sentences/turns, **weave a story**, and optionally **copy**, **save**, or **narrate** it. Saving still uses your OS's native "Save As" dialog, and copy/paste shortcuts still route through your system clipboard — those run on the local machine via Node, just as in the extension.

## Configuration

| Setting | Where | Default |
| --- | --- | --- |
| Ollama endpoint | `OLLAMA_HOST` env var | `http://localhost:11434` |
| Server port | `APP_PORT` env var | `4757` (falls back to the next free port if taken) |
| Skip auto-opening the browser | `NO_OPEN` env var (set to anything) | unset (browser opens) |

```bash
OLLAMA_HOST=http://192.168.1.50:11434 APP_PORT=8080 npm start
```

> **Privacy:** by default everything stays on your machine — the server talks to a local Ollama instance and synthesizes audio locally with Kokoro. If you point `OLLAMA_HOST` at a remote or LAN server, your starter text and generated story are sent there.

## Where things are saved

- Saved stories (`.txt` with YAML front matter) and narration audio (`.wav`) go wherever you choose in the native save dialog.
- The last-used save directory, narrator voice, and the "generate audio when complete" preference persist to `~/.storymaker/state.json`.
- The Kokoro voice model is cached under `~/.storymaker/models` (shared with the extension, so it isn't re-downloaded if you've used either flavor before).

## How it relates to the extension

The extension lives in [`.github/extensions/storymaker/`](../.github/extensions/storymaker). This standalone app is a sibling, not a replacement — the extension is untouched. `standalone/server.mjs` is a copy of the extension's engine with the Copilot-specific wiring (the native window, WebSocket bridge, slash command, and tools) swapped for the plain HTTP + SSE server above; `standalone/content/` is a verbatim copy of the extension's `content/`. If you change generation or narration behavior, update both so they stay in sync.
