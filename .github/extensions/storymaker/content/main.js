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
  // Keep Save disabled while generating: the timing metadata isn't available
  // until generateStory() returns, so a mid-flight save would lack it.
  els.save.disabled = !has || state.generating;
  els.copy.disabled = !has;
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
  clearStory();
  hideEmptyState();
  // Echo the starter immediately so it is always part of the visible story.
  const { textEl } = addSegmentBlock({ kind: "starter" });
  textEl.textContent = starter;

  setGenerating(true);
  setStatus("Warming up the authors…");

  try {
    const res = await copilot.generateStory({ starter, modelA, modelB, sentences, turns, conclude, concludeMultiplier });
    if (res && res.timing) state.meta.timing = res.timing;
    if (res) state.meta.generationStatus = res.ok ? "complete" : res.stopped ? "stopped" : "error";
    if (res && res.ok) {
      setStatus("Story complete. You can copy or save it.", "ok");
      prefillFilename();
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
}

// Derive a safe default filename (alphanumeric + hyphens, .txt) from Author A's
// model and prefill the filename box once there is a story to save.
function slugifyModel(model) {
  const slug = String(model || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "story";
}

function prefillFilename() {
  if (!assembleStory()) return;
  els.filename.value = slugifyModel(state.meta?.modelA) + ".txt";
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
els.concludeToggle.addEventListener("change", updateConcludeHint);
els.concludeMultiplier.addEventListener("change", updateConcludeHint);
els.sentences.addEventListener("input", updateConcludeHint);

updateConcludeHint();
loadModels();
