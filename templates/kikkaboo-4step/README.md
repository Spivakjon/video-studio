# Kikkaboo 4-Step Instructional Template

6-scene instructional video template: brand intro → 4 numbered steps → verification → brand outro.

## What you get after scaffolding

```bash
npm run scaffold -- --from kikkaboo-4step --to my-new-video --brand kikkaboo
```

- `index.html` — composition with IDs on every editable text (ready for the editor)
- `texts-manifest.json` — defines all screen texts + voiceover lines, pre-filled with sensible Hebrew defaults
- `DESIGN.md` — visual identity (navy + orange + Kikkaboo branding)
- `assets/branding/kikkaboo-logo.png` — auto-copied from shared/branding
- `audio/` and `renders/` — empty, populated when you run TTS and render

## Before rendering

Drop product images into `assets/`:
- `hero.gif` — product hero shot (animated 360° GIF works well)
- `install.jpg` — product in use / installed

Filenames are wired in `index.html`. If you want different filenames, update the HTML references.

## Flow

1. **Scaffold** — creates the project
2. **Open editor** — `npm run studio`, click the project card, edit texts
3. **Add images** — drop files into `assets/`
4. **Save in editor** — triggers TTS for any changed voiceover
5. **Render** — `npm run render -- my-new-video` (draft) or `--high` (final)
