# Video Studio 🎬

Conversational video production platform. Talk to Claude, get finished marketing/instructional videos.

## Quick start (no CLI required)

Double-click one of these from the `video-studio` folder:

| Launcher | What it does |
|----------|--------------|
| **`studio.bat`** | Opens Claude Code in the project — ask in plain Hebrew/English, Claude drives everything |
| **`new-video.bat`** | Shortcut for "create a new video" — Claude asks the discovery questions, writes a script for approval, then produces |
| **`editor.bat`** | Launches the web editor at http://localhost:3003 (nice-to-have, not required) |

**To pin to desktop:** right-click a `.bat` → *Create shortcut* → drag the shortcut to your desktop.

## How it works

Claude reads `CLAUDE.md` the moment the session opens — that's ~400 lines summarizing every rule we've agreed on (script-approval gate, real images first, brand logo, visual defaults). Saves API tokens because Claude doesn't have to explore to figure out the project.

Tell Claude things like:
- "בוא ניצור סרטון חדש על העגלה של קיקבו"
- "ערוך את התסריט של ivan-demo"
- "רנדר את my-video באיכות גבוהה"
- "תוסיף סצנה באמצע על בטיחות"

Claude will always:
1. Ask for missing info (images, brand, voice)
2. Write the full script as a numbered table
3. **Wait for your approval** before any TTS or render
4. Scaffold → TTS → render → copy MP4 to your desktop

## Layout

```
video-studio/
├── studio.bat / new-video.bat / editor.bat   launchers
├── CLAUDE.md                                 project context for Claude Code
├── tools/
│   ├── editor/      multi-project web editor on :3003
│   ├── tts.mjs      generate voiceovers
│   ├── scaffold.mjs create from template
│   └── render.mjs   render MP4
├── templates/       starter compositions
├── videos/          one folder per video
└── shared/branding/ brand logos (Kikkaboo etc.)
```

## Requirements

- Node.js >= 22, ffmpeg in PATH (already installed on this machine)
- `GEMINI_API_KEY` env var (already set globally on this machine)
- Claude Code CLI (`claude` on PATH)

## Advanced — CLI commands

If you want to skip Claude and run things yourself:

```bash
npm run studio                                                 # web editor
npm run scaffold -- --from kikkaboo-4step --to NAME --brand kikkaboo
npm run tts -- NAME [--only ITEM_ID]
npm run render -- NAME [--high]
```

## Current videos

- `videos/ivan-demo/` — Kikkaboo I-VAN car seat installation demo. Reference implementation.

## Current templates

- `templates/kikkaboo-4step/` — 6-scene Kikkaboo instructional with Hebrew placeholders. Use for new 4-step product videos.
