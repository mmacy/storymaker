// Storymaker — two local Ollama models take turns extending a single story.
// All model orchestration happens here in the extension; the page drives it via
// `copilot.*` callbacks and receives live tokens pushed back via `window.sm.*`.
import { joinSession } from "@github/copilot-sdk/extension";
import { join, basename } from "node:path";
import { writeFile, access } from "node:fs/promises";
import { CopilotWebview } from "./lib/copilot-webview.js";

const OLLAMA = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/+$/, "");

let session;
let webview;

// ---- Ollama client -------------------------------------------------------

async function listOllamaModels() {
    const res = await fetch(`${OLLAMA}/api/tags`);
    if (!res.ok) throw new Error(`Ollama responded with HTTP ${res.status}`);
    const data = await res.json();
    return (data.models || [])
        .map((m) => m.name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
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

async function uniquePath(dir, name) {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let candidate = name;
    for (let i = 1; i < 1000; i++) {
        try {
            await access(join(dir, candidate));
            candidate = `${stem}-${i}${ext}`;
        } catch {
            return join(dir, candidate);
        }
    }
    return join(dir, `${stem}-${Date.now()}${ext}`);
}

async function saveStory({ filename, content }) {
    try {
        content = String(content ?? "");
        if (!content.trim()) throw new Error("There is no story to save yet.");

        let name = String(filename ?? "").trim();
        name = name.replace(/[\u0000-\u001f]/g, "").replace(/[/\\]+/g, "_");
        name = basename(name).trim();
        if (!name || name === "." || name === "..") name = `story-${Date.now()}.txt`;
        if (name.length > 120) name = name.slice(0, 120);
        if (!/\.[a-z0-9]+$/i.test(name)) name += ".txt";

        const target = await uniquePath(process.cwd(), name);
        await writeFile(target, content.endsWith("\n") ? content : content + "\n", "utf8");
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
        log: (msg, opts) => session?.log(msg, opts),
    },
});

session = await joinSession({
    tools: webview.tools,
    commands: [
        {
            name: "storymaker",
            description: "Open Storymaker — weave a collaborative story from two local Ollama models.",
            handler: webview.show,
        },
    ],
    hooks: { onSessionEnd: webview.close },
});
