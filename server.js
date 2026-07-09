import "dotenv/config";
import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const GENERATED_DIR = path.join(PUBLIC_DIR, "generated");

const STORY_MODEL = process.env.STORY_MODEL || "claude-opus-4-8";
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gpt-image-1";
const IMAGE_SIZE = process.env.IMAGE_SIZE || "1024x1024";
const IMAGE_QUALITY = process.env.IMAGE_QUALITY || "medium";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

// Lazily construct SDK clients so the server can boot (and report a clear
// error) even when a key is missing.
function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw httpError(400, "ANTHROPIC_API_KEY is not set. Add it to your .env file to generate stories.");
  }
  return new Anthropic();
}

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw httpError(400, "OPENAI_API_KEY is not set. Add it to your .env file to generate pictures.");
  }
  return new OpenAI();
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const STORY_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "A short, evocative title for the book." },
    art_style: {
      type: "string",
      description:
        "A single, reusable art-direction line describing the visual style and the appearance of recurring characters and settings, so every illustration looks like it belongs to the same book. e.g. 'Soft watercolor children's-book style. Mira: a small girl with curly red hair, a yellow raincoat, and green boots. The forest: misty, ancient pines.'",
    },
    pages: {
      type: "array",
      description: "The ordered pages of the book.",
      items: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The story prose shown on this page (roughly 2-5 sentences).",
          },
          image_prompt: {
            type: "string",
            description:
              "A vivid, self-contained description of the single illustration for this page. Restate the key appearance of any characters present so the picture stays consistent. Describe a concrete scene, not the text.",
          },
        },
        required: ["text", "image_prompt"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "art_style", "pages"],
  additionalProperties: false,
};

function buildSystemPrompt(pageCount, genre) {
  const lines = [
    "You are an award-winning picture-book author and art director.",
    "Expand the reader's paragraph into a complete, satisfying illustrated story with a clear beginning, middle, and end.",
    `Write exactly ${pageCount} pages.`,
    "Each page should advance the story and pair with one illustration.",
    "Keep the prose warm, vivid, and age-appropriate for an illustrated book unless the paragraph clearly implies an older audience.",
    "For 'art_style', commit to ONE consistent visual style and describe recurring characters/settings concretely so every illustration matches.",
    "Every 'image_prompt' must be a concrete visual scene (who, where, doing what, mood, lighting) and should restate character appearances rather than relying on memory.",
  ];
  if (genre) {
    lines.push(
      `The story MUST be firmly in the "${genre}" genre — let it shape the tone, setting, pacing, character types, plot beats, and the mood of every illustration. Commit to the genre wholeheartedly.`
    );
  }
  return lines.join(" ");
}

// POST /api/story  -> { bookId, title, art_style, pages: [{ text, image_prompt }] }
app.post("/api/story", async (req, res, next) => {
  try {
    const paragraph = String(req.body?.paragraph || "").trim();
    const genre = String(req.body?.genre || "").trim().slice(0, 60);
    let pageCount = Number.parseInt(req.body?.pageCount, 10);
    if (!paragraph) throw httpError(400, "Please provide a paragraph to build the story from.");
    if (!Number.isFinite(pageCount)) pageCount = 8;
    pageCount = Math.min(Math.max(pageCount, 3), 20);

    const anthropic = getAnthropic();
    const stream = anthropic.messages.stream({
      model: STORY_MODEL,
      max_tokens: 20000,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: STORY_SCHEMA },
      },
      system: buildSystemPrompt(pageCount, genre),
      messages: [{ role: "user", content: paragraph }],
    });

    const message = await stream.finalMessage();
    const jsonText = message.content.find((b) => b.type === "text")?.text;
    if (!jsonText) throw httpError(502, "The story model returned no content. Please try again.");

    const story = JSON.parse(jsonText);
    const bookId = crypto.randomUUID();
    await fs.mkdir(path.join(GENERATED_DIR, bookId), { recursive: true });

    res.json({
      bookId,
      title: story.title,
      art_style: story.art_style,
      pages: story.pages.map((p) => ({ text: p.text, image_prompt: p.image_prompt })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/image -> { imageUrl }
app.post("/api/image", async (req, res, next) => {
  try {
    const bookId = String(req.body?.bookId || "");
    const pageIndex = Number.parseInt(req.body?.pageIndex, 10);
    const prompt = String(req.body?.prompt || "").trim();
    const artStyle = String(req.body?.artStyle || "").trim();

    if (!/^[a-f0-9-]{36}$/.test(bookId)) throw httpError(400, "Invalid bookId.");
    if (!Number.isInteger(pageIndex) || pageIndex < 0) throw httpError(400, "Invalid pageIndex.");
    if (!prompt) throw httpError(400, "Missing image prompt.");

    const openai = getOpenAI();
    const fullPrompt = artStyle
      ? `${prompt}\n\nArt direction (keep consistent across the whole book): ${artStyle}`
      : prompt;

    // Different OpenAI image models take slightly different parameters.
    const params = { model: IMAGE_MODEL, prompt: fullPrompt, size: IMAGE_SIZE, n: 1 };
    if (IMAGE_MODEL.startsWith("dall-e")) {
      // dall-e-2 / dall-e-3 return a URL by default; ask for base64 instead,
      // and use their quality vocabulary ("standard" | "hd").
      params.response_format = "b64_json";
      if (IMAGE_MODEL === "dall-e-3") {
        params.quality = ["hd", "high"].includes(IMAGE_QUALITY) ? "hd" : "standard";
      }
    } else {
      // gpt-image-1: quality is low | medium | high | auto; always returns b64.
      params.quality = IMAGE_QUALITY;
    }

    let result;
    try {
      result = await openai.images.generate(params);
    } catch (apiErr) {
      throw friendlyOpenAIError(apiErr);
    }

    const b64 = result.data?.[0]?.b64_json;
    if (!b64) throw httpError(502, "The image model returned no image. Please try again.");

    const dir = path.join(GENERATED_DIR, bookId);
    await fs.mkdir(dir, { recursive: true });
    const fileName = `page-${pageIndex}.png`;
    await fs.writeFile(path.join(dir, fileName), Buffer.from(b64, "base64"));

    res.json({ imageUrl: `/generated/${bookId}/${fileName}` });
  } catch (err) {
    next(err);
  }
});

// Turn OpenAI's raw errors into a clear, actionable message for the UI.
function friendlyOpenAIError(err) {
  const raw = err?.message || String(err);
  const lower = raw.toLowerCase();
  let hint = "";
  if (lower.includes("verif")) {
    hint = `Your OpenAI organization must be verified to use "${IMAGE_MODEL}". Either verify it at platform.openai.com/settings/organization/general, or switch to an easier model by setting IMAGE_MODEL=dall-e-3 in your .env file and restarting.`;
  } else if (lower.includes("billing") || lower.includes("quota") || lower.includes("insufficient") || lower.includes("credit")) {
    hint = "Your OpenAI account has no available credit. Add a payment method / credits at platform.openai.com/settings/organization/billing, then try again.";
  } else if (err?.status === 401 || lower.includes("api key") || lower.includes("incorrect")) {
    hint = "Your OPENAI_API_KEY looks invalid. Double-check it in your .env file (no quotes, no spaces) and restart the server.";
  } else if (err?.status === 429) {
    hint = "OpenAI is rate-limiting requests. Wait a moment and retry, or lower the page count.";
  }
  const message = hint ? `${hint}\n\n(OpenAI said: ${raw})` : `Image generation failed. OpenAI said: ${raw}`;
  return httpError(err?.status && err.status < 500 ? 400 : 502, message);
}

// Centralized error handling -> always JSON so the frontend can show a message.
app.use((err, _req, res, _next) => {
  const status = err.status || (err?.constructor?.name?.includes("Anthropic") || err?.constructor?.name?.includes("OpenAI") ? 502 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || "Something went wrong." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`📚 Book generator running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn("⚠️  ANTHROPIC_API_KEY is not set — story generation will fail until you add it.");
  if (!process.env.OPENAI_API_KEY) console.warn("⚠️  OPENAI_API_KEY is not set — image generation will fail until you add it.");
});
