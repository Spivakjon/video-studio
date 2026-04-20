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
