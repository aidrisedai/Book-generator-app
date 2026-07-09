// ---- State ----
let book = null; // { bookId, title, art_style, pages: [{ text, image_prompt, imageUrl|null, status }] }
let current = 0;

// ---- Elements ----
const $ = (id) => document.getElementById(id);
const composer = $("composer");
const reader = $("reader");
const statusEl = $("status");
const generateBtn = $("generateBtn");

// ---- Helpers ----
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

// ---- Generate ----
async function generate() {
  const paragraph = $("paragraph").value.trim();
  const pageCount = Number($("pageCount").value);
  const genre = $("genreInput").value.trim();
  if (!paragraph) {
    setStatus("Please write a paragraph first.", true);
    return;
  }

  generateBtn.disabled = true;
  setStatus("Writing your story… (this can take a moment)");

  try {
    const story = await postJSON("/api/story", { paragraph, pageCount, genre });
    book = {
      ...story,
      pages: story.pages.map((p) => ({ ...p, imageUrl: null, status: "pending" })),
    };
    current = 0;

    $("bookTitle").textContent = book.title;
    composer.classList.add("hidden");
    reader.classList.remove("hidden");
    renderPage();
    illustrateAll();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    generateBtn.disabled = false;
  }
}

// ---- Illustrate a single page ----
async function illustrateOne(i) {
  const page = book.pages[i];
  page.status = "pending";
  page.error = null;
  if (i === current) renderPage();
  try {
    const { imageUrl } = await postJSON("/api/image", {
      bookId: book.bookId,
      pageIndex: i,
      prompt: page.image_prompt,
      artStyle: book.art_style,
    });
    page.imageUrl = imageUrl;
    page.status = "done";
  } catch (err) {
    page.status = "error";
    page.error = err.message;
    console.error(`Page ${i + 1} illustration failed:`, err.message);
  }
  if (i === current) renderPage();
  updateReaderNote();
}

// ---- Illustrate every page (limited concurrency) ----
async function illustrateAll() {
  const queue = book.pages.map((_, i) => i);
  const CONCURRENCY = 3;
  async function worker() {
    while (queue.length) await illustrateOne(queue.shift());
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

function retryCurrent() {
  if (book && book.pages[current].status === "error") illustrateOne(current);
}

// Show the underlying error once, prominently, so it's actionable.
function updateReaderNote() {
  const note = $("readerNote");
  const errored = book && book.pages.find((p) => p.status === "error");
  if (errored && errored.error) {
    note.textContent = errored.error;
    note.classList.remove("hidden");
  } else {
    note.textContent = "";
    note.classList.add("hidden");
  }
}

// ---- Render the current page ----
function renderPage() {
  if (!book) return;
  const page = book.pages[current];
  const img = $("pageImage");
  const artLoading = $("artLoading");

  $("pageText").textContent = page.text;
  $("pageNumber").textContent = `Page ${current + 1}`;
  $("progress").textContent = `${current + 1} / ${book.pages.length}`;

  const retryBtn = $("retryBtn");
  if (page.imageUrl) {
    img.src = page.imageUrl;
    img.alt = page.image_prompt;
    artLoading.classList.add("hidden");
    retryBtn.classList.add("hidden");
  } else {
    img.removeAttribute("src");
    img.alt = "";
    artLoading.classList.remove("hidden");
    if (page.status === "error") {
      artLoading.textContent = "couldn't draw this one";
      artLoading.classList.add("is-error");
      retryBtn.classList.remove("hidden");
    } else {
      artLoading.textContent = "illustrating";
      artLoading.classList.remove("is-error");
      retryBtn.classList.add("hidden");
    }
  }

  $("prevBtn").disabled = current === 0;
  $("nextBtn").disabled = current === book.pages.length - 1;
}

function go(delta) {
  if (!book) return;
  stopReading(); // manual navigation cancels read-aloud
  const next = current + delta;
  if (next < 0 || next >= book.pages.length) return;
  current = next;
  renderPage();
}

// ---- Read aloud (browser Web Speech API) ----
let reading = false;
let narrator = null; // the chosen voice
const speechSupported = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

// Pick the most natural-sounding English voice the browser offers.
function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const english = voices.filter((v) => /^en/i.test(v.lang));
  const pool = english.length ? english : voices;
  const score = (v) => {
    const n = v.name.toLowerCase();
    let s = 0;
    if (n.includes("natural")) s += 6; // MS "Natural" voices
    if (n.includes("neural")) s += 6;
    if (n.includes("google")) s += 5; // Chrome's Google voices
    if (n.includes("premium") || n.includes("enhanced")) s += 4;
    if (n.includes("aria") || n.includes("jenny") || n.includes("guy")) s += 2;
    if (/en-us/i.test(v.lang)) s += 1;
    if (n.includes("zira") || n.includes("david") || n.includes("mark")) s -= 2; // older robotic MS voices
    return s;
  };
  return pool.slice().sort((a, b) => score(b) - score(a))[0] || pool[0];
}

if (speechSupported) {
  narrator = pickVoice();
  // Voices often load asynchronously — refresh once they're ready.
  window.speechSynthesis.onvoiceschanged = () => { narrator = pickVoice(); };
}

// Split a page into sentences so narration flows with natural pauses
// (also avoids a Chrome bug that cuts off long single utterances).
function splitSentences(text) {
  const parts = text.match(/[^.!?…]+[.!?…]*/g);
  return (parts || [text]).map((s) => s.trim()).filter(Boolean);
}

function speakSentences(sentences, i, onDone) {
  if (!reading) return;
  if (i >= sentences.length) { onDone(); return; }
  const u = new SpeechSynthesisUtterance(sentences[i]);
  if (narrator) u.voice = narrator;
  u.rate = 0.92;   // a touch slower reads more like a storyteller
  u.pitch = 1.05;  // gently warmer
  u.onend = () => speakSentences(sentences, i + 1, onDone);
  window.speechSynthesis.speak(u);
}

function speakPage(index) {
  const sentences = splitSentences(book.pages[index].text);
  speakSentences(sentences, 0, () => {
    if (!reading) return;
    if (index < book.pages.length - 1) {
      current = index + 1;
      renderPage();
      speakPage(current); // auto-turn to the next page and keep reading
    } else {
      stopReading();
    }
  });
}

function startReading() {
  if (!book || !speechSupported) return;
  window.speechSynthesis.cancel();
  if (!narrator) narrator = pickVoice();
  reading = true;
  updateReadButton();
  speakPage(current);
}

function stopReading() {
  if (!reading) return;
  reading = false;
  if (speechSupported) window.speechSynthesis.cancel();
  updateReadButton();
}

function toggleReading() {
  reading ? stopReading() : startReading();
}

function updateReadButton() {
  const btn = $("readBtn");
  btn.textContent = reading ? "⏹ Stop reading" : "🔊 Read aloud";
  btn.classList.toggle("active", reading);
}

// ---- Print / PDF ----
function buildPrintAndOpen() {
  const root = $("printRoot");
  const pending = book.pages.some((p) => p.status === "pending");
  if (pending && !confirm("Some illustrations are still being drawn. Print anyway?")) return;

  root.innerHTML = "";
  const cover = document.createElement("div");
  cover.className = "print-cover";
  cover.innerHTML = `<h1></h1>`;
  cover.querySelector("h1").textContent = book.title;
  root.appendChild(cover);

  book.pages.forEach((page) => {
    const el = document.createElement("div");
    el.className = "print-page";
    if (page.imageUrl) {
      const img = document.createElement("img");
      img.src = page.imageUrl;
      el.appendChild(img);
    }
    const p = document.createElement("p");
    p.textContent = page.text;
    el.appendChild(p);
    root.appendChild(el);
  });

  window.print();
}

function reset() {
  stopReading();
  book = null;
  current = 0;
  reader.classList.add("hidden");
  composer.classList.remove("hidden");
  setStatus("");
  $("printRoot").innerHTML = "";
  $("readerNote").classList.add("hidden");
}

// ---- Genre picker ----
const GENRES = [
  "Fantasy", "Sci-Fi", "Mystery", "Adventure", "Fairy Tale", "Bedtime",
  "Comedy", "Spooky", "Superhero", "Mythology", "Western", "Romance",
  "Historical", "Fable",
];

function setGenreLabel() {
  const val = $("genreInput").value.trim();
  $("genreLabel").textContent = val || "Any genre";
  // Highlight a matching chip if the text equals a preset.
  document.querySelectorAll(".genre-chip").forEach((chip) => {
    chip.classList.toggle("selected", chip.dataset.genre.toLowerCase() === val.toLowerCase());
  });
}

function buildGenrePicker() {
  const grid = $("genreGrid");
  GENRES.forEach((g) => {
    const chip = document.createElement("button");
    chip.className = "genre-chip";
    chip.type = "button";
    chip.textContent = g;
    chip.dataset.genre = g;
    chip.addEventListener("click", () => {
      // Click a selected chip again to clear it.
      const already = $("genreInput").value.trim().toLowerCase() === g.toLowerCase();
      $("genreInput").value = already ? "" : g;
      setGenreLabel();
    });
    grid.appendChild(chip);
  });

  $("genreInput").addEventListener("input", setGenreLabel);

  $("genreToggle").addEventListener("click", (e) => {
    e.stopPropagation();
    const panel = $("genrePanel");
    const open = panel.classList.toggle("hidden") === false;
    $("genreToggle").setAttribute("aria-expanded", String(open));
  });

  // Close the panel when clicking elsewhere.
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".genre-corner")) {
      $("genrePanel").classList.add("hidden");
      $("genreToggle").setAttribute("aria-expanded", "false");
    }
  });
}

buildGenrePicker();

// ---- Wire up ----
$("generateBtn").addEventListener("click", generate);
$("prevBtn").addEventListener("click", () => go(-1));
$("nextBtn").addEventListener("click", () => go(1));
$("printBtn").addEventListener("click", buildPrintAndOpen);
$("newBtn").addEventListener("click", reset);
$("readBtn").addEventListener("click", toggleReading);
$("retryBtn").addEventListener("click", retryCurrent);

// Hide the read-aloud button on browsers that don't support speech synthesis.
if (!speechSupported) $("readBtn").classList.add("hidden");

// Stop any narration if the user leaves or refreshes the page.
window.addEventListener("beforeunload", stopReading);

document.addEventListener("keydown", (e) => {
  if (reader.classList.contains("hidden")) return;
  if (e.key === "ArrowRight") go(1);
  if (e.key === "ArrowLeft") go(-1);
});
