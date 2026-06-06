// Storymaker — two local Ollama models take turns extending a single story.
// All model orchestration happens here in the extension; the page drives it via
// `copilot.*` callbacks and receives live tokens pushed back via `window.sm.*`.
import { joinSession } from "@github/copilot-sdk/extension";
import { join, basename, dirname } from "node:path";
import { writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { CopilotWebview } from "./lib/copilot-webview.js";

const OLLAMA = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/+$/, "");

// Persisted, user-level state (e.g. the last directory used in the save dialog).
const STATE_DIR = join(homedir(), ".storymaker");
const STATE_FILE = join(STATE_DIR, "state.json");

async function loadState() {
    try {
        const parsed = JSON.parse(await readFile(STATE_FILE, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

async function saveStatePatch(patch) {
    try {
        const next = { ...(await loadState()), ...patch };
        await mkdir(STATE_DIR, { recursive: true });
        await writeFile(STATE_FILE, JSON.stringify(next, null, 2), "utf8");
    } catch (err) {
        await session?.log(`Storymaker: could not persist state (${err?.message || err}).`);
    }
}

// Spawns a command and resolves { code, stdout, stderr }. Never rejects except on
// spawn failure or timeout. Used for clipboard reads and native dialogs.
function runCapture(cmd, args, { timeout = 120000 } = {}) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(cmd, args);
        } catch (e) {
            reject(e);
            return;
        }
        let out = "";
        let err = "";
        let settled = false;
        const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };
        const timer = setTimeout(() => {
            try { child.kill(); } catch {}
            done(reject, new Error(`${cmd} timed out`));
        }, timeout);
        child.stdout?.on("data", (d) => (out += d));
        child.stderr?.on("data", (d) => (err += d));
        child.on("error", (e) => done(reject, e));
        child.on("close", (code) => done(resolve, { code, stdout: out, stderr: err }));
    });
}

let session;
let webview;

// ---- Ollama client -------------------------------------------------------

async function listOllamaModels() {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Ollama responded with HTTP ${res.status}`);
    const data = await res.json();
    return (data.models || [])
        .map((m) => m.name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
}

// Write text to the OS clipboard from the extension (Node) side. WKWebView's
// in-page clipboard API is gesture-gated and unreliable, so we shell out to the
// platform clipboard utility instead. Linux tries xclip then wl-copy.
function osClipboardCopy(text) {
    const candidates =
        process.platform === "darwin" ? [["pbcopy", []]] :
        process.platform === "win32" ? [["clip", []]] :
        [["xclip", ["-selection", "clipboard"]], ["wl-copy", []]];

    const tryOne = ([cmd, args]) =>
        new Promise((resolve, reject) => {
            const child = spawn(cmd, args);
            let settled = false;
            const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };
            const timer = setTimeout(() => {
                try { child.kill(); } catch {}
                done(reject, new Error(`${cmd} timed out`));
            }, 4000);
            child.on("error", (e) => done(reject, e));
            child.on("close", (code) => (code === 0 ? done(resolve) : done(reject, new Error(`${cmd} exited with code ${code}`))));
            child.stdin.on("error", () => {});
            child.stdin.end(text);
        });

    return candidates.reduce(
        (p, cand) => p.catch(() => tryOne(cand)),
        Promise.reject(new Error("init"))
    ).catch((e) => {
        const hint = process.platform === "linux" ? " (install xclip or wl-clipboard)" : "";
        throw new Error(`Could not access the system clipboard${hint}: ${e.message}`);
    });
}

// Reveal a file in the OS file manager (selecting it within its folder) from the
// extension (Node) side. macOS uses `open -R`; Windows uses Explorer's /select;
// Linux tries the FileManager1 D-Bus interface, then falls back to opening the
// containing folder with xdg-open.
function osRevealPath(path) {
    const target = String(path ?? "");
    if (!target) return Promise.reject(new Error("No path to reveal."));
    const folder = dirname(target);
    const candidates =
        process.platform === "darwin" ? [["open", ["-R", target]]] :
        // Explorer returns a non-zero exit code even on success, so ignore it.
        process.platform === "win32" ? [["explorer", [`/select,${target}`], true]] :
        [
            ["dbus-send", ["--session", "--dest=org.freedesktop.FileManager1",
                "--type=method_call", "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1.ShowItems",
                `array:string:file://${target}`, "string:"]],
            ["xdg-open", [folder]],
        ];

    const tryOne = ([cmd, args, ignoreExit]) =>
        new Promise((resolve, reject) => {
            const child = spawn(cmd, args);
            let settled = false;
            const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };
            const timer = setTimeout(() => {
                try { child.kill(); } catch {}
                done(reject, new Error(`${cmd} timed out`));
            }, 4000);
            child.on("error", (e) => done(reject, e));
            child.on("close", (code) =>
                (ignoreExit || code === 0 ? done(resolve) : done(reject, new Error(`${cmd} exited with code ${code}`))));
        });

    return candidates.reduce(
        (p, cand) => p.catch(() => tryOne(cand)),
        Promise.reject(new Error("init"))
    ).catch((e) => {
        const hint = process.platform === "linux" ? " (install a file manager or xdg-utils)" : "";
        throw new Error(`Could not reveal the file${hint}: ${e.message}`);
    });
}

// Read text from the OS clipboard (the inverse of osClipboardCopy). WKWebView's
// in-page paste is gesture-gated/unreliable, so the page asks the extension to
// read the clipboard and then inserts the text itself.
async function osClipboardPaste() {
    const candidates =
        process.platform === "darwin" ? [["pbpaste", []]] :
        process.platform === "win32" ? [["powershell", ["-NoProfile", "-Command", "[Console]::Out.Write([string](Get-Clipboard -Raw))"]]] :
        [["xclip", ["-selection", "clipboard", "-o"]], ["wl-paste", ["-n"]]];

    let lastErr;
    for (const [cmd, args] of candidates) {
        try {
            const r = await runCapture(cmd, args, { timeout: 4000 });
            if (r.code === 0) return r.stdout;
            lastErr = new Error(`${cmd} exited with code ${r.code}`);
        } catch (e) {
            lastErr = e;
        }
    }
    const hint = process.platform === "linux" ? " (install xclip or wl-clipboard)" : "";
    throw new Error(`Could not read the system clipboard${hint}: ${lastErr?.message || "no tool available"}`);
}

async function isDirectory(dir) {
    if (!dir) return false;
    try {
        return (await stat(dir)).isDirectory();
    } catch {
        return false;
    }
}

// Show the platform's native "Save As" dialog and resolve the chosen absolute
// path, or null if the user cancels. macOS uses osascript, Windows uses a
// PowerShell SaveFileDialog, Linux tries zenity then kdialog.
async function osSaveDialog({ defaultName, defaultDir }) {
    const name = String(defaultName || "story.txt");
    let dir = String(defaultDir || "");
    if (!(await isDirectory(dir))) dir = "";

    if (process.platform === "darwin") {
        const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const loc = dir ? ` default location POSIX file "${esc(dir)}"` : "";
        const script =
            `set theFile to choose file name with prompt "Save story" default name "${esc(name)}"${loc}\n` +
            `POSIX path of theFile`;
        const r = await runCapture("osascript", ["-e", script], { timeout: 300000 });
        if (r.code === 0) return r.stdout.trim() || null;
        if (/-128|User canceled/i.test(r.stderr)) return null;
        throw new Error(r.stderr.trim() || `osascript exited with code ${r.code}`);
    }

    if (process.platform === "win32") {
        const q = (s) => s.replace(/'/g, "''");
        const initDir = dir ? `$d.InitialDirectory = '${q(dir)}';` : "";
        const script =
            "Add-Type -AssemblyName System.Windows.Forms;" +
            "$d = New-Object System.Windows.Forms.SaveFileDialog;" +
            `$d.Title = 'Save story';$d.FileName = '${q(name)}';${initDir}` +
            "$d.Filter = 'Text files (*.txt)|*.txt|All files (*.*)|*.*';$d.OverwritePrompt = $true;" +
            "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) } else { exit 2 }";
        const r = await runCapture("powershell", ["-NoProfile", "-STA", "-Command", script], { timeout: 300000 });
        if (r.code === 0) return r.stdout.trim() || null;
        if (r.code === 2) return null;
        throw new Error(r.stderr.trim() || `powershell exited with code ${r.code}`);
    }

    const base = dir ? `${dir.replace(/\/+$/, "")}/${name}` : name;
    const candidates = [
        ["zenity", ["--file-selection", "--save", "--confirm-overwrite", "--title=Save story", `--filename=${base}`]],
        ["kdialog", ["--getsavefilename", base, "*.txt"]],
    ];
    let lastErr;
    for (const [cmd, args] of candidates) {
        try {
            const r = await runCapture(cmd, args, { timeout: 300000 });
            if (r.code === 0) return r.stdout.trim() || null;
            if (r.code === 1) return null; // user canceled
            lastErr = new Error(r.stderr.trim() || `${cmd} exited with code ${r.code}`);
        } catch (e) {
            lastErr = e;
        }
    }
    throw new Error(`Could not open a save dialog (install zenity or kdialog): ${lastErr?.message || "no tool available"}`);
}

// Opens a streaming /api/chat response. `think` disables reasoning output so the
// model writes prose directly instead of spending its token budget thinking.
async function openChat({ model, system, prompt, sentences, signal, think }) {
    const body = {
        model,
        stream: true,
        messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
        ],
        options: {
            temperature: 0.9,
            top_p: 0.95,
            num_predict: Math.min(2048, sentences * 80 + 80),
        },
    };
    if (think === false) body.think = false;
    const res = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`Ollama /api/chat failed (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
        err.body = text;
        throw err;
    }
    return res;
}

// Streams assistant content deltas from /api/chat. Yields plain text pieces.
async function* streamChat({ model, system, prompt, sentences, signal }) {
    let res;
    try {
        res = await openChat({ model, system, prompt, sentences, signal, think: false });
    } catch (err) {
        // Some models don't support the `think` flag; retry without it.
        if (!signal.aborted && /think/i.test(err?.body || err?.message || "")) {
            res = await openChat({ model, system, prompt, sentences, signal });
        } else {
            throw err;
        }
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    function* handleLine(line) {
        const trimmed = line.trim();
        if (!trimmed) return;
        let obj;
        try { obj = JSON.parse(trimmed); } catch { return; }
        if (obj.error) throw new Error(String(obj.error));
        const piece = obj.message?.content; // deliberately ignore obj.message.thinking
        if (piece) yield piece;
    }
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            yield* handleLine(line);
        }
    }
    buf += decoder.decode();
    yield* handleLine(buf);
}

// ---- Prompt construction -------------------------------------------------

function buildSystem(label, sentences) {
    const s = sentences === 1 ? "sentence" : "sentences";
    return (
        `You are ${label}, one of two authors co-writing a single continuous story by taking turns. ` +
        `Continue the story seamlessly from exactly where it leaves off, preserving the established characters, ` +
        `setting, tense, point of view, and tone. Write exactly ${sentences} ${s} of vivid narrative prose, then stop. ` +
        `Do not restate or summarize earlier text. Do not end or wrap up the story. ` +
        `Output only the continuation prose — no headings, labels, author names, lists, surrounding quotation marks, or commentary.`
    );
}

function buildPrompt(story, sentences) {
    const s = sentences === 1 ? "sentence" : "sentences";
    return (
        `The story so far:\n\n${story}\n\n` +
        `Now write the next ${sentences} ${s}, continuing directly and seamlessly from the final sentence above. Prose only.`
    );
}

function buildConcludeSystem(label, sentences) {
    const s = sentences === 1 ? "sentence" : "sentences";
    return (
        `You are ${label}, the author bringing a collaborative story to its end. ` +
        `Write exactly ${sentences} ${s} of vivid narrative prose that conclude the story — resolving its central tension ` +
        `and giving it a satisfying, definitive ending. Continue seamlessly from exactly where the story leaves off, ` +
        `preserving the established characters, setting, tense, point of view, and tone. Do not restate or summarize earlier text. ` +
        `Output only the concluding prose — no headings, labels, author names, lists, surrounding quotation marks, or commentary.`
    );
}

function buildConcludePrompt(story, sentences) {
    const s = sentences === 1 ? "sentence" : "sentences";
    return (
        `The story so far:\n\n${story}\n\n` +
        `Now write the ending: exactly ${sentences} ${s} that continue seamlessly from the final sentence above ` +
        `and bring the story to a satisfying close. Prose only.`
    );
}

// ---- Generation state ----------------------------------------------------

let busy = false;
let currentAbort = null;

function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

// Push a UI event to the page. Failures are non-fatal: the authoritative story
// text is returned from generateStory(), so a dropped UI update never corrupts it.
async function push(method, payload) {
    if (!webview) return;
    try {
        await webview.eval(`window.sm && window.sm.${method}(${JSON.stringify(payload)})`, { timeoutMs: 8000 });
    } catch {
        // ignore transient page-eval failures
    }
}

async function generateStory({ starter, modelA, modelB, sentences, turns, conclude, concludeMultiplier }) {
    if (busy) return { ok: false, error: "A story is already being woven." };
    busy = true;
    const abort = new AbortController();
    currentAbort = abort;

    starter = String(starter ?? "").trim();
    sentences = clampInt(sentences, 1, 10, 2);
    turns = clampInt(turns, 1, 25, 3);
    conclude = conclude === undefined ? true : !!conclude;
    concludeMultiplier = clampInt(concludeMultiplier, 1, 4, 2);

    try {
        if (!starter) throw new Error("Please provide some starter text to begin the story.");
        if (!modelA || !modelB) throw new Error("Please choose an Ollama model for each author.");

        let story = starter;
        let index = 0;
        const authors = [
            { key: "A", label: "Author A", model: modelA },
            { key: "B", label: "Author B", model: modelB },
        ];

        // Streams one segment, pushing coalesced token deltas to the page.
        const streamSegment = async (segIndex, model, system, prompt, effSentences) => {
            let segText = "";
            let pending = "";
            const flush = async () => {
                if (!pending) return;
                const text = pending;
                pending = "";
                await push("onToken", { index: segIndex, text });
            };
            for await (const piece of streamChat({ model, system, prompt, sentences: effSentences, signal: abort.signal })) {
                segText += piece;
                pending += piece;
                if (pending.length >= 16) await flush();
            }
            await flush();
            return segText.trim();
        };

        for (let turn = 1; turn <= turns; turn++) {
            for (const author of authors) {
                if (abort.signal.aborted) throw new Error("__stopped__");
                index += 1;
                const segIndex = index;
                await push("onSegmentStart", {
                    index: segIndex,
                    kind: "author",
                    participant: author.key,
                    model: author.model,
                    turn,
                    totalTurns: turns,
                });

                const segText = await streamSegment(
                    segIndex,
                    author.model,
                    buildSystem(author.label, sentences),
                    buildPrompt(story, sentences),
                    sentences,
                );
                if (!segText) {
                    await push("onSegmentEmpty", { index: segIndex });
                } else {
                    story += `\n\n${segText}`;
                }
                await push("onSegmentEnd", { index: segIndex });
            }
        }

        // The opening author (Author A) wraps up the story.
        if (conclude) {
            if (abort.signal.aborted) throw new Error("__stopped__");
            const author = authors[0];
            const concludeSentences = Math.min(40, sentences * concludeMultiplier);
            index += 1;
            const segIndex = index;
            await push("onSegmentStart", {
                index: segIndex,
                kind: "conclusion",
                participant: author.key,
                model: author.model,
            });

            const segText = await streamSegment(
                segIndex,
                author.model,
                buildConcludeSystem(author.label, concludeSentences),
                buildConcludePrompt(story, concludeSentences),
                concludeSentences,
            );
            if (!segText) {
                await push("onSegmentEmpty", { index: segIndex });
            } else {
                story += `\n\n${segText}`;
            }
            await push("onSegmentEnd", { index: segIndex });
        }

        await push("onComplete", {});
        return { ok: true, fullText: story };
    } catch (err) {
        const stopped = abort.signal.aborted || err?.message === "__stopped__" || err?.name === "AbortError";
        const message = stopped ? "Generation stopped." : err?.message || String(err);
        await push("onError", { message, stopped });
        return { ok: false, error: message, stopped };
    } finally {
        busy = false;
        currentAbort = null;
    }
}

// ---- File saving ---------------------------------------------------------

function yamlStr(value) {
    return (
        '"' +
        String(value)
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/[\u0000-\u001f]+/g, " ")
            .trim() +
        '"'
    );
}

// Builds a YAML front matter block describing how the story was generated.
function buildFrontMatter(meta) {
    if (!meta || typeof meta !== "object") return "";
    const sentences = clampInt(meta.sentences, 1, 10, 2);
    const turns = clampInt(meta.turns, 1, 25, 3);
    const conclude = !!meta.conclude;
    const title = String(meta.title || meta.starter || "").split("\n")[0].trim().slice(0, 80);

    const lines = ["---"];
    if (title) lines.push(`title: ${yamlStr(title)}`);
    lines.push("generator: Storymaker");
    lines.push(`created: ${yamlStr(meta.createdAt || new Date().toISOString())}`);
    lines.push(`author_a_model: ${yamlStr(meta.modelA || "")}`);
    lines.push(`author_b_model: ${yamlStr(meta.modelB || "")}`);
    lines.push(`sentences_per_turn: ${sentences}`);
    lines.push(`turns: ${turns}`);
    lines.push(`conclusion: ${conclude}`);
    if (conclude) {
        const mult = clampInt(meta.concludeMultiplier, 1, 4, 2);
        lines.push(`conclusion_length: ${yamlStr(`${mult}x`)}`);
        lines.push(`conclusion_sentences: ${Math.min(40, sentences * mult)}`);
    }
    lines.push(`ollama_host: ${yamlStr(OLLAMA)}`);
    lines.push("---");
    return lines.join("\n") + "\n\n";
}

async function saveStory({ filename, content, meta }) {
    try {
        content = String(content ?? "");
        if (!content.trim()) throw new Error("There is no story to save yet.");

        let name = String(filename ?? "").trim();
        name = name.replace(/[\u0000-\u001f]/g, "").replace(/[/\\]+/g, "_");
        name = basename(name).trim();
        // Strip characters that are invalid in Windows filenames.
        name = name.replace(/[<>:"|?*]/g, "_");
        if (!name || name === "." || name === "..") name = `story-${Date.now()}.txt`;
        // Guard Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9).
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) name = `story-${name}`;
        if (name.length > 120) name = name.slice(0, 120);
        if (!/\.[a-z0-9]+$/i.test(name)) name += ".txt";

        const body = content.endsWith("\n") ? content : content + "\n";
        const fileText = buildFrontMatter(meta) + body;

        // Default the dialog to the directory used last time, falling back to cwd.
        const state = await loadState();
        let defaultDir = state.lastSaveDir ? String(state.lastSaveDir) : "";
        if (!(await isDirectory(defaultDir))) defaultDir = process.cwd();

        let target;
        try {
            target = await osSaveDialog({ defaultName: name, defaultDir });
        } catch (err) {
            return { ok: false, error: `Could not open the save dialog: ${err?.message || err}` };
        }
        if (!target) return { ok: false, canceled: true };

        await writeFile(target, fileText, "utf8");
        await saveStatePatch({ lastSaveDir: dirname(target) });
        await session?.log(`Storymaker saved the story to ${target}`);
        return { ok: true, path: target };
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
}

// ---- Wire up the webview + session --------------------------------------

webview = new CopilotWebview({
    extensionName: "storymaker",
    contentDir: join(import.meta.dirname, "content"),
    title: "Storymaker",
    width: 1588,
    height: 1280,
    callbacks: {
        listModels: async () => {
            try {
                return { ok: true, models: await listOllamaModels() };
            } catch (err) {
                return {
                    ok: false,
                    error: `Could not reach Ollama at ${OLLAMA}. Is it running? (${err?.message || err})`,
                };
            }
        },
        generateStory,
        cancel: () => {
            if (currentAbort) currentAbort.abort();
            return { ok: true };
        },
        saveStory,
        copyStory: async ({ text } = {}) => {
            const story = String(text ?? "");
            if (!story.trim()) return { ok: false, error: "There is no story to copy yet." };
            try {
                await osClipboardCopy(story);
                return { ok: true, chars: story.length };
            } catch (err) {
                return { ok: false, error: err?.message || String(err) };
            }
        },
        revealPath: async ({ path } = {}) => {
            const target = String(path ?? "");
            if (!target) return { ok: false, error: "There is no saved file to reveal yet." };
            try {
                await osRevealPath(target);
                return { ok: true };
            } catch (err) {
                return { ok: false, error: err?.message || String(err) };
            }
        },
        clipboardWrite: async ({ text } = {}) => {
            try {
                await osClipboardCopy(String(text ?? ""));
                return { ok: true };
            } catch (err) {
                return { ok: false, error: err?.message || String(err) };
            }
        },
        clipboardRead: async () => {
            try {
                return { ok: true, text: await osClipboardPaste() };
            } catch (err) {
                return { ok: false, error: err?.message || String(err) };
            }
        },
        log: (msg, opts) => session?.log(msg, opts),
    },
});

session = await joinSession({
    tools: webview.tools,
    commands: [
        {
            name: "storymaker",
            description: "Open Storymaker — weave a collaborative story from two local Ollama models.",
            handler: () => webview.show(),
        },
    ],
    hooks: { onSessionEnd: webview.close },
});
