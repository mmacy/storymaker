// Storymaker — two local Ollama models take turns extending a single story.
// All model orchestration happens here in the extension; the page drives it via
// `copilot.*` callbacks and receives live tokens pushed back via `window.sm.*`.
import { joinSession } from "@github/copilot-sdk/extension";
import { join, basename, dirname } from "node:path";
import { writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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

// Serialize state writes so concurrent patches (lastVoice, autoNarrate,
// lastSaveDir) can't clobber each other via interleaved read-modify-write.
let stateWriteChain = Promise.resolve();
function saveStatePatch(patch) {
    stateWriteChain = stateWriteChain.then(async () => {
        try {
            const next = { ...(await loadState()), ...patch };
            await mkdir(STATE_DIR, { recursive: true });
            await writeFile(STATE_FILE, JSON.stringify(next, null, 2), "utf8");
        } catch (err) {
            await session?.log(`Storymaker: could not persist state (${err?.message || err}).`);
        }
    });
    return stateWriteChain;
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
// PowerShell SaveFileDialog, Linux tries zenity then kdialog. `title` labels the
// dialog and `kind` ("text" | "audio") picks the file-type filter where the
// platform supports one.
async function osSaveDialog({ defaultName, defaultDir, title = "Save story", kind = "text" }) {
    const name = String(defaultName || "story.txt");
    let dir = String(defaultDir || "");
    if (!(await isDirectory(dir))) dir = "";

    const winFilter = kind === "audio"
        ? "WAV audio (*.wav)|*.wav|All files (*.*)|*.*"
        : "Text files (*.txt)|*.txt|All files (*.*)|*.*";
    const linuxPattern = kind === "audio" ? "*.wav" : "*.txt";

    if (process.platform === "darwin") {
        const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const loc = dir ? ` default location POSIX file "${esc(dir)}"` : "";
        const script =
            `set theFile to choose file name with prompt "${esc(title)}" default name "${esc(name)}"${loc}\n` +
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
            `$d.Title = '${q(title)}';$d.FileName = '${q(name)}';${initDir}` +
            `$d.Filter = '${q(winFilter)}';$d.OverwritePrompt = $true;` +
            "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) } else { exit 2 }";
        const r = await runCapture("powershell", ["-NoProfile", "-STA", "-Command", script], { timeout: 300000 });
        if (r.code === 0) return r.stdout.trim() || null;
        if (r.code === 2) return null;
        throw new Error(r.stderr.trim() || `powershell exited with code ${r.code}`);
    }

    const base = dir ? `${dir.replace(/\/+$/, "")}/${name}` : name;
    const candidates = [
        ["zenity", ["--file-selection", "--save", "--confirm-overwrite", `--title=${title}`, `--filename=${base}`]],
        ["kdialog", ["--getsavefilename", base, linuxPattern]],
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

// Narration runs independently of story generation (it reads a finished story
// aloud), so it has its own busy flag and abort controller.
let narrating = false;
let narrationAbort = null;

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
    if (busy) return { ok: false, error: "A story is already being woven.", timing: null };
    busy = true;
    const abort = new AbortController();
    currentAbort = abort;

    starter = String(starter ?? "").trim();
    sentences = clampInt(sentences, 1, 10, 2);
    turns = clampInt(turns, 1, 25, 3);
    conclude = conclude === undefined ? true : !!conclude;
    concludeMultiplier = clampInt(concludeMultiplier, 1, 4, 2);

    // Generation timing, surfaced in the saved file's front matter for later
    // analysis (model speed, effect of turn count / conclusion length on time).
    // turnMs holds per-author durations for regular turns only; the conclusion is
    // tracked separately so it doesn't skew the per-turn averages.
    const genStart = Date.now();
    const turnMs = { A: [], B: [] };
    let concludeMs = null;
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const buildTiming = () => {
        const end = Date.now();
        return {
            startedAt: new Date(genStart).toISOString(),
            endedAt: new Date(end).toISOString(),
            totalMs: end - genStart,
            authorA: { turns: turnMs.A.length, avgTurnMs: avg(turnMs.A) },
            authorB: { turns: turnMs.B.length, avgTurnMs: avg(turnMs.B) },
            concludeMs,
        };
    };

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

                const segStart = Date.now();
                const segText = await streamSegment(
                    segIndex,
                    author.model,
                    buildSystem(author.label, sentences),
                    buildPrompt(story, sentences),
                    sentences,
                );
                turnMs[author.key].push(Date.now() - segStart);
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

            const segStart = Date.now();
            const segText = await streamSegment(
                segIndex,
                author.model,
                buildConcludeSystem(author.label, concludeSentences),
                buildConcludePrompt(story, concludeSentences),
                concludeSentences,
            );
            concludeMs = Date.now() - segStart;
            if (!segText) {
                await push("onSegmentEmpty", { index: segIndex });
            } else {
                story += `\n\n${segText}`;
            }
            await push("onSegmentEnd", { index: segIndex });
        }

        await push("onComplete", {});
        return { ok: true, fullText: story, timing: buildTiming() };
    } catch (err) {
        const stopped = abort.signal.aborted || err?.message === "__stopped__" || err?.name === "AbortError";
        const message = stopped ? "Generation stopped." : err?.message || String(err);
        await push("onError", { message, stopped });
        return { ok: false, error: message, stopped, timing: buildTiming() };
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

    // Generation timing (extension-measured) for later analysis. Seconds are
    // rounded to millisecond precision; per-author averages cover regular turns
    // only, with the conclusion reported separately. generation_status lets
    // analysis distinguish complete runs from stopped/error partials.
    if (meta.generationStatus) lines.push(`generation_status: ${yamlStr(meta.generationStatus)}`);
    const t = meta.timing;
    if (t && typeof t === "object") {
        const secs = (ms) => Math.round(Number(ms)) / 1000;
        const turnCount = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
        if (t.startedAt) lines.push(`generation_started: ${yamlStr(t.startedAt)}`);
        if (t.endedAt) lines.push(`generation_ended: ${yamlStr(t.endedAt)}`);
        if (Number.isFinite(t.totalMs)) lines.push(`generation_seconds: ${secs(t.totalMs)}`);
        if (t.authorA && typeof t.authorA === "object") {
            lines.push(`author_a_turns: ${turnCount(t.authorA.turns)}`);
            if (Number.isFinite(t.authorA.avgTurnMs)) {
                lines.push(`author_a_avg_turn_seconds: ${secs(t.authorA.avgTurnMs)}`);
            }
        }
        if (t.authorB && typeof t.authorB === "object") {
            lines.push(`author_b_turns: ${turnCount(t.authorB.turns)}`);
            if (Number.isFinite(t.authorB.avgTurnMs)) {
                lines.push(`author_b_avg_turn_seconds: ${secs(t.authorB.avgTurnMs)}`);
            }
        }
        if (Number.isFinite(t.concludeMs)) lines.push(`conclusion_seconds: ${secs(t.concludeMs)}`);
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

// ---- Kokoro narration ----------------------------------------------------
// Text-to-speech runs entirely in the extension (like the Ollama loop): the
// page never touches the model. kokoro-js loads the 82M Kokoro model via
// onnxruntime-node and synthesizes 24 kHz mono audio on the CPU. The model is
// loaded lazily on first narration and the download is cached under
// ~/.storymaker/models so it survives `npm install`/reinstalls.

const TTS_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const TTS_DTYPE = "q8"; // ~103 MB; good quality/size tradeoff for narration.
const TTS_SAMPLE_RATE = 24000;
const DEFAULT_VOICE = "af_heart";

// A curated, friendly subset of Kokoro's voices (the engine still accepts any of
// its 28 voice ids). Ordered best-first within each accent/gender group.
const VOICES = [
    { id: "af_heart", label: "Heart · US female ★" },
    { id: "af_bella", label: "Bella · US female" },
    { id: "af_nicole", label: "Nicole · US female" },
    { id: "af_aoede", label: "Aoede · US female" },
    { id: "af_kore", label: "Kore · US female" },
    { id: "af_sarah", label: "Sarah · US female" },
    { id: "am_michael", label: "Michael · US male" },
    { id: "am_puck", label: "Puck · US male" },
    { id: "am_fenrir", label: "Fenrir · US male" },
    { id: "am_onyx", label: "Onyx · US male" },
    { id: "bf_emma", label: "Emma · UK female" },
    { id: "bf_isabella", label: "Isabella · UK female" },
    { id: "bm_george", label: "George · UK male" },
    { id: "bm_fable", label: "Fable · UK male" },
];

let ttsPromise = null; // memoized KokoroTTS instance (load once).
let kokoroModulePromise = null; // memoized dynamic import of kokoro-js.

function loadKokoro() {
    if (!kokoroModulePromise) kokoroModulePromise = import("kokoro-js");
    return kokoroModulePromise;
}

// Load (and cache) the Kokoro model. `onStatus(text)` receives coarse progress
// while the model downloads/initializes on first use.
async function getTTS(onStatus) {
    if (ttsPromise) return ttsPromise;
    ttsPromise = (async () => {
        const [{ KokoroTTS }, { env }] = await Promise.all([
            loadKokoro(),
            import("@huggingface/transformers"),
        ]);
        // Persist the model download outside node_modules so it isn't wiped on
        // reinstall. Non-fatal if it can't be set (falls back to the default).
        try {
            const modelsDir = join(STATE_DIR, "models");
            await mkdir(modelsDir, { recursive: true });
            env.cacheDir = modelsDir;
        } catch {}
        let lastPct = -1;
        const progress_callback = (p) => {
            if (!onStatus || !p) return;
            if (p.status === "progress" && Number.isFinite(p.progress)) {
                const pct = Math.floor(p.progress);
                if (pct >= lastPct + 5) {
                    lastPct = pct;
                    onStatus(`Downloading narration voice model… ${pct}%`, pct);
                }
            }
        };
        onStatus?.("Loading narration voice model…");
        return KokoroTTS.from_pretrained(TTS_MODEL_ID, {
            dtype: TTS_DTYPE,
            device: "cpu",
            progress_callback,
        });
    })().catch((err) => {
        ttsPromise = null; // allow a later retry after a failed load
        throw err;
    });
    return ttsPromise;
}

// Encode mono float32 PCM samples as a 16-bit WAV file (Buffer).
function floatsToWav(samples, sampleRate) {
    const n = samples.length;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write("RIFF", 0, "ascii");
    buf.writeUInt32LE(36 + n * 2, 4);
    buf.write("WAVE", 8, "ascii");
    buf.write("fmt ", 12, "ascii");
    buf.writeUInt32LE(16, 16); // PCM fmt chunk size
    buf.writeUInt16LE(1, 20); // audio format = PCM
    buf.writeUInt16LE(1, 22); // channels = mono
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
    buf.writeUInt16LE(2, 32); // block align
    buf.writeUInt16LE(16, 34); // bits per sample
    buf.write("data", 36, "ascii");
    buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
        let s = Math.max(-1, Math.min(1, samples[i]));
        s = s < 0 ? s * 0x8000 : s * 0x7fff;
        buf.writeInt16LE(s | 0, 44 + i * 2);
    }
    return buf;
}

function narrationKey(text, voice) {
    return createHash("sha1").update(`${voice}\n${text}`).digest("hex");
}

// Holds the most recently synthesized narration so "Save audio" can write it
// without the page re-sending several MB of base64 back to the extension.
let lastNarration = null; // { key, wav: Buffer, durationSec }

// Synthesize `text` with `voice`, pre-splitting into sentences and pushing each
// sentence's audio to the page as base64 WAV (window.sm.onNarrationChunk) with a
// running total for the progress bar. The full WAV is retained in `lastNarration`
// only on full success (not when stopped) so a stopped/partial run can't be
// saved. `requestId` is echoed in every pushed event so the page can ignore
// events from a superseded run. Returns { ok, requestId, key, durationSec }.
async function narrate({ text, voice, requestId } = {}) {
    text = String(text ?? "").trim();
    voice = String(voice || DEFAULT_VOICE);
    const rid = requestId;
    const pushN = (method, payload) => push(method, { ...payload, requestId: rid });
    if (!text) return { ok: false, error: "There is no story to narrate yet.", requestId: rid };
    if (narrating) return { ok: false, error: "Narration is already in progress.", requestId: rid };

    narrating = true;
    const abort = new AbortController();
    narrationAbort = abort;
    const key = narrationKey(text, voice);
    const chunks = []; // Float32Array per sentence, for the saved full WAV
    let stopped = false;

    try {
        await pushN("onNarrationStatus", { message: "Preparing narration…" });
        const [tts, { TextSplitterStream }] = await Promise.all([
            getTTS((message, loadProgress) => pushN("onNarrationStatus", { message, loadProgress })),
            loadKokoro(),
        ]);
        if (abort.signal.aborted) throw new Error("__stopped__");

        // Pre-split into sentences so the total is known up front (for the
        // progress bar) and to avoid the streaming splitter's open-stream hang.
        const splitter = new TextSplitterStream();
        splitter.push(text);
        splitter.close();
        const sentences = [];
        for await (const sent of splitter) {
            const s = String(sent).trim();
            if (s) sentences.push(s);
        }

        await pushN("onNarrationStart", { voice, total: sentences.length });
        for (let i = 0; i < sentences.length; i++) {
            if (abort.signal.aborted) { stopped = true; break; }
            const audio = await tts.generate(sentences[i], { voice });
            // Re-check after the (non-abortable) generate so a stop during the
            // final sentence doesn't fall through as a successful run.
            if (abort.signal.aborted) { stopped = true; break; }
            const hasAudio = !!audio?.audio?.length;
            if (hasAudio) chunks.push(audio.audio);
            // Push one event per sentence (null WAV for a silent/empty sentence)
            // so the page's progress reaches total even when a sentence is empty.
            const wavBase64 = hasAudio ? Buffer.from(audio.toWav()).toString("base64") : null;
            await pushN("onNarrationChunk", { seq: i, total: sentences.length, wavBase64 });
        }

        if (stopped) return { ok: false, stopped: true, requestId: rid };

        // Concatenate every sentence into one WAV for saving/replay. Only retain
        // it on full success so a stopped/partial run is never saveable.
        const total = chunks.reduce((a, c) => a + c.length, 0);
        if (total > 0) {
            const all = new Float32Array(total);
            let off = 0;
            for (const c of chunks) { all.set(c, off); off += c.length; }
            const wav = floatsToWav(all, TTS_SAMPLE_RATE);
            const durationSec = total / TTS_SAMPLE_RATE;
            lastNarration = { key, wav, durationSec };
            await saveStatePatch({ lastVoice: voice });
            return { ok: true, requestId: rid, key, durationSec };
        }

        return { ok: false, error: "The narrator produced no audio for this story.", requestId: rid };
    } catch (err) {
        const wasStopped = abort.signal.aborted || err?.message === "__stopped__";
        const message = wasStopped
            ? "Narration stopped."
            : `Narration failed: ${err?.message || err}`;
        await pushN("onNarrationError", { message, stopped: wasStopped });
        return { ok: false, error: message, stopped: wasStopped, requestId: rid };
    } finally {
        narrating = false;
        narrationAbort = null;
    }
}

// Sanitize a user-supplied download name and force the given extension.
function safeFilename(name, ext, fallbackStem) {
    let n = String(name ?? "").replace(/[\u0000-\u001f]/g, "").replace(/[/\\]+/g, "_");
    n = basename(n).trim().replace(/[<>:"|?*]/g, "_");
    if (!n || n === "." || n === "..") n = `${fallbackStem}-${Date.now()}`;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(n)) n = `${fallbackStem}-${n}`;
    if (n.length > 120) n = n.slice(0, 120);
    n = n.replace(/\.[a-z0-9]+$/i, "");
    return `${n}.${ext}`;
}

// Write the most recent narration to a WAV file via the native Save dialog.
async function saveAudio({ filename, key } = {}) {
    try {
        if (!lastNarration?.wav?.length) {
            return { ok: false, error: "Narrate the story first, then save the audio." };
        }
        // Guard against saving audio that no longer matches what the page shows
        // (e.g. a later run changed it). The page passes the key it last cached.
        if (key && lastNarration.key !== key) {
            return { ok: false, error: "The narration audio is out of date — generate it again." };
        }
        const name = safeFilename(filename || "narration.wav", "wav", "narration");

        const state = await loadState();
        let defaultDir = state.lastSaveDir ? String(state.lastSaveDir) : "";
        if (!(await isDirectory(defaultDir))) defaultDir = process.cwd();

        let target;
        try {
            target = await osSaveDialog({
                defaultName: name,
                defaultDir,
                title: "Save narration audio",
                kind: "audio",
            });
        } catch (err) {
            return { ok: false, error: `Could not open the save dialog: ${err?.message || err}` };
        }
        if (!target) return { ok: false, canceled: true };

        await writeFile(target, lastNarration.wav);
        await saveStatePatch({ lastSaveDir: dirname(target) });
        await session?.log(`Storymaker saved narration audio to ${target}`);
        return { ok: true, path: target };
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
}

// ---- Filename suggestion -------------------------------------------------

// Ask `model` (Author A's model) to invent a short title for the finished story.
// The page slugifies the result and uses it as the default name for both the
// .txt and the .wav files. Best-effort: returns { ok:false } on any failure so
// the page can fall back to a model-name slug.
async function suggestFilename({ text, model } = {}) {
    text = String(text ?? "").trim();
    model = String(model || "");
    if (!text) return { ok: false, error: "There is no story to name yet." };
    if (!model) return { ok: false, error: "No model was provided." };

    const system =
        "You create a short, evocative title for a story. Reply with ONLY the title: " +
        "2 to 5 words, in Title Case, with no quotation marks, no trailing punctuation, " +
        "and no extra commentary.";
    const prompt = `Story:\n\n${text.slice(0, 6000)}\n\nTitle:`;

    const call = async (think) => {
        const body = {
            model,
            stream: false,
            messages: [
                { role: "system", content: system },
                { role: "user", content: prompt },
            ],
            options: { temperature: 0.7, top_p: 0.9, num_predict: 24 },
        };
        if (think === false) body.think = false;
        const res = await fetch(`${OLLAMA}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(30000),
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const t = await res.text().catch(() => "");
            const err = new Error(`Ollama /api/chat failed (HTTP ${res.status})`);
            err.body = t;
            throw err;
        }
        return res.json();
    };

    try {
        let data;
        try {
            data = await call(false);
        } catch (err) {
            // Some models reject the `think` flag; retry without it.
            if (/think/i.test(err?.body || err?.message || "")) data = await call(undefined);
            else throw err;
        }
        // Use the first non-empty line; ignore any `thinking` field entirely.
        const raw = String(data?.message?.content || "");
        const title = raw.split("\n").map((s) => s.trim()).find(Boolean) || "";
        return { ok: true, title };
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
        listVoices: async () => {
            const state = await loadState();
            const lastVoice = VOICES.some((v) => v.id === state.lastVoice)
                ? state.lastVoice
                : DEFAULT_VOICE;
            return {
                ok: true,
                voices: VOICES,
                defaultVoice: DEFAULT_VOICE,
                lastVoice,
                autoNarrate: !!state.autoNarrate,
            };
        },
        narrate,
        cancelNarration: () => {
            if (narrationAbort) narrationAbort.abort();
            return { ok: true };
        },
        setAutoNarrate: async ({ value } = {}) => {
            await saveStatePatch({ autoNarrate: !!value });
            return { ok: true };
        },
        saveAudio,
        saveStory,
        suggestFilename,
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
