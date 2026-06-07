// Storymaker page logic. window.copilot is provided by /__bridge.js.
// The extension drives generation and pushes live updates via window.sm.*.

const $ = (id) => document.getElementById(id);
const els = {
  ollamaStatus: $("ollama-status"),
  starter: $("starter"),
  modelA: $("modelA"),
  modelB: $("modelB"),
  sentences: $("sentences"),
  turns: $("turns"),
  concludeToggle: $("concludeToggle"),
  concludeMultiplier: $("concludeMultiplier"),
  concludeRow: $("conclude-row"),
  concludeHint: $("conclude-hint"),
  weave: $("weave"),
  stop: $("stop"),
  status: $("status"),
  story: $("story"),
  emptyState: $("empty-state"),
  filename: $("filename"),
  save: $("save"),
  copy: $("copy"),
  voice: $("voice"),
  narrate: $("narrate"),
  narrateStop: $("narrateStop"),
  saveAudio: $("saveAudio"),
  autoNarrate: $("autoNarrate"),
  includeStarter: $("includeStarter"),
  progressWrap: $("narr-progress"),
  progressFill: $("narr-progress-fill"),
  narrationStatus: $("narration-status"),
  narrationAudio: $("narration-audio"),
};

const state = {
  starterText: "",
  segments: new Map(), // index -> { textEl, segEl, plain }
  activeIndex: null,
  generating: false,
};

// ---- helpers -------------------------------------------------------------

function setStatus(msg, kind) {
  els.status.textContent = msg || "";
  els.status.className = "status" + (kind ? " " + kind : "");
}

function nearBottom() {
  const e = els.story;
  return e.scrollHeight - e.scrollTop - e.clientHeight < 140;
}
function autoScroll(force) {
  if (force || nearBottom()) els.story.scrollTop = els.story.scrollHeight;
}

function hideEmptyState() {
  if (els.emptyState && els.emptyState.parentNode) els.emptyState.remove();
}

function clearStory() {
  state.segments.clear();
  state.activeIndex = null;
  els.story.innerHTML = "";
  els.save.disabled = true;
  els.copy.disabled = true;
  resetNarration();
}

function assembleStory() {
  const parts = [state.starterText];
  const indices = [...state.segments.keys()].sort((a, b) => a - b);
  for (const i of indices) parts.push(state.segments.get(i).plain);
  return parts.map((p) => (p || "").trim()).filter(Boolean).join("\n\n");
}

// The text to narrate. The starter is included only when the "Include starter
// text" box is checked (default off), so by default only the authored segments
// are read aloud.
function narrationText() {
  const parts = [];
  if (els.includeStarter && els.includeStarter.checked) parts.push(state.starterText);
  const indices = [...state.segments.keys()].sort((a, b) => a - b);
  for (const i of indices) parts.push(state.segments.get(i).plain);
  return parts.map((p) => (p || "").trim()).filter(Boolean).join("\n\n");
}

function refreshOutputButtons() {
  const has = assembleStory().length > 0;
  // Keep Save disabled while generating: the timing metadata isn't available
  // until generateStory() returns, so a mid-flight save would lack it.
  els.save.disabled = !has || state.generating;
  els.copy.disabled = !has;
  updateNarrationButtons();
}

// Build a segment block. `meta` = { kind:'starter'|'author', participant, model, turn, totalTurns }
function addSegmentBlock(meta) {
  const seg = document.createElement("div");
  if (meta.kind === "starter") {
    seg.className = "segment starter";
  } else if (meta.kind === "conclusion") {
    seg.className = "segment conclusion author-" + meta.participant;
  } else {
    seg.className = "segment author-" + meta.participant;
  }

  const metaRow = document.createElement("div");
  metaRow.className = "seg-meta";
  const chip = document.createElement("span");
  chip.className = "seg-chip";
  const swatch = document.createElement("span");
  swatch.className = "swatch";
  chip.appendChild(swatch);
  const chipLabel = document.createElement("span");
  if (meta.kind === "starter") {
    chipLabel.textContent = "Starter";
  } else if (meta.kind === "conclusion") {
    chipLabel.textContent = `Conclusion · Author ${meta.participant}`;
  } else {
    chipLabel.textContent = `Turn ${meta.turn}/${meta.totalTurns} · Author ${meta.participant}`;
  }
  chip.appendChild(chipLabel);
  metaRow.appendChild(chip);
  if (meta.model) {
    const model = document.createElement("span");
    model.className = "seg-model";
    model.textContent = meta.model;
    metaRow.appendChild(model);
  }

  const text = document.createElement("div");
  text.className = "seg-text";

  seg.appendChild(metaRow);
  seg.appendChild(text);
  els.story.appendChild(seg);
  return { segEl: seg, textEl: text };
}

function setCaret(segIndex, on) {
  const rec = state.segments.get(segIndex);
  if (!rec) return;
  const existing = rec.textEl.querySelector(".caret");
  if (on && !existing) {
    const c = document.createElement("span");
    c.className = "caret";
    rec.textEl.appendChild(c);
  } else if (!on && existing) {
    existing.remove();
  }
}

// ---- live update protocol (extension -> page) ----------------------------

window.sm = {
  onSegmentStart({ index, kind, participant, model, turn, totalTurns }) {
    hideEmptyState();
    const { segEl, textEl } = addSegmentBlock({
      kind: kind || "author",
      participant,
      model,
      turn,
      totalTurns,
    });
    state.segments.set(index, { segEl, textEl, plain: "" });
    state.activeIndex = index;
    setCaret(index, true);
    if (kind === "conclusion") {
      setStatus(`Author ${participant} (${model}) is writing the conclusion…`);
    } else {
      setStatus(`Turn ${turn} of ${totalTurns} · Author ${participant} (${model}) is writing…`);
    }
    autoScroll(true);
  },

  onToken({ index, text }) {
    const rec = state.segments.get(index);
    if (!rec) return;
    rec.plain += text;
    const caret = rec.textEl.querySelector(".caret");
    rec.textEl.insertBefore(document.createTextNode(text), caret || null);
    autoScroll(false);
  },

  onSegmentEmpty({ index }) {
    const rec = state.segments.get(index);
    if (!rec) return;
    rec.segEl.classList.add("empty");
    rec.textEl.textContent = "(This author returned no text for this turn.)";
  },

  onSegmentEnd({ index }) {
    setCaret(index, false);
    if (state.activeIndex === index) state.activeIndex = null;
    refreshOutputButtons();
  },

  onComplete() {
    if (state.activeIndex != null) setCaret(state.activeIndex, false);
    state.activeIndex = null;
    setStatus("Story complete.", "ok");
    refreshOutputButtons();
  },

  onError({ message, stopped }) {
    if (state.activeIndex != null) setCaret(state.activeIndex, false);
    state.activeIndex = null;
    setStatus(message || "Something went wrong.", stopped ? "" : "error");
    refreshOutputButtons();
  },

  // ---- narration (extension -> page) ----
  // Every event carries the requestId of the run that produced it; ignore any
  // event whose id doesn't match the current run (it was stopped/superseded).
  onNarrationStatus({ requestId, message, loadProgress }) {
    if (requestId !== narration.requestId) return;
    setNarrationStatus(message || "");
    if (typeof loadProgress === "number") {
      narration.phase = "loading";
      showProgress(true);
      setProgress(loadProgress / 100, false);
    }
  },
  onNarrationStart({ requestId, total }) {
    if (requestId !== narration.requestId) return;
    narration.phase = "generating";
    narration.total = Number(total) || 0;
    narration.received = 0;
    showProgress(true);
    setProgress(0, !narration.total); // indeterminate if total unknown
    setNarrationStatus(
      narration.total ? `Generating audio… 0/${narration.total}` : "Generating audio…"
    );
    updateNarrationButtons();
  },
  onNarrationChunk({ requestId, wavBase64 }) {
    if (requestId !== narration.requestId) return;
    enqueueChunk(requestId, wavBase64);
    narration.received = Math.min((narration.received || 0) + 1, narration.total || Infinity);
    if (narration.total) {
      setProgress(narration.received / narration.total, false);
      setNarrationStatus(`Generating audio… ${narration.received}/${narration.total}`);
    }
  },
  onNarrationError({ requestId, message, stopped }) {
    if (requestId !== narration.requestId) return;
    handleNarrationError(message, stopped);
  },
};

// ---- setup / model list --------------------------------------------------

function populateSelect(select, models, preferIndex) {
  select.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    select.appendChild(opt);
  }
  if (models.length) {
    select.selectedIndex = Math.min(preferIndex, models.length - 1);
  }
}

async function loadModels() {
  els.ollamaStatus.textContent = "Connecting…";
  els.ollamaStatus.className = "pill";
  try {
    const res = await copilot.listModels();
    if (!res || !res.ok) throw new Error(res?.error || "Unknown error");
    if (!res.models.length) {
      els.ollamaStatus.textContent = "No models installed";
      els.ollamaStatus.className = "pill bad";
      setStatus("No Ollama models found. Pull one with `ollama pull <model>` and reopen.", "error");
      els.weave.disabled = true;
      els.modelA.innerHTML = '<option value="">(none)</option>';
      els.modelB.innerHTML = '<option value="">(none)</option>';
      return;
    }
    populateSelect(els.modelA, res.models, 0);
    populateSelect(els.modelB, res.models, 1);
    els.ollamaStatus.textContent = `Ollama · ${res.models.length} model${res.models.length === 1 ? "" : "s"}`;
    els.ollamaStatus.className = "pill ok";
    els.weave.disabled = false;
    if (!els.status.textContent) setStatus("Ready. Enter starter text and weave a story.");
  } catch (err) {
    els.ollamaStatus.textContent = "Ollama offline";
    els.ollamaStatus.className = "pill bad";
    setStatus(String(err.message || err), "error");
    els.weave.disabled = true;
  }
}

// ---- generation control --------------------------------------------------

function setGenerating(on) {
  state.generating = on;
  els.weave.hidden = on;
  els.stop.hidden = !on;
  els.starter.disabled = on;
  els.modelA.disabled = on;
  els.modelB.disabled = on;
  els.sentences.disabled = on;
  els.turns.disabled = on;
  els.concludeToggle.disabled = on;
  els.concludeMultiplier.disabled = on || !els.concludeToggle.checked;
  // Voice + narration buttons are managed by updateNarrationButtons().
  updateNarrationButtons();
}

// Reflect the conclusion settings: enable/disable the length picker and show the
// resulting sentence count (multiplier × sentences per turn).
function updateConcludeHint() {
  const on = els.concludeToggle.checked;
  els.concludeMultiplier.disabled = on ? false : true;
  els.concludeRow.classList.toggle("off", !on);
  let s = parseInt(els.sentences.value, 10);
  if (!Number.isFinite(s)) s = 2;
  s = Math.min(10, Math.max(1, s));
  const m = parseInt(els.concludeMultiplier.value, 10) || 2;
  const n = s * m;
  els.concludeHint.textContent = on
    ? `Author A ends the story with ${n} sentence${n === 1 ? "" : "s"}.`
    : "No conclusion — the story ends on Author B's last turn.";
}

function clampInput(input, min, max, fallback) {
  let n = parseInt(input.value, 10);
  if (!Number.isFinite(n)) n = fallback;
  n = Math.min(max, Math.max(min, n));
  input.value = String(n);
  return n;
}

async function weave() {
  const starter = els.starter.value.trim();
  const modelA = els.modelA.value;
  const modelB = els.modelB.value;
  const sentences = clampInput(els.sentences, 1, 10, 2);
  const turns = clampInput(els.turns, 1, 25, 3);
  const conclude = els.concludeToggle.checked;
  const concludeMultiplier = parseInt(els.concludeMultiplier.value, 10) || 2;

  if (!starter) {
    setStatus("Please enter some starter text first.", "error");
    els.starter.focus();
    return;
  }
  if (!modelA || !modelB) {
    setStatus("Please choose a model for each author.", "error");
    return;
  }

  state.starterText = starter;
  state.meta = {
    starter,
    modelA,
    modelB,
    sentences,
    turns,
    conclude,
    concludeMultiplier,
    createdAt: new Date().toISOString(),
  };
  // Cancel any in-flight narration/synthesis before resetting it, so the
  // extension stops the (CPU-heavy) TTS instead of racing the new story.
  if (narration.phase !== "idle" || narration.extBusy) {
    try { await copilot.cancelNarration(); } catch { /* ignore */ }
  }
  clearStory();
  hideEmptyState();
  // Echo the starter immediately so it is always part of the visible story.
  const { textEl } = addSegmentBlock({ kind: "starter" });
  textEl.textContent = starter;

  setGenerating(true);
  setStatus("Warming up the authors…");

  let autoGenerate = false;
  try {
    const res = await copilot.generateStory({ starter, modelA, modelB, sentences, turns, conclude, concludeMultiplier });
    if (res && res.timing) state.meta.timing = res.timing;
    if (res) state.meta.generationStatus = res.ok ? "complete" : res.stopped ? "stopped" : "error";
    if (res && res.ok) {
      setStatus("Story complete. You can copy or save it.", "ok");
      prefillFilename();
      autoGenerate = els.autoNarrate.checked;
    } else if (res && res.stopped) {
      setStatus("Generation stopped. Partial story kept.", "");
      prefillFilename();
    } else {
      setStatus(res?.error || "Generation failed.", "error");
    }
  } catch (err) {
    setStatus(String(err.message || err), "error");
  } finally {
    setGenerating(false);
    refreshOutputButtons();
  }

  // Auto-generate audio (silent) only after generation state is fully cleared,
  // so the synthesis sees state.generating === false.
  if (autoGenerate && narrationText()) generateNarration();
}

// Slugify arbitrary text to a safe filename stem (lowercase, alphanumeric +
// hyphens). Returns "" if nothing usable remains.
function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

function slugifyModel(model) {
  return slugify(model) || "story";
}

// Set the default filename stem shared by the .txt and .wav saves. Updates the
// visible .txt box only if the user hasn't edited the value we last filled, so a
// late model-generated title never clobbers a manual edit.
function applyDefaultFilename(base) {
  if (!base) return;
  state.meta = state.meta || {};
  state.meta.fileBase = base;
  const nextTxt = base + ".txt";
  if (!els.filename.value || els.filename.value === state.autoFilename) {
    els.filename.value = nextTxt;
  }
  state.autoFilename = nextTxt;
}

// Ask Author A's model to title the story, then use the slug as the default name
// for both the .txt and the .wav. Falls back to the model-name slug on failure.
async function suggestAndApplyFilename() {
  const text = assembleStory();
  const model = state.meta?.modelA;
  // Tie this request to the current story; if a newer weave starts before the
  // title comes back, ignore the stale response.
  const token = state.meta?.createdAt;
  if (!text || !model) return;
  let res;
  try {
    res = await copilot.suggestFilename({ text, model });
  } catch {
    res = null;
  }
  if (state.meta?.createdAt !== token) return; // superseded by a newer story
  if (res && res.ok && res.title) {
    const base = slugify(res.title).slice(0, 60).replace(/-+$/, "");
    if (base) applyDefaultFilename(base);
  }
}

function prefillFilename() {
  if (!assembleStory()) return;
  // Immediate model-name fallback, then upgrade to a model-generated title.
  applyDefaultFilename(slugifyModel(state.meta?.modelA));
  suggestAndApplyFilename();
}

async function stop() {
  els.stop.disabled = true;
  setStatus("Stopping…");
  try {
    await copilot.cancel();
  } catch {}
  els.stop.disabled = false;
}

// ---- output: copy / save -------------------------------------------------

async function copyStory() {
  const text = assembleStory();
  if (!text) return;
  // Copy from the extension (OS clipboard) instead of the webview's in-page
  // clipboard API, which is gesture-gated and unreliable in WKWebView.
  let res;
  try {
    res = await copilot.copyStory({ text });
  } catch (e) {
    res = { ok: false, error: e?.message || String(e) };
  }
  setStatus(
    res?.ok ? "Story copied to clipboard." : `Couldn't access the clipboard.${res?.error ? " " + res.error : ""}`,
    res?.ok ? "ok" : "error"
  );
}

async function saveStory() {
  const content = assembleStory();
  if (!content) return;
  let filename = els.filename.value.trim();
  if (!filename) filename = "story.txt";
  els.save.disabled = true;
  setStatus("Choose where to save…");
  try {
    const res = await copilot.saveStory({ filename, content, meta: state.meta });
    if (res && res.ok) {
      showSavedStatus(res.path);
    } else if (res && res.canceled) {
      setStatus("Save canceled.", "");
    } else {
      setStatus(res?.error || "Save failed.", "error");
    }
  } catch (err) {
    setStatus(String(err.message || err), "error");
  } finally {
    refreshOutputButtons();
  }
}

// Render the "Saved to <path>" status with the path as a link that reveals the
// file in the OS file manager. The path is set via textContent (never innerHTML)
// and the reveal happens through an extension callback, since the webview can't
// open Finder/Explorer itself.
function showSavedStatus(path) {
  els.status.className = "status ok";
  els.status.textContent = "Saved to ";
  const link = document.createElement("a");
  link.className = "path-link";
  link.href = "#";
  link.textContent = path;
  link.title = "Reveal this file in your file manager";
  link.addEventListener("click", async (e) => {
    e.preventDefault();
    let res;
    try {
      res = await copilot.revealPath({ path });
    } catch (err) {
      res = { ok: false, error: err?.message || String(err) };
    }
    if (!res?.ok) {
      setStatus(`Couldn't reveal the file.${res?.error ? " " + res.error : ""}`, "error");
    }
  });
  els.status.appendChild(link);
}

// ---- narration -----------------------------------------------------------
// The extension synthesizes the story with Kokoro TTS and streams each sentence
// back as a base64 WAV chunk (tagged with a requestId). We decode the chunks
// with the Web Audio API and cache the buffers. A single primary button drives
// everything: "Generate audio" (synthesize, no playback) when there's no audio
// for the current story+voice, "Play" once audio is ready. A progress bar tracks
// the model download, per-sentence synthesis, then playback. The extension keeps
// the full WAV server-side for "Save audio".

let narrationSeq = 0; // monotonic id; identifies the current narration run.

const narration = {
  requestId: 0, // id of the run whose events we currently accept
  phase: "idle", // "idle" | "loading" | "generating" | "playing"
  extBusy: false, // a narrate() call is in flight (incl. first model load)
  userStopped: false,
  total: 0, // sentences to synthesize (for the progress bar)
  received: 0, // sentences received so far
  buffers: [], // decoded AudioBuffers, in order, for playback/save
  sources: [], // currently scheduled AudioBufferSourceNodes
  chain: Promise.resolve(), // serializes async decodes into arrival order
  scheduled: 0,
  ended: 0,
  nextStartTime: 0, // Web Audio clock time for the next scheduled chunk
  playStartCtx: 0, // ctx time the first buffer starts (for playback progress)
  playDuration: 0, // total seconds of cached audio
  progressTimer: 0, // setInterval id for the playback progress loop
  haveAudio: false, // a COMPLETE run exists for cacheText/cacheVoice
  cacheText: "",
  cacheVoice: "",
  cacheKey: "", // server-side narration key for the cached audio (for saveAudio)
};

let audioCtx = null;

// Create the AudioContext without resuming it (safe outside a user gesture —
// used for silent decoding).
function ensureAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
  }
  return audioCtx;
}

// Create and resume the AudioContext — only call from a user gesture (Play).
function resumeAudioContext() {
  const ctx = ensureAudioContext();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

function setNarrationStatus(msg, kind) {
  els.narrationStatus.textContent = msg || "";
  els.narrationStatus.className = "narration-status" + (kind ? " " + kind : "");
}

// Progress bar: show/hide, and set a 0..1 fraction or an indeterminate state.
function showProgress(on) {
  els.progressWrap.hidden = !on;
  if (!on) {
    els.progressWrap.classList.remove("indeterminate");
    els.progressFill.style.width = "0%";
  }
}
function setProgress(fraction, indeterminate) {
  if (indeterminate) {
    els.progressWrap.classList.add("indeterminate");
    return;
  }
  els.progressWrap.classList.remove("indeterminate");
  const pct = Math.max(0, Math.min(1, fraction || 0)) * 100;
  els.progressFill.style.width = pct.toFixed(1) + "%";
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// Stop and discard all scheduled audio sources without touching decoded buffers.
function stopSources() {
  for (const src of narration.sources) {
    try { src.onended = null; src.stop(); } catch { /* already stopped */ }
  }
  narration.sources = [];
}

function scheduleBuffer(buffer) {
  const ctx = ensureAudioContext();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  const startAt = Math.max(ctx.currentTime + 0.02, narration.nextStartTime);
  src.start(startAt);
  narration.nextStartTime = startAt + buffer.duration;
  narration.scheduled += 1;
  narration.sources.push(src);
  src.onended = () => {
    narration.ended += 1;
    const i = narration.sources.indexOf(src);
    if (i >= 0) narration.sources.splice(i, 1);
    if (narration.phase === "playing" && narration.ended >= narration.scheduled) finishPlayback();
  };
}

// Decode one incoming WAV chunk and cache it (no playback — playback always
// happens from the cache via Play). The run's requestId is re-checked after the
// async decode so a superseded run drops late chunks. Decodes are chained to
// preserve arrival order.
function enqueueChunk(requestId, wavBase64) {
  if (!wavBase64) return;
  narration.chain = narration.chain.then(async () => {
    if (requestId !== narration.requestId) return;
    try {
      const ctx = ensureAudioContext();
      const buffer = await ctx.decodeAudioData(base64ToArrayBuffer(wavBase64));
      if (requestId !== narration.requestId) return;
      narration.buffers.push(buffer);
    } catch {
      /* skip an undecodable chunk rather than abort the whole narration */
    }
  });
}

function narrationCacheValid() {
  return (
    narration.haveAudio &&
    narration.cacheText === narrationText() &&
    narration.cacheVoice === els.voice.value
  );
}

// Render the single primary button + Stop + Save + voice + progress from the
// current phase. Labels: "Generate audio" / "Generating…" / "Play" / "Playing…".
function updateNarrationButtons() {
  const story = narrationText();
  const voice = els.voice.value;
  const cacheValid = narrationCacheValid();
  const phase = narration.phase;
  const idle = phase === "idle";

  let label, disabled;
  if (phase === "loading" || phase === "generating") {
    label = "Generating…";
    disabled = true;
  } else if (phase === "playing") {
    label = "Playing…";
    disabled = true;
  } else {
    label = cacheValid ? "Play" : "Generate audio";
    disabled = state.generating || narration.extBusy || !story || !voice;
  }
  els.narrate.textContent = label;
  els.narrate.disabled = disabled;

  els.narrateStop.hidden = idle;
  els.saveAudio.disabled = !cacheValid || !idle || narration.extBusy;
  els.voice.disabled = !idle || narration.extBusy;
  els.includeStarter.disabled = !idle || narration.extBusy;
  els.autoNarrate.disabled = state.generating;
}

// Forget any synthesized audio and supersede any in-flight run (e.g. when a new
// story is generated). The caller cancels extension-side synthesis first.
function resetNarration() {
  narrationSeq += 1;
  narration.requestId = narrationSeq;
  narration.phase = "idle";
  // Note: extBusy is intentionally NOT cleared here. It is owned by the in-flight
  // generateNarration(), which clears it when copilot.narrate() unwinds. Clearing
  // it here could re-enable the UI while the extension is still finishing a
  // canceled run (e.g. an un-abortable first-run model download).
  narration.userStopped = false;
  narration.total = 0;
  narration.received = 0;
  stopProgressTimer();
  stopSources();
  narration.buffers = [];
  narration.chain = Promise.resolve();
  narration.scheduled = 0;
  narration.ended = 0;
  narration.nextStartTime = 0;
  narration.haveAudio = false;
  narration.cacheText = "";
  narration.cacheVoice = "";
  narration.cacheKey = "";
  showProgress(false);
  setNarrationStatus("");
}

async function loadVoices() {
  let res;
  try {
    res = await copilot.listVoices();
  } catch {
    res = null;
  }
  if (!res || !res.ok || !Array.isArray(res.voices) || !res.voices.length) {
    els.voice.innerHTML = '<option value="">Voice unavailable</option>';
    return;
  }
  els.voice.innerHTML = "";
  for (const v of res.voices) {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.label || v.id;
    els.voice.appendChild(opt);
  }
  const want = res.lastVoice || res.defaultVoice;
  if (want && res.voices.some((v) => v.id === want)) els.voice.value = want;
  els.autoNarrate.checked = !!res.autoNarrate;
  updateNarrationButtons();
}

// The primary button: synthesize if there's no audio yet, otherwise play.
function narratePrimary() {
  if (narration.phase !== "idle") return;
  if (narrationCacheValid()) playNarration();
  else generateNarration();
}

// Synthesize the current story silently (no playback) and cache the audio.
async function generateNarration() {
  const story = narrationText();
  const voice = els.voice.value;
  if (!story || !voice || narration.phase !== "idle" || narration.extBusy) return;

  const requestId = ++narrationSeq;
  narration.requestId = requestId;
  narration.phase = "loading";
  narration.userStopped = false;
  narration.total = 0;
  narration.received = 0;
  stopProgressTimer();
  stopSources();
  narration.buffers = [];
  narration.chain = Promise.resolve();
  narration.scheduled = 0;
  narration.ended = 0;
  narration.haveAudio = false;
  narration.cacheText = story;
  narration.cacheVoice = voice;
  narration.cacheKey = "";
  ensureAudioContext(); // decode-only; don't resume outside a gesture
  setNarrationStatus("Preparing narration…");
  showProgress(true);
  setProgress(0, true); // indeterminate until first load%/sentence
  updateNarrationButtons();

  narration.extBusy = true;
  let res;
  try {
    res = await copilot.narrate({ text: story, voice, requestId });
  } catch (err) {
    res = { ok: false, error: err?.message || String(err) };
  }
  narration.extBusy = false;

  if (narration.requestId !== requestId) {
    // Superseded by Stop or a new story while we awaited the extension.
    updateNarrationButtons();
    return;
  }

  // Wait for every chunk to finish decoding before judging completion — decodes
  // resolve asynchronously after narrate() returns.
  try { await narration.chain; } catch { /* ignore */ }
  if (narration.requestId !== requestId) {
    updateNarrationButtons();
    return;
  }

  narration.phase = "idle";
  showProgress(false);
  if (res && res.ok) {
    narration.haveAudio = narration.buffers.length > 0;
    narration.cacheKey = narration.haveAudio ? (res.key || "") : "";
    setNarrationStatus(
      narration.haveAudio ? "Audio ready." : "No audio was produced.",
      narration.haveAudio ? "ok" : "error"
    );
    updateNarrationButtons();
  } else if (res && res.stopped) {
    discardNarration();
    setNarrationStatus("Narration stopped.");
    updateNarrationButtons();
  } else {
    handleNarrationError(res?.error || "Narration failed.", false);
  }
}

// Play the cached audio buffers, gapless, with a playback progress bar.
function playNarration() {
  if (!narrationCacheValid() || narration.phase !== "idle") return;
  const requestId = ++narrationSeq;
  narration.requestId = requestId;
  narration.phase = "playing";
  narration.userStopped = false;
  stopProgressTimer();
  stopSources();
  const ctx = resumeAudioContext();
  const startAt = ctx.currentTime + 0.05;
  narration.nextStartTime = startAt;
  narration.playStartCtx = startAt;
  narration.scheduled = 0;
  narration.ended = 0;
  let dur = 0;
  for (const buf of narration.buffers) {
    scheduleBuffer(buf);
    dur += buf.duration;
  }
  narration.playDuration = dur;
  if (narration.scheduled === 0) {
    finishPlayback();
    return;
  }
  showProgress(true);
  setProgress(0, false);
  setNarrationStatus("Playing…");
  updateNarrationButtons();
  startPlaybackProgress();
}

function stopProgressTimer() {
  if (narration.progressTimer) {
    clearInterval(narration.progressTimer);
    narration.progressTimer = 0;
  }
}

// Drive the playback progress bar off the audio clock. Uses setInterval (not
// requestAnimationFrame) so it keeps updating even when the window isn't the
// focused/visible one; the audio itself runs on the Web Audio clock regardless.
function startPlaybackProgress() {
  stopProgressTimer();
  narration.progressTimer = setInterval(() => {
    if (narration.phase !== "playing" || !audioCtx) { stopProgressTimer(); return; }
    const elapsed = audioCtx.currentTime - narration.playStartCtx;
    const frac = narration.playDuration > 0 ? elapsed / narration.playDuration : 1;
    setProgress(frac, false);
    if (frac >= 1) stopProgressTimer();
  }, 120);
}

function finishPlayback() {
  if (narration.phase !== "playing") return;
  narration.phase = "idle";
  stopProgressTimer();
  setProgress(1, false);
  showProgress(false);
  setNarrationStatus("Finished playing.", "ok");
  updateNarrationButtons();
}

// A synthesis run failed: discard partial audio so it can't be saved/played as
// if complete.
function discardNarration() {
  stopProgressTimer();
  stopSources();
  narration.phase = "idle";
  narration.haveAudio = false;
  narration.cacheText = "";
  narration.cacheVoice = "";
  narration.cacheKey = "";
  showProgress(false);
}

function handleNarrationError(message, stopped) {
  discardNarration();
  setNarrationStatus(message || "Narration failed.", stopped ? "" : "error");
  updateNarrationButtons();
}

// Stop the current run. Stopping a synthesis discards the partial result;
// stopping playback keeps the complete cached audio.
async function stopNarration() {
  const phase = narration.phase;
  if (phase === "idle") return;
  const wasPlaying = phase === "playing";
  narration.userStopped = true;
  // Supersede so late chunks/events are ignored. extBusy is left as-is: if a
  // synthesis is still in flight (e.g. the first-run model download), the button
  // stays disabled until generateNarration() unwinds and clears it.
  narration.requestId = ++narrationSeq;
  stopProgressTimer();

  if (!wasPlaying) {
    els.narrateStop.textContent = "Stopping…";
    els.narrateStop.disabled = true;
    try {
      await copilot.cancelNarration();
    } catch { /* ignore */ }
    els.narrateStop.textContent = "Stop";
    els.narrateStop.disabled = false;
  }
  stopSources();
  narration.phase = "idle";
  if (!wasPlaying) {
    // Discard the partial synthesis.
    narration.haveAudio = false;
    narration.cacheText = "";
    narration.cacheVoice = "";
    narration.cacheKey = "";
  }
  showProgress(false);
  setNarrationStatus(wasPlaying ? "Stopped." : "Narration stopped.");
  updateNarrationButtons();
}

async function saveAudioFile() {
  // Mirror the visible .txt name so the audio file shares its stem (whether that
  // is the model-generated title or a name the user typed), falling back to the
  // stored base / model-name slug.
  const typed = slugify(els.filename.value.trim().replace(/\.[a-z0-9]+$/i, ""));
  const base = typed || state.meta?.fileBase || slugifyModel(state.meta?.modelA);
  const filename = (base || "narration") + ".wav";
  els.saveAudio.disabled = true;
  setNarrationStatus("Choose where to save the audio…");
  let res;
  try {
    res = await copilot.saveAudio({ filename, key: narration.cacheKey });
  } catch (err) {
    res = { ok: false, error: err?.message || String(err) };
  }
  if (res && res.ok) {
    showSavedAudioStatus(res.path);
  } else if (res && res.canceled) {
    setNarrationStatus("Save canceled.");
  } else {
    setNarrationStatus(res?.error || "Couldn't save the audio.", "error");
  }
  updateNarrationButtons();
}

function showSavedAudioStatus(path) {
  els.narrationStatus.className = "narration-status ok";
  els.narrationStatus.textContent = "Audio saved to ";
  const link = document.createElement("a");
  link.className = "path-link";
  link.href = "#";
  link.textContent = path;
  link.title = "Reveal this file in your file manager";
  link.addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      await copilot.revealPath({ path });
    } catch { /* ignore */ }
  });
  els.narrationStatus.appendChild(link);
}

// ---- keyboard shortcuts --------------------------------------------------
// This webview has no native Edit menu, and its in-page clipboard (execCommand
// copy/cut/paste, navigator.clipboard) is gesture-gated and unreliable. So copy
// and cut route the selection to the OS clipboard through the extension, and
// paste reads the OS clipboard and inserts it with execCommand("insertText"),
// which keeps the field's native undo stack intact. Selection-only editing
// commands (insertText/delete/undo/redo) do work in this webview.

function isTextField(el) {
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    return ["text", "search", "url", "email", "tel", "password", "number", ""].includes(t);
  }
  return false;
}

async function osClipboardWrite(text) {
  if (!text) return false;
  try {
    const res = await copilot.clipboardWrite({ text });
    return !!(res && res.ok);
  } catch {
    return false;
  }
}

// Returns the currently selected substring of a text field, or "" if the field
// doesn't support the selection API (e.g. number/email inputs) or nothing is
// selected.
function selectedText(el) {
  try {
    if (typeof el.selectionStart === "number" && typeof el.selectionEnd === "number") {
      return el.value.substring(el.selectionStart, el.selectionEnd);
    }
  } catch {
    /* selection API unsupported for this input type */
  }
  return "";
}

function fieldCopy(el) {
  const text = selectedText(el);
  if (text) osClipboardWrite(text);
}

async function fieldCut(el) {
  const text = selectedText(el);
  if (!text) return;
  // Only remove the selection once it's safely on the OS clipboard, and only if
  // focus hasn't moved during the async write.
  const ok = await osClipboardWrite(text);
  if (!ok) {
    setStatus("Couldn't access the clipboard.", "error");
    return;
  }
  if (document.activeElement === el && !el.disabled && !el.readOnly) {
    try { document.execCommand("delete"); } catch { /* ignore */ }
  }
}

async function fieldPaste(el) {
  let res;
  try {
    res = await copilot.clipboardRead();
  } catch {
    res = null;
  }
  if (!res || !res.ok || !res.text) return;
  // Focus may have moved while reading the OS clipboard; only paste into the
  // field that was active when the shortcut fired.
  if (document.activeElement !== el || el.disabled || el.readOnly) return;
  let inserted = false;
  // insertText replaces the selection and integrates with the native undo stack.
  try {
    inserted = document.execCommand("insertText", false, res.text);
  } catch {
    inserted = false;
  }
  if (!inserted) {
    try {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      if (typeof start === "number" && typeof end === "number") {
        el.setRangeText(res.text, start, end, "end");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch {
      /* field doesn't support programmatic insertion */
    }
  }
}

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return;
  const key = e.key.toLowerCase();
  const el = document.activeElement;

  if (isTextField(el)) {
    switch (key) {
      case "a": e.preventDefault(); el.select(); return;
      case "c": e.preventDefault(); fieldCopy(el); return;
      case "x": e.preventDefault(); fieldCut(el); return;
      case "v": e.preventDefault(); fieldPaste(el); return;
      case "z": e.preventDefault(); document.execCommand(e.shiftKey ? "redo" : "undo"); return;
      case "y": e.preventDefault(); document.execCommand("redo"); return;
    }
    return;
  }

  // Outside a text field: let users select-all / copy the rendered story.
  if (key === "a" && els.story && (el === els.story || els.story.contains(el))) {
    e.preventDefault();
    const range = document.createRange();
    range.selectNodeContents(els.story);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return;
  }
  if (key === "c") {
    const sel = window.getSelection();
    const text = sel ? String(sel) : "";
    if (text) {
      e.preventDefault();
      osClipboardWrite(text);
    }
  }
});

// ---- wire up -------------------------------------------------------------

els.weave.addEventListener("click", weave);
els.stop.addEventListener("click", stop);
els.copy.addEventListener("click", copyStory);
els.save.addEventListener("click", saveStory);
els.narrate.addEventListener("click", narratePrimary);
els.narrateStop.addEventListener("click", stopNarration);
els.saveAudio.addEventListener("click", saveAudioFile);
els.voice.addEventListener("change", updateNarrationButtons);
els.includeStarter.addEventListener("change", updateNarrationButtons);
els.autoNarrate.addEventListener("change", () => {
  copilot.setAutoNarrate({ value: els.autoNarrate.checked }).catch(() => {});
});
els.concludeToggle.addEventListener("change", updateConcludeHint);
els.concludeMultiplier.addEventListener("change", updateConcludeHint);
els.sentences.addEventListener("input", updateConcludeHint);

updateConcludeHint();
loadModels();
loadVoices();
