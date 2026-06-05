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
  weave: $("weave"),
  stop: $("stop"),
  status: $("status"),
  story: $("story"),
  emptyState: $("empty-state"),
  filename: $("filename"),
  save: $("save"),
  copy: $("copy"),
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
}

function assembleStory() {
  const parts = [state.starterText];
  const indices = [...state.segments.keys()].sort((a, b) => a - b);
  for (const i of indices) parts.push(state.segments.get(i).plain);
  return parts.map((p) => (p || "").trim()).filter(Boolean).join("\n\n");
}

function refreshOutputButtons() {
  const has = assembleStory().length > 0;
  els.save.disabled = !has;
  els.copy.disabled = !has;
}

// Build a segment block. `meta` = { kind:'starter'|'author', participant, model, turn, totalTurns }
function addSegmentBlock(meta) {
  const seg = document.createElement("div");
  seg.className = "segment " + (meta.kind === "starter" ? "starter" : "author-" + meta.participant);

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
  onSegmentStart({ index, participant, model, turn, totalTurns }) {
    hideEmptyState();
    const { segEl, textEl } = addSegmentBlock({
      kind: "author",
      participant,
      model,
      turn,
      totalTurns,
    });
    state.segments.set(index, { segEl, textEl, plain: "" });
    state.activeIndex = index;
    setCaret(index, true);
    setStatus(`Turn ${turn} of ${totalTurns} · Author ${participant} (${model}) is writing…`);
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
  clearStory();
  hideEmptyState();
  // Echo the starter immediately so it is always part of the visible story.
  const { textEl } = addSegmentBlock({ kind: "starter" });
  textEl.textContent = starter;

  setGenerating(true);
  setStatus("Warming up the authors…");

  try {
    const res = await copilot.generateStory({ starter, modelA, modelB, sentences, turns });
    if (res && res.ok) {
      setStatus("Story complete. You can copy or save it.", "ok");
    } else if (res && res.stopped) {
      setStatus("Generation stopped. Partial story kept.", "");
    } else {
      setStatus(res?.error || "Generation failed.", "error");
    }
  } catch (err) {
    setStatus(String(err.message || err), "error");
  } finally {
    setGenerating(false);
    refreshOutputButtons();
  }
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
  let done = false;
  try {
    await navigator.clipboard.writeText(text);
    done = true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      done = document.execCommand("copy");
      ta.remove();
    } catch {}
  }
  setStatus(done ? "Story copied to clipboard." : "Couldn't access the clipboard.", done ? "ok" : "error");
}

async function saveStory() {
  const content = assembleStory();
  if (!content) return;
  let filename = els.filename.value.trim();
  if (!filename) filename = "story.txt";
  els.save.disabled = true;
  setStatus("Saving…");
  try {
    const res = await copilot.saveStory({ filename, content });
    if (res && res.ok) {
      setStatus(`Saved to ${res.path}`, "ok");
    } else {
      setStatus(res?.error || "Save failed.", "error");
    }
  } catch (err) {
    setStatus(String(err.message || err), "error");
  } finally {
    refreshOutputButtons();
  }
}

// ---- wire up -------------------------------------------------------------

els.weave.addEventListener("click", weave);
els.stop.addEventListener("click", stop);
els.copy.addEventListener("click", copyStory);
els.save.addEventListener("click", saveStory);

loadModels();
