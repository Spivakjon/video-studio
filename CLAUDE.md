# Video Studio — Claude Code Context

This file is loaded into every Claude Code session opened inside this project. Read it first, don't explore.

## What this project is

A Hebrew-first video production platform for the user's business projects (Kikkaboo, Dubai safe rooms, future). Each video lives in `videos/<name>/` as a HyperFrames composition (HTML + texts-manifest.json + audio WAVs + product images). Shared tooling under `tools/` handles editing, TTS, scaffolding, and rendering.

## Business projects

Each business entity the user produces videos for is registered under `projects/<id>/`:

```
projects/<id>/
├── project.json          {id, displayName, description, sourceDir, defaultTemplate, defaultVoice, colors}
├── branding/logo.png     brand logo (PNG, auto-copied into new videos' assets/branding)
└── context.md            anything Claude should know when producing videos for this brand
```

**Reading a business project:** always read `projects/<id>/project.json` and `projects/<id>/context.md` before starting work on a new video for that project. The `sourceDir` field is a path on the user's filesystem (often under `OneDrive\Desktop\כללי פרויקטים\`) — if set, scan it for product catalogues, images, spec sheets, existing marketing, feedback; use that content in the script.

**Every video's `texts-manifest.json` has a `businessProject` field** linking it back to its business project. Respect that link — if the user asks to "make another video like ivan-demo", the new video inherits the same businessProject and its defaults.

**Active business projects:**
- **kikkaboo** — Kikkaboo (mother-and-baby products). See `projects/kikkaboo/`.
- **dubai-mamad** — to be created when the user is ready (mentioned in global memory as `project_dubai_saferooms`).

**Project discovery:** `GET /api/discover-projects` scans `C:\Users\spiva\OneDrive\Desktop\כללי פרויקטים\` (overridable via `STUDIO_SCAN_ROOT`) and returns every top-level folder so the user can pick from registered *or* discovered projects in the new-video modal. Picking a discovered folder calls `POST /api/business-project/register-discovered` and auto-creates the business project with `sourceDir` pointing at the folder — Claude can then scan that `sourceDir` for context.

## Non-negotiable workflow (do NOT skip any step)

When the user asks for a new video:

1. **Discovery** — ask:
   - Which **business project** is this for? (check `projects/` — if only one is registered, assume it and confirm.)
   - Read the business project's `project.json` + `context.md` before asking more.
   - If `sourceDir` is set, list its contents and offer to pull reference material from there before asking for more.
   - Product / topic?
   - Real product images, GIFs, or installation photos beyond what's in `sourceDir`? (URLs or file paths). If no good source, offer Nano Banana / Imagen at $0.02-0.06/image.

2. **Script approval gate — BLOCKING** — write the full script in a numbered table before any API cost:
   | Scene | Start | Dur | Voiceover (he) | Visual |
   Wait for the user's explicit "אשר" / "תעבור הלאה" / edits. Do NOT generate TTS, scaffold, or render before approval.

   **Brand-agent review sub-gate (Kikkaboo, likely all future brand projects):** Before asking the user for final approval, offer to generate a shareable markdown doc the user can forward to the brand's agents for their review. Only after agent feedback comes back + user gives the final green light do we proceed.

   **Never include voice-style directives** in voiceover text (no `"בקול X:"` prefixes) — Gemini TTS speaks them literally. See `feedback_marketing_copy.md`.

3. **Production** (only after green light):
   - `npm run scaffold -- --from <template> --to <name> --brand <brand>` — scaffold new video
   - Drop user-supplied images into `videos/<name>/assets/` (download any URLs locally first)
   - Open editor (`npm run studio` if not already running) and apply approved texts. Saving via `/api/save` regenerates TTS automatically.
   - `npm run render -- <name>` (draft) → show the user one or two screenshots → fix issues → `npm run render -- <name> --high` (final)
   - Copy final MP4 to the user's requested location (often `C:\Users\spiva\OneDrive\Desktop\…`)

## Visual defaults (Kikkaboo)

Per `templates/kikkaboo-4step/DESIGN.md`:
- Canvas: 1920×1080, deep navy `#0B1F3A` with orange accent `#FF6B35` and green `#00D68F` for verified states
- Fonts: Rubik (display) + Heebo (body) — autoloaded by HyperFrames
- Motion: entrance only; scene transitions own the exits
- Brand logo persistent in corner (bottom-left on landscape)
- No drop shadows on body text, no full-screen linear gradients, no cartoon icons

## Available commands (run from project root)

```bash
npm run studio            # web editor + preview at http://localhost:3003
npm run scaffold -- --from kikkaboo-4step --to NAME --brand kikkaboo
npm run tts -- NAME       # regenerate all voiceovers (requires GEMINI_API_KEY)
npm run tts -- NAME --only vo-02
npm run render -- NAME            # draft MP4
npm run render -- NAME --high     # final MP4
npm run veo -- --project NAME --input assets/X.jpg --prompt "..." --duration 6 --output assets/Y.mp4   # Vertex AI Veo image-to-video (requires GCP setup, see .gcp/README.md)
npm run gcp:check         # validate GCP/Vertex AI setup
```

All scripts respect `GEMINI_API_KEY` (Windows user env var) for TTS + non-production Veo. Vertex AI uses a service-account JSON at `.gcp/service-account.json` + project ID in `.gcp/config.json`.

## Layout

```
video-studio/
├── tools/
│   ├── editor/server.mjs      HTTP API + UI
│   ├── editor/ui/             design system + pages (home.html, edit.html, styles.css)
│   ├── tts.mjs                CLI TTS regen
│   ├── scaffold.mjs           CLI new-from-template
│   └── render.mjs             CLI render wrapper
├── templates/
│   └── kikkaboo-4step/        generic placeholder template ({{PROJECT_NAME}}, {{BRAND_UPPER}}, …)
├── videos/
│   └── ivan-demo/             reference implementation (fully populated Kikkaboo I-VAN)
└── shared/branding/
    └── kikkaboo-logo.png
```

Scaffold placeholders: `{{PROJECT_NAME}}`, `{{PROJECT_NAME_UPPER}}` (e.g. `my-video` → `MY VIDEO`), `{{BRAND}}`, `{{BRAND_UPPER}}`. `scaffoldProject` in `tools/editor/server.mjs` is the source of truth.

## Important constraints

- **Hebrew paths break HyperFrames** — keep everything under `C:\hf-projects\video-studio`, never under `OneDrive\Desktop\כללי פרויקטים`. Deliver the final MP4 to the user's desktop by copying.
- **HyperFrames >= 0.4.5** fixed the Windows path bug. No patch needed.
- **Base64 audio is banned** by the linter — always use file-based audio paths.
- **Scene clips must not overlap on the same `data-track-index`** — respect the linter.
- Never break the `id="…"` on editable text elements — the editor uses those ids to persist changes.
- **TTS word-count guardrail**: Kore (female, warm) produces ~2 words/sec in Hebrew — a 5-second scene holds at most 10-12 words of voiceover before cut-off. Always `ffprobe` the WAV after TTS and adjust scene duration if `wavLength > sceneDuration - 0.3`.
- **Never prefix voiceover text with voice-style directives** (e.g. "בקול נועז:") — Gemini TTS speaks them literally. See `memory/feedback_marketing_copy.md`.

## AI video generation

- **Gemini Developer API** supports Veo text-to-video ONLY (no image conditioning). Good for B-roll/mood clips where product identity isn't critical. See `memory/reference_veo_gemini_api.md`.
- **Vertex AI** supports Veo image-to-video — preserves product identity. Configured via `.gcp/config.json` + gcloud auth (service-account keys disabled by org policy). Use `npm run veo -- ...` (see `tools/vertex-veo.mjs`). Default model: `veo-3.0-fast-generate-001`. Durations: 4 / 6 / 8 seconds (no 5).
- **Cost guardrails**: always show estimate before spending. Log every Vertex call to `.gcp/usage-log.jsonl`. Monthly cap $50, all calls require interactive approval. **NEVER bypass the approval gate** via curl, direct API calls, or "discovery" submissions — that's what burned $3.80 in uncredited spend on 2026-04-19. Use `:fetch` endpoints or documentation for discovery; only `npm run veo` makes paid calls.

### PRODUCT-ANIMATION HONESTY RULE (non-negotiable)

**Never use Veo image-to-video on the user's registered product** (I-VAN seat, Kikkaboo strollers, Dubai mammad, any physical SKU). Even subtle Veo motion on a product photo can misrepresent capabilities and expose the brand to consumer-protection claims. The user explicitly blocked this on 2026-04-19.

Only two acceptable treatments for a product shot:
- **(A) Static + GSAP** — zoom, fade, breathing *of the whole image as one block*. Product appearance itself is unchanged. This is the default.
- **(B) Deliberate character treatment** — explicit mouth overlay, speaking animation, mascot vibe. Signals "stylized" unmistakably. Only with user's explicit request.

**Legitimate Veo usage:** B-roll only — ambient family scenes, road journey, baby sleeping, morning light, non-product context. The Veo clip must not show the user's SKU.

Before any Veo call on a product asset, ask the user: "This animates the product itself — stick with GSAP, or go to character treatment?"

## 2026-05 additions — vertical social (9:16) + multi-engine + new tools

**New tools (run from project root):**
```bash
npm run veo:batch -- --project NAME --shotlist shots.json [--yes] [--max-usd N]  # batch Veo: auto-retry on high-load, duration-snap to {4,6,8}, RAI-skip, budget-capped, summary. Prefer over hand bash-loops.
npm run nano -- --project NAME --input X.png --prompt "..." --output assets/Y.png  # Nano Banana (gemini-2.5-flash-image) — face-preserving stills, reframes, product stills
npm run lyria -- --project NAME --prompt "..." --output audio/m.wav               # Lyria music (Vertex), ~$0.06/30s instrumental
npm run frames -- NAME path.mp4 --n 5            # extract verification frames (or --at 2,11,30)
```
Dashboard: **"🎬 בנה תסריט"** button → free-text AI shooting-script builder (`POST /api/ai/script`, `claude-api.generateShootingScript`).

**Vertical social/trailer flow (NOT the 1920×1080 template flow):** build `videos/<name>/index.html` by hand — full-bleed `<video muted playsinline>` clips on track 0, Hebrew text overlays on track 1, transitions track 3, ONE pre-mixed `audio/master.wav`. Add `@font-face` for Heebo/Rubik (copy from `videos/lavi-pilot/assets/fonts/`) — NOT auto-resolved in hyperframes 0.6.x. Persistent brand logo = a non-clip element, always visible.

**Footage routing:** Veo t2v for faceless shots (vehicles/crowds/landscapes); **Nano Banana still → Ken Burns** for any real face/identity (Veo can't hold a consistent face across cuts); **real product photo → Ken Burns** (NOT Veo — product rule); **Higgsfield** (manual or Cloud API, `HF_API_KEY`+`HF_API_SECRET`) for character-consistent realistic people + camera presets.

**Audio:** pre-mix with ffmpeg `audio/mix.filtergraph` — music bed + TTS VO; `acrossfade` for continuous music; MUTE all video clips so the audio is 100% controlled/Hebrew.

**RAI / safety gotchas:** BLOCKED → real child + weapon/military; ethnic/religious descriptors ("Jewish features"); words like "chaos/avalanche/panic". WORKS → "cinematic heroic aviator" not "fighter pilot in combat"; "Israeli Sabra Mediterranean, olive skin, dark wavy hair"; heavily blurred bg + "no text/signs/logos" to kill gibberish signage. Veo durations: 4/6/8 only (tools auto-snap).

**Tricks:** WhatsApp/IG thumbnail = first frame (they ignore embedded cover) → prepend a ~0.8s poster flash as frame 0. Baby/child voice = male TTS (Puck) + ffmpeg `asetrate` pitch-up (~+30-40%) + `atempo` to keep duration.

**⚠️ Rule violated 2026-05-29:** `videos/kikkaboo-babyland/clips/p-carseat.mp4` + `p-travelsystem.mp4` used Veo i2v on real SKUs (against the product rule above). Replace with static Ken Burns of the real product photos.

## When the user asks for edits to an existing video

- Prefer the web editor at http://localhost:3003/edit?project=<name>. Most text changes happen there.
- For structural changes (add a scene, change timing, swap a layout), edit `videos/<name>/index.html` directly. Re-lint with `npx hyperframes lint` from inside the video's folder.
- Re-render after changes; keep the draft/high distinction — never wait on a `--high` render until the draft looks right.

## Memory & preferences

The user's global memory (`~/.claude/...`) already contains:
- Script-approval-gate feedback (2026-04-18)
- "Use real product images first" feedback
- Kikkaboo brand asset rules
- Hyperframes Windows bug reference
- Dubai safe rooms project context
- This video-studio reference

Respect those rules in every session; don't ask the user to repeat them.

## 2026-08 — humanizer endpoint (`POST /api/humanize`)

This service also backs the unlisted `/humanizer` page on
**spivakgroup.co.il** (`C:\dev\spivak-studio\src\pages\humanizer.astro`). The
page is static, so this is where the Claude call happens: it already holds
`ANTHROPIC_API_KEY` and the shared `$50`/month cap in `.ai/config.json`.

- `claude-api.humanizeText({ text })` sends `shared/humanizer-skill.md` (the
  humanizer skill verbatim, MIT, from Wikipedia's "Signs of AI writing") plus
  Jon's Hebrew house rules as a **cached** system block, and returns only the
  rewritten text (the skill's "embedded mode"). First call in a 5-minute window
  costs ~$0.03, the rest ~$0.004 because the 30KB prompt is cached.
- Guards, because the page URL is unlisted rather than password protected:
  origin allowlist (`HUMANIZER_ORIGINS`), 8000-char input cap, 8 calls per IP
  per 10 min, 40 calls per hour overall, and the monthly budget.
- `HUMANIZER_OWNER_TOKEN` marks Jon's own browser (he opens
  `/humanizer#me=TOKEN` once and it is stored in `localStorage`). Any call
  **without** it pings him on Telegram via `TELEGRAM_BOT_TOKEN` +
  `HUMANIZER_ALERT_CHAT_ID` (272600204). The token silences the alert, it does
  not gate access.
- Adding an origin means editing `HUMANIZER_ORIGINS` in `tools/editor/server.mjs`.
