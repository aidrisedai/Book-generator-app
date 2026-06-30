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
  if (!paragraph) {
    setStatus("Please write a paragraph first.", true);
    return;
  }

  generateBtn.disabled = true;
  setStatus("Writing your story… (this can take a moment)");

  try {
    const story = await postJSON("/api/story", { paragraph, pageCount });
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

// ---- Illustrate every page (limited concurrency) ----
async function illustrateAll() {
  const queue = book.pages.map((_, i) => i);
  const CONCURRENCY = 3;

  async function worker() {
    while (queue.length) {
      const i = queue.shift();
      const page = book.pages[i];
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
      }
      if (i === current) renderPage();
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
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

  if (page.imageUrl) {
    img.src = page.imageUrl;
    img.alt = page.image_prompt;
    artLoading.classList.add("hidden");
  } else {
    img.removeAttribute("src");
    img.alt = "";
    artLoading.classList.remove("hidden");
    artLoading.textContent = page.status === "error" ? "couldn't draw this one" : "illustrating";
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
const speechSupported = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

function speakPage(index) {
  const utter = new SpeechSynthesisUtterance(book.pages[index].text);
  utter.rate = 0.95;
  utter.pitch = 1;
  utter.onend = () => {
    if (!reading) return; // was stopped
    if (index < book.pages.length - 1) {
      current = index + 1;
      renderPage();
      speakPage(current); // auto-turn to the next page and keep reading
    } else {
      stopReading();
    }
  };
  window.speechSynthesis.speak(utter);
}

function startReading() {
  if (!book || !speechSupported) return;
  window.speechSynthesis.cancel();
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
}

// ---- Wire up ----
$("generateBtn").addEventListener("click", generate);
$("prevBtn").addEventListener("click", () => go(-1));
$("nextBtn").addEventListener("click", () => go(1));
$("printBtn").addEventListener("click", buildPrintAndOpen);
$("newBtn").addEventListener("click", reset);
$("readBtn").addEventListener("click", toggleReading);

// Hide the read-aloud button on browsers that don't support speech synthesis.
if (!speechSupported) $("readBtn").classList.add("hidden");

// Stop any narration if the user leaves or refreshes the page.
window.addEventListener("beforeunload", stopReading);

document.addEventListener("keydown", (e) => {
  if (reader.classList.contains("hidden")) return;
  if (e.key === "ArrowRight") go(1);
  if (e.key === "ArrowLeft") go(-1);
});
