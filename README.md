# Storymaker

> Two local minds, one collaborative story.

Storymaker is a [GitHub Copilot CLI](https://github.com/github/copilot-cli) extension that opens a native desktop window where **two local [Ollama](https://ollama.com) models take turns writing a story**. You provide the opening line, pick a model for each author, and watch the prose stream in live as the two models hand the narrative back and forth.

![Storymaker in action](docs/screenshot.png)

## Features

- 🤝 **Two-author collaboration** — Author A writes a configurable number of sentences, Author B continues, and they alternate for as many turns as you choose.
- 🧠 **Full shared context** — every turn, each author receives the *entire* story so far, so the narrative stays coherent as it grows.
- 🎛️ **Pick any installed model per author** — both dropdowns are populated from your local Ollama models; mix and match (e.g. `qwen3.5` + `gemma4`).
- ⚡ **Live token streaming** — text appears word-by-word with a blinking caret, color-coded by author.
- ⏹️ **Stop anytime** — cancel mid-generation and keep the partial story.
- 📋 **Copy & save** — copy the finished story to the clipboard or save it to a `.txt` file.
- 🎨 **Audible-inspired dark theme** — near-black canvas, signature orange accents, serif story type.

## How it works

```
┌──────────────────────────┐        ┌──────────────────────────┐
│  Webview (the UI)        │  RPC   │  Extension (main.mjs)     │
│  pick models, see story  │ ◄────► │  orchestrates the loop    │
└──────────────────────────┘        └────────────┬─────────────┘
                                                  │ HTTP
                                                  ▼
                                       ┌──────────────────────┐
                                       │  Ollama (localhost)  │
                                       │  /api/tags /api/chat │
                                       └──────────────────────┘
```

The extension (Node) owns all model orchestration. For each turn it sends the **full story so far** to the chosen model via Ollama's streaming `/api/chat`, appends the result, and pushes live tokens to the page. The page never talks to Ollama directly — it calls back into the extension through the webview bridge (`window.copilot.*`) and receives updates via `window.sm.*`.

Reasoning is disabled (`think: false`) so the models write prose directly instead of spending their token budget thinking — with an automatic fallback for models that don't support that flag.

## Requirements

- [GitHub Copilot CLI](https://github.com/github/copilot-cli)
- [Ollama](https://ollama.com) running locally (default `http://localhost:11434`)
- At least one pulled model, e.g.:
  ```bash
  ollama pull qwen3.5
  ollama pull gemma4
  ```

## Installation

Storymaker is a **project-scoped Copilot CLI extension**. Clone this repo and open Copilot CLI from inside it:

```bash
git clone https://github.com/mmacy/storymaker.git
cd storymaker
copilot
```

The extension lives in `.github/extensions/storymaker/` and is auto-discovered. On first load Copilot installs its npm dependencies automatically. If the extension doesn't appear, run `/reload` (or restart the CLI).

## Usage

From within Copilot CLI:

```
/storymaker
```

This opens the Storymaker window. Then:

1. **Enter starter text** — the opening of your story.
2. **Choose a model** for Author A and Author B.
3. Set **sentences per turn** (1–10) and **number of turns** (1–25).
4. Click **Weave story** and watch the two authors collaborate.
5. **Copy** or **Save** the finished story (saved files land in the repo root by default).

> The agent can also open and drive the window via the `storymaker_show`, `storymaker_eval`, and `storymaker_close` tools.

## Configuration

| Setting | Where | Default |
| --- | --- | --- |
| Ollama endpoint | `OLLAMA_HOST` env var | `http://localhost:11434` |
| Sentences per turn | UI | 2 (range 1–10) |
| Number of turns | UI | 3 (range 1–25) |
| Window size | `main.mjs` (`width`/`height`) | 1040 × 820 |

## Project structure

```
.github/extensions/storymaker/
├── extension.mjs        # bootstrapper (installs deps, imports main.mjs)
├── main.mjs             # Ollama client + generation loop + callbacks
├── package.json
├── lib/                 # reusable webview library (do not edit)
│   ├── copilot-webview.js
│   └── webview-child.mjs
└── content/             # the UI served to the window
    ├── index.html
    ├── style.css
    └── main.js
```

See [AGENTS.md](AGENTS.md) for contributor and AI-agent guidance.

## License

MIT
