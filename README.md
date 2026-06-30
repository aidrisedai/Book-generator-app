# 📚 The Storybook Machine

Give it a single paragraph and it writes you a complete illustrated storybook —
a real cover-to-cover story with **an AI-generated picture on every page**, all
in a flippable in-browser book you can read or save as a PDF.

- **Story** is written and structured by **Claude** (`claude-opus-4-8`) — it
  expands your paragraph into a full beginning/middle/end across the number of
  pages you choose, and acts as art director to keep the illustrations
  consistent.
- **Pictures** are drawn by **OpenAI** (`gpt-image-1`) — one bespoke
  illustration per page, matched to the book's art style.

## How it works

1. You paste a paragraph and pick a page count.
2. Claude returns a structured book: a title, a shared art-style guide, and the
   prose + an illustration prompt for each page.
3. The browser shows the story immediately, then fills in each page's
   illustration as OpenAI draws it (3 at a time).
4. Read it with the arrows/keyboard, or **Save / Print as PDF**.

## Setup

You need **Node.js 18+** and two API keys.

```bash
# 1. Install dependencies
npm install

# 2. Add your keys
cp .env.example .env
#    then edit .env and paste in:
#      ANTHROPIC_API_KEY=...   (https://console.anthropic.com/)
#      OPENAI_API_KEY=...      (https://platform.openai.com/)

# 3. Run it
npm start
```

Then open <http://localhost:3000>.

## Project layout

| Path | What it is |
| --- | --- |
| `server.js` | Express server. `POST /api/story` (Claude) and `POST /api/image` (OpenAI). |
| `public/index.html` | The page shell. |
| `public/app.js` | Front-end: calls the API, renders the flip-book, handles PDF export. |
| `public/styles.css` | Styling, including a print stylesheet for PDF export. |
| `public/generated/` | Generated page images are saved here, grouped by book. |

## Notes & costs

- Each page is one OpenAI image generation, so an 8-page book makes 8 images —
  image generation is the main cost. Tune it in `.env`:
  `IMAGE_QUALITY` (`low` / `medium` / `high`) and `IMAGE_SIZE`.
- Generated images live in `public/generated/<book-id>/` and are git-ignored.
- No database — books aren't persisted between server restarts beyond their
  image files on disk.

## Configuration

All optional except the two keys, set in `.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | **Required.** Story generation. |
| `OPENAI_API_KEY` | — | **Required.** Image generation. |
| `STORY_MODEL` | `claude-opus-4-8` | Claude model for the story. |
| `IMAGE_MODEL` | `gpt-image-1` | OpenAI image model. |
| `IMAGE_SIZE` | `1024x1024` | Image dimensions. |
| `IMAGE_QUALITY` | `medium` | `low` / `medium` / `high`. |
| `PORT` | `3000` | Server port. |
