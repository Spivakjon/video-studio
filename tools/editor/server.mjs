// Video Studio — editor server.
//
// Serves the UI and provides the HTTP API for:
//   - listing projects (with thumbnails, duration, render status)
//   - listing templates
//   - creating projects from templates
//   - editing texts + voiceovers
//   - uploading / deleting assets
//   - kicking off renders and polling their progress
//   - serving rendered MP4s, audio WAVs, and scene thumbnails
//
// Usage (from video-studio/):  npm run studio
// Requires:  GEMINI_API_KEY env, ffmpeg on PATH, node >= 18.

import { createServer } from "node:http";
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, rmSync,
  readdirSync, statSync, copyFileSync, createReadStream
} from "node:fs";
import { resolve, dirname, basename, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { estimateDraft, generateDraft, generateVideoPipeline, factCheckDraft, checkBudget as checkAiBudget } from "../claude-api.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUDIO_ROOT = resolve(__dirname, "..", "..");

// Tiny .env loader — no dependency on dotenv. Runs before env is read.
(function loadDotEnv() {
  const envPath = resolve(STUDIO_ROOT, ".env");
  if (!existsSync(envPath)) return;
  try {
    for (const raw of readFileSync(envPath, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (e) { console.warn("  .env load failed:", e.message); }
})();
// When a persistent volume is mounted (e.g. Railway mounts /app/data), read/write
// user data there so it survives deploys. Code-owned dirs stay in the image.
const DATA_ROOT = process.env.STUDIO_DATA_ROOT || STUDIO_ROOT;
const VIDEOS_DIR = resolve(DATA_ROOT, "videos");
const BUSINESS_PROJECTS_DIR = resolve(DATA_ROOT, "projects");
const TEMPLATES_DIR = resolve(STUDIO_ROOT, "templates");   // shipped, read-only
const BRANDING_DIR = resolve(STUDIO_ROOT, "shared", "branding");   // shipped defaults
const UI_DIR = resolve(__dirname, "ui");
const SCAN_ROOT = process.env.STUDIO_SCAN_ROOT ||
  "C:\\Users\\spiva\\OneDrive\\Desktop\\כללי פרויקטים";
const PORT = Number(process.env.PORT || process.env.STUDIO_PORT || 3003);
const TTS_MODEL = "gemini-3.1-flash-tts-preview";

// Curated voice list (Gemini TTS prebuilt voices we've tested).
const VOICES = [
  { name: "Charon", label: "Charon — עמוק, סמכותי (ברירת מחדל)" },
  { name: "Kore", label: "Kore — חם, ידידותי" },
  { name: "Puck", label: "Puck — אנרגטי, צעיר" },
  { name: "Aoede", label: "Aoede — רך, רגוע" },
  { name: "Zephyr", label: "Zephyr — קליל, אופטימי" },
  { name: "Fenrir", label: "Fenrir — חזק, גברי" },
  { name: "Leda", label: "Leda — בהיר, נשי" },
  { name: "Orus", label: "Orus — נמוך, שקט" },
  { name: "Callirrhoe", label: "Callirrhoe — מבוגר, סיפורי" },
  { name: "Enceladus", label: "Enceladus — רציני, מקצועי" }
];

// =======================================================================
// Manifest + HTML editing helpers
// =======================================================================

function safeName(name) {
  if (!name || /[\\/]/.test(name) || name.includes("..")) {
    throw new Error("invalid name");
  }
  return name;
}
function projectDir(name) {
  const dir = resolve(VIDEOS_DIR, safeName(name));
  if (!existsSync(dir)) throw new Error(`project not found: ${name}`);
  return dir;
}
function loadManifest(name) {
  return JSON.parse(readFileSync(resolve(projectDir(name), "texts-manifest.json"), "utf8"));
}
function saveManifest(name, m) {
  writeFileSync(resolve(projectDir(name), "texts-manifest.json"), JSON.stringify(m, null, 2), "utf8");
}

function replaceScreenText(html, elementId, newValue) {
  const needle = `id="${elementId}"`;
  const idx = html.indexOf(needle);
  if (idx === -1) throw new Error(`element id="${elementId}" not found`);
  const gt = html.indexOf(">", idx);
  if (gt === -1) throw new Error(`malformed opening tag for ${elementId}`);
  const lt = html.indexOf("<", gt);
  if (lt === -1) throw new Error(`no closing tag for ${elementId}`);
  return html.slice(0, gt + 1) + newValue + html.slice(lt);
}

// Parse index.html for scene clips and their timing.
function readScenes(name) {
  const html = readFileSync(resolve(projectDir(name), "index.html"), "utf8");
  const scenes = [];
  // Rough regex: <div id="sN" class="scene ... clip" data-start="X" data-duration="Y"
  const re = /<div\s+id="(s\d+)"\s+class="scene[^"]*clip"[^>]*data-start="([\d.]+)"[^>]*data-duration="([\d.]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    scenes.push({ id: m[1], start: parseFloat(m[2]), duration: parseFloat(m[3]) });
  }
  const totalRe = /data-composition-id="[^"]+"\s+data-start="0"\s+data-duration="([\d.]+)"/;
  const tm = html.match(totalRe);
  const total = tm ? parseFloat(tm[1]) : scenes.reduce((a, s) => Math.max(a, s.start + s.duration), 0);
  return { scenes: scenes.sort((a, b) => a.start - b.start), totalDuration: total };
}

// =======================================================================
// TTS
// =======================================================================

function pcmToWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28); buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34); buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40); pcm.copy(buf, 44);
  return buf;
}

async function synthesiseLine(text, voiceName) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${apiKey}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
      }
    })
  });
  if (!r.ok) throw new Error(`TTS HTTP ${r.status}: ${(await r.text()).slice(0, 400)}`);
  const j = await r.json();
  const b64 = j?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  const mime = j?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.mimeType || "";
  if (!b64) throw new Error("no audio in response");
  const rate = parseInt((mime.match(/rate=(\d+)/) || [, "24000"])[1], 10);
  return pcmToWav(Buffer.from(b64, "base64"), rate);
}

async function regenerateAudio(name, item, voiceName) {
  const pDir = projectDir(name);
  const audioDir = resolve(pDir, "audio");
  const rawDir = resolve(audioDir, "raw");
  mkdirSync(audioDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });
  const out = resolve(audioDir, item.audioFile);
  const rawOut = resolve(rawDir, item.audioFile);
  const wav = await synthesiseLine(item.value, voiceName);
  writeFileSync(rawOut, wav);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", rawOut,
    "-af",
    "silenceremove=start_periods=1:start_silence=0.15:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_silence=0.2:start_threshold=-50dB,areverse",
    out
  ]);
}

// =======================================================================
// Thumbnails
// =======================================================================

function latestRender(name) {
  const dir = resolve(projectDir(name), "renders");
  if (!existsSync(dir)) return null;
  const mp4s = readdirSync(dir).filter(f => f.endsWith(".mp4")).map(f => ({
    file: f,
    path: resolve(dir, f),
    mtime: statSync(resolve(dir, f)).mtimeMs
  })).sort((a, b) => b.mtime - a.mtime);
  return mp4s[0] || null;
}

function extractThumbnails(name) {
  const render = latestRender(name);
  if (!render) return { ok: false, reason: "no render" };
  const thumbsDir = resolve(projectDir(name), ".studio", "thumbnails");
  mkdirSync(thumbsDir, { recursive: true });
  const { scenes, totalDuration } = readScenes(name);
  const outputs = [];
  for (const s of scenes) {
    const t = (s.start + s.duration / 2).toFixed(2);
    const outPath = resolve(thumbsDir, `${s.id}.jpg`);
    try {
      execFileSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-ss", t,
        "-i", render.path,
        "-frames:v", "1",
        "-q:v", "4",
        "-vf", "scale=640:-1",
        outPath
      ]);
      outputs.push({ scene: s.id, t, path: outPath });
    } catch (e) {
      outputs.push({ scene: s.id, t, error: String(e.message || e) });
    }
  }
  // Poster: middle of video (or first scene's thumbnail)
  const posterOut = resolve(thumbsDir, "poster.jpg");
  try {
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(Math.max(1, totalDuration * 0.1)),
      "-i", render.path,
      "-frames:v", "1",
      "-q:v", "3",
      "-vf", "scale=960:-1",
      posterOut
    ]);
  } catch {}
  writeFileSync(resolve(thumbsDir, "source.json"), JSON.stringify({
    sourceFile: render.file,
    sourceMtime: render.mtime,
    extractedAt: Date.now(),
    scenes: outputs.length
  }, null, 2));
  return { ok: true, scenes: outputs.length, poster: existsSync(posterOut) };
}

function thumbnailsFresh(name) {
  const thumbsDir = resolve(projectDir(name), ".studio", "thumbnails");
  const srcInfo = resolve(thumbsDir, "source.json");
  if (!existsSync(srcInfo)) return false;
  const render = latestRender(name);
  if (!render) return false;
  try {
    const info = JSON.parse(readFileSync(srcInfo, "utf8"));
    return info.sourceMtime === render.mtime;
  } catch { return false; }
}

// =======================================================================
// Project discovery
// =======================================================================

function listVideos() {
  if (!existsSync(VIDEOS_DIR)) return [];
  const out = [];
  for (const name of readdirSync(VIDEOS_DIR)) {
    const dir = resolve(VIDEOS_DIR, name);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = resolve(dir, "texts-manifest.json");
    if (!existsSync(manifestPath)) continue;
    let m;
    try { m = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { continue; }
    const render = latestRender(name);
    let duration = 0;
    try { duration = readScenes(name).totalDuration; } catch {}
    out.push({
      name,
      project: m.project || name,
      brand: m.brand || null,
      businessProject: m.businessProject || null,
      language: m.language || "en",
      voice: m.ttsVoice || "Charon",
      itemCount: (m.items || []).length,
      voiceoverCount: (m.items || []).filter(i => i.kind === "voiceover").length,
      duration: Math.round(duration * 10) / 10,
      latestRender: render ? { file: render.file, size: statSync(render.path).size, mtime: render.mtime } : null,
      hasPoster: existsSync(resolve(dir, ".studio", "thumbnails", "poster.jpg"))
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// =======================================================================
// Business projects (brand / business entities that own videos)
// =======================================================================

function businessProjectDir(id) {
  return resolve(BUSINESS_PROJECTS_DIR, safeName(id));
}

function loadBusinessProject(id) {
  const dir = businessProjectDir(id);
  const metaPath = resolve(dir, "project.json");
  if (!existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    const logoPath = resolve(dir, "branding", "logo.png");
    meta.hasLogo = existsSync(logoPath);
    meta.hasContext = existsSync(resolve(dir, "context.md"));
    return meta;
  } catch { return null; }
}

function listBusinessProjects() {
  if (!existsSync(BUSINESS_PROJECTS_DIR)) return [];
  const out = [];
  for (const name of readdirSync(BUSINESS_PROJECTS_DIR)) {
    const dir = resolve(BUSINESS_PROJECTS_DIR, name);
    if (!statSync(dir).isDirectory()) continue;
    const p = loadBusinessProject(name);
    if (!p) continue;
    // Count videos linked to this business project
    let videoCount = 0;
    try {
      for (const vname of readdirSync(VIDEOS_DIR)) {
        const mpath = resolve(VIDEOS_DIR, vname, "texts-manifest.json");
        if (!existsSync(mpath)) continue;
        const m = JSON.parse(readFileSync(mpath, "utf8"));
        if (m.businessProject === name || m.brand === name) videoCount++;
      }
    } catch {}
    p.videoCount = videoCount;
    out.push(p);
  }
  return out.sort((a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id));
}

// Scan the configured root for folders that could become business projects.
function discoverExternalProjects() {
  if (!existsSync(SCAN_ROOT)) return { scanRoot: SCAN_ROOT, found: [], error: "scan root not found" };
  const registered = listBusinessProjects();
  const registeredPaths = new Set(registered.map(p => (p.sourceDir || "").toLowerCase()));
  const registeredNames = new Map(registered.map(p => [p.id, p]));
  const found = [];
  try {
    for (const name of readdirSync(SCAN_ROOT)) {
      if (name.startsWith(".") || name.startsWith("_")) continue;
      const p = resolve(SCAN_ROOT, name);
      let stat;
      try { stat = statSync(p); } catch { continue; }
      if (!stat.isDirectory()) continue;
      // Skip the studio itself if it happens to be here
      if (p === STUDIO_ROOT) continue;
      const suggestedId = slugFromFolderName(name);
      const registeredAs = [...registeredNames.values()].find(r =>
        (r.sourceDir || "").toLowerCase() === p.toLowerCase()
      );
      found.push({
        folderName: name,
        path: p,
        suggestedId,
        mtime: stat.mtimeMs,
        isRegistered: Boolean(registeredAs),
        registeredAs: registeredAs ? registeredAs.id : null
      });
    }
  } catch (e) {
    return { scanRoot: SCAN_ROOT, found: [], error: String(e.message || e) };
  }
  found.sort((a, b) => a.folderName.localeCompare(b.folderName));
  return { scanRoot: SCAN_ROOT, found };
}

// Produce a URL-safe id from a folder name. Hebrew collapses to empty;
// fall back to a short hash so two Hebrew-only folders don't collide.
function slugFromFolderName(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^\x20-\x7e]+/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug && /[a-z0-9]/.test(slug)) return slug;
  const hash = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);
  return "project-" + hash.toString(36);
}

function saveBusinessProject(id, data) {
  const dir = businessProjectDir(id);
  mkdirSync(dir, { recursive: true });
  mkdirSync(resolve(dir, "branding"), { recursive: true });
  const metaPath = resolve(dir, "project.json");
  const current = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
  const merged = {
    id,
    name: data.name || current.name || id,
    displayName: data.displayName || data.name || current.displayName || id,
    description: data.description !== undefined ? data.description : (current.description || ""),
    sourceDir: data.sourceDir !== undefined ? data.sourceDir : (current.sourceDir || ""),
    defaultTemplate: data.defaultTemplate || current.defaultTemplate || "",
    defaultVoice: data.defaultVoice || current.defaultVoice || "Charon",
    language: data.language || current.language || "he",
    colors: data.colors || current.colors || {}
  };
  writeFileSync(metaPath, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

function listTemplates() {
  if (!existsSync(TEMPLATES_DIR)) return [];
  const out = [];
  for (const name of readdirSync(TEMPLATES_DIR)) {
    const dir = resolve(TEMPLATES_DIR, name);
    if (!statSync(dir).isDirectory()) continue;
    const metaPath = resolve(dir, "template.json");
    let meta = {};
    if (existsSync(metaPath)) {
      try { meta = JSON.parse(readFileSync(metaPath, "utf8")); } catch {}
    }
    const hasPoster = existsSync(resolve(dir, ".studio", "thumbnails", "poster.jpg"));
    out.push({
      id: name,
      name: meta.title || name,
      description: meta.description || "",
      brand: meta.brand || null,
      aspectRatio: meta.aspectRatio || "16:9",
      duration: meta.duration || "",
      language: meta.language || "he",
      hasPoster,
      createdFrom: meta.createdFrom || null,
      isSystem: name === "kikkaboo-4step"
    });
  }
  return out;
}

// =======================================================================
// Scaffold (create new project from template)
// =======================================================================

function copyRecursive(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = resolve(src, entry);
    const d = resolve(dst, entry);
    if (statSync(s).isDirectory()) copyRecursive(s, d);
    else copyFileSync(s, d);
  }
}

function scaffoldProject({ from, to, brand, businessProject }) {
  const tDir = resolve(TEMPLATES_DIR, safeName(from));
  const pDir = resolve(VIDEOS_DIR, safeName(to));
  if (!existsSync(tDir)) throw new Error(`template not found: ${from}`);
  if (existsSync(pDir)) throw new Error(`project exists: ${to}`);

  // Resolve business-project if provided (overrides loose brand string)
  let bp = null;
  if (businessProject) {
    bp = loadBusinessProject(businessProject);
    if (!bp) throw new Error(`business project not found: ${businessProject}`);
    brand = bp.id;
  }

  copyRecursive(tDir, pDir);

  const cleanBrand = (brand || "").trim();
  const placeholders = {
    PROJECT_NAME: to,
    PROJECT_NAME_UPPER: to.replace(/[-_]/g, " ").toUpperCase(),
    BRAND: cleanBrand,
    BRAND_UPPER: (bp?.displayName || cleanBrand).toUpperCase()
  };
  const textExts = new Set([".html", ".json", ".md", ".css", ".js", ".mjs"]);
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const p = resolve(dir, entry);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!textExts.has(extname(p))) continue;
      let content = readFileSync(p, "utf8");
      let changed = false;
      for (const [k, v] of Object.entries(placeholders)) {
        const re = new RegExp(`\\{\\{${k}\\}\\}`, "g");
        if (re.test(content)) { content = content.replace(re, v); changed = true; }
      }
      if (changed) writeFileSync(p, content, "utf8");
    }
  }
  walk(pDir);

  // Copy brand logo
  let logoCopied = false;
  if (bp && bp.hasLogo) {
    const src = resolve(businessProjectDir(businessProject), "branding", "logo.png");
    if (existsSync(src)) {
      const dst = resolve(pDir, "assets", "branding");
      mkdirSync(dst, { recursive: true });
      copyFileSync(src, resolve(dst, `${bp.id}-logo.png`));
      logoCopied = true;
    }
  }
  if (!logoCopied && brand) {
    const src = resolve(BRANDING_DIR, `${brand}-logo.png`);
    if (existsSync(src)) {
      const dst = resolve(pDir, "assets", "branding");
      mkdirSync(dst, { recursive: true });
      copyFileSync(src, resolve(dst, `${brand}-logo.png`));
    }
  }

  // Record the businessProject link in the manifest
  if (businessProject) {
    const mfPath = resolve(pDir, "texts-manifest.json");
    if (existsSync(mfPath)) {
      const m = JSON.parse(readFileSync(mfPath, "utf8"));
      m.businessProject = businessProject;
      if (!m.brand || m.brand === "{{BRAND}}") m.brand = brand;
      writeFileSync(mfPath, JSON.stringify(m, null, 2), "utf8");
    }
  }

  return { name: to, dir: pDir };
}

// =======================================================================
// Create template from existing project
// =======================================================================

function createTemplateFromProject({ sourceProject, templateId, title, description, brand, strategy }) {
  if (!sourceProject || !templateId) throw new Error("sourceProject and templateId are required");
  safeName(sourceProject); safeName(templateId);
  const srcDir = projectDir(sourceProject);
  const dstDir = resolve(TEMPLATES_DIR, templateId);
  if (existsSync(dstDir)) throw new Error(`template already exists: ${templateId}`);

  // Copy everything
  copyRecursive(srcDir, dstDir);

  // Strip artifacts that shouldn't live in a template
  for (const sub of ["audio", "renders", ".studio"]) {
    const p = resolve(dstDir, sub);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }

  // Load manifest + html
  const manifestPath = resolve(dstDir, "texts-manifest.json");
  const htmlPath = resolve(dstDir, "index.html");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let html = readFileSync(htmlPath, "utf8");

  // Templatize project/brand metadata regardless of strategy
  manifest.project = "{{PROJECT_NAME}}";
  manifest.brand = "{{BRAND}}";

  if (strategy === "reset") {
    // Replace each value with a placeholder derived from its label.
    for (const item of manifest.items) {
      let placeholder;
      if (item.id === "brand-mark") placeholder = "{{BRAND_UPPER}} · {{PROJECT_NAME_UPPER}}";
      else if (item.id === "s6-brand") placeholder = "{{BRAND_UPPER}}";
      else placeholder = `[${item.label}]`;
      item.value = placeholder;
      if (item.kind === "screen" && item.elementId) {
        try { html = replaceScreenText(html, item.elementId, placeholder); } catch {}
      }
    }
  } else {
    // "keep" strategy — just ensure brand-mark uses placeholders so scaffold can re-fill
    const bm = manifest.items.find(i => i.id === "brand-mark");
    if (bm) {
      bm.value = "{{BRAND_UPPER}} · {{PROJECT_NAME_UPPER}}";
      try { html = replaceScreenText(html, "brand-mark", bm.value); } catch {}
    }
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  writeFileSync(htmlPath, html, "utf8");

  // Copy poster from source's thumbnails (if any)
  const srcPoster = resolve(srcDir, ".studio", "thumbnails", "poster.jpg");
  if (existsSync(srcPoster)) {
    const dstThumbs = resolve(dstDir, ".studio", "thumbnails");
    mkdirSync(dstThumbs, { recursive: true });
    copyFileSync(srcPoster, resolve(dstThumbs, "poster.jpg"));
  }

  // Compute metadata
  let totalDuration = 0;
  try {
    const re = /data-composition-id="[^"]+"\s+data-start="0"\s+data-duration="([\d.]+)"/;
    const m = html.match(re);
    if (m) totalDuration = parseFloat(m[1]);
  } catch {}
  const widthMatch = html.match(/data-width="(\d+)"/);
  const heightMatch = html.match(/data-height="(\d+)"/);
  const aspectRatio = widthMatch && heightMatch
    ? `${widthMatch[1]}:${heightMatch[1]}`.replace(/(\d+):(\d+)/, (_, w, h) => {
        const gcd = (a, b) => b ? gcd(b, a % b) : a;
        const g = gcd(parseInt(w), parseInt(h));
        return `${parseInt(w) / g}:${parseInt(h) / g}`;
      })
    : "16:9";

  const meta = {
    name: templateId,
    title: title || templateId,
    description: description || "",
    brand: brand || manifest.brand || null,
    aspectRatio,
    resolution: widthMatch && heightMatch ? `${widthMatch[1]}x${heightMatch[1]}` : "1920x1080",
    language: manifest.language || "he",
    duration: totalDuration ? `~${Math.round(totalDuration)}s` : "",
    defaultVoice: manifest.ttsVoice || "Charon",
    createdFrom: sourceProject,
    strategy: strategy || "keep"
  };
  writeFileSync(resolve(dstDir, "template.json"), JSON.stringify(meta, null, 2), "utf8");

  return { id: templateId, meta };
}

// =======================================================================
// Render jobs
// =======================================================================

const renderJobs = new Map(); // jobId -> { project, status, progress, phase, startedAt, endedAt, outputFile, error }

function startRender({ project, quality = "draft", fps = 30 }) {
  safeName(project);
  const pDir = projectDir(project);
  const jobId = randomUUID();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const outputFile = `${project}-${quality}-${stamp}.mp4`;
  const outputPath = `renders/${outputFile}`;
  const job = {
    jobId,
    project,
    quality,
    fps,
    status: "running",
    phase: "compiling",
    progress: 0,
    startedAt: Date.now(),
    endedAt: null,
    outputFile,
    error: null
  };
  renderJobs.set(jobId, job);

  const isWin = process.platform === "win32";
  const cmd = isWin ? "npx.cmd" : "npx";
  const args = ["hyperframes", "render",
    "--quality", quality, "--fps", String(fps),
    "--output", outputPath];
  const child = spawn(cmd, args, { cwd: pDir, shell: isWin });

  const onStdout = (buf) => {
    const s = buf.toString();
    // Parse progress from hyperframes output
    const p = s.match(/(\d{1,3})%\s+([A-Za-z ]+?)(?:\s+\(|$|[\r\n])/);
    if (p) {
      const pct = Math.min(100, Math.max(0, parseInt(p[1], 10)));
      job.progress = pct;
      job.phase = p[2].trim();
    }
    // Final "Render complete"
    if (/Render complete/.test(s)) {
      job.progress = 100;
      job.phase = "complete";
    }
  };
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStdout);
  child.on("close", code => {
    job.endedAt = Date.now();
    if (code === 0) {
      job.status = "ok";
      job.progress = 100;
      job.phase = "complete";
      // Extract thumbnails
      try { extractThumbnails(project); } catch (e) { console.warn("thumbnail extract failed:", e.message); }
    } else {
      job.status = "error";
      job.error = `exit code ${code}`;
    }
  });
  child.on("error", e => {
    job.status = "error";
    job.error = String(e.message || e);
    job.endedAt = Date.now();
  });
  return jobId;
}

// =======================================================================
// HTTP helpers
// =======================================================================

function readBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve_, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", c => {
      total += c.length;
      if (total > limit) { reject(new Error("request too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve_(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
function send404(res, msg = "not found") {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end(msg);
}
function sendFile(res, path, contentType, headers = {}) {
  if (!existsSync(path)) return send404(res);
  const stat = statSync(path);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Cache-Control": "no-cache",
    ...headers
  });
  createReadStream(path).pipe(res);
}
function mimeFor(path) {
  const ext = extname(path).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg"
  })[ext] || "application/octet-stream";
}

// =======================================================================
// Routes
// =======================================================================

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    // --- Pages
    if (req.method === "GET" && path === "/") {
      return sendFile(res, resolve(UI_DIR, "home.html"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && path === "/edit") {
      return sendFile(res, resolve(UI_DIR, "edit.html"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && path.startsWith("/ui/")) {
      const rel = path.slice(4);
      if (rel.includes("..")) return send404(res);
      const full = resolve(UI_DIR, rel);
      return sendFile(res, full, mimeFor(full));
    }

    // --- API: listing
    if (req.method === "GET" && path === "/api/projects") {
      return sendJson(res, 200, { videos: listVideos() });
    }
    if (req.method === "GET" && path === "/api/templates") {
      return sendJson(res, 200, { templates: listTemplates() });
    }
    if (req.method === "GET" && path === "/api/voices") {
      return sendJson(res, 200, { voices: VOICES });
    }

    // --- API: Veo budget (reads .gcp/usage-log.jsonl + config)
    if (req.method === "GET" && path === "/api/veo/budget") {
      const gcpDir = resolve(STUDIO_ROOT, ".gcp");
      const logPath = resolve(gcpDir, "usage-log.jsonl");
      const cfgPath = resolve(gcpDir, "config.json");
      let cfg = { monthlyBudgetUsd: 50 };
      if (existsSync(cfgPath)) {
        try { cfg = { ...cfg, ...JSON.parse(readFileSync(cfgPath, "utf8")) }; } catch {}
      }
      const now = new Date();
      const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      const filter = url.searchParams.get("month") || monthKey;
      const allEntries = existsSync(logPath)
        ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        : [];
      const entries = allEntries.filter(e => (e.at || "").slice(0, 7) === filter);
      const totalUsd = parseFloat(entries.reduce((s, e) => s + (e.estCostUsd || 0), 0).toFixed(2));
      const remaining = parseFloat((cfg.monthlyBudgetUsd - totalUsd).toFixed(2));
      const pct = cfg.monthlyBudgetUsd > 0 ? Math.round(totalUsd / cfg.monthlyBudgetUsd * 100) : 0;
      const allTimeTotal = parseFloat(allEntries.reduce((s, e) => s + (e.estCostUsd || 0), 0).toFixed(2));
      return sendJson(res, 200, {
        monthKey: filter,
        capUsd: cfg.monthlyBudgetUsd,
        spentUsd: totalUsd,
        remainingUsd: remaining,
        percentUsed: pct,
        callCount: entries.length,
        allTimeSpentUsd: allTimeTotal,
        allTimeCallCount: allEntries.length,
        entries: entries.slice(-20).reverse()
      });
    }

    // --- API: business projects
    if (req.method === "GET" && path === "/api/business-projects") {
      return sendJson(res, 200, { projects: listBusinessProjects() });
    }
    if (req.method === "GET" && path === "/api/discover-projects") {
      return sendJson(res, 200, discoverExternalProjects());
    }
    if (req.method === "POST" && path === "/api/business-project/register-discovered") {
      // Register a discovered folder as a business project in one step.
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      if (!body.path) return sendJson(res, 400, { error: "path required" });
      const folderName = body.folderName || basename(body.path);
      const id = body.id || slugFromFolderName(folderName);
      if (existsSync(businessProjectDir(id))) {
        return sendJson(res, 200, { ok: true, id, existed: true, project: loadBusinessProject(id) });
      }
      const saved = saveBusinessProject(id, {
        name: folderName,
        displayName: folderName,
        description: `רשום אוטומטית מתיקייה: ${body.path}`,
        sourceDir: body.path,
        defaultTemplate: "kikkaboo-4step",
        defaultVoice: "Charon",
        language: "he"
      });
      writeFileSync(
        resolve(businessProjectDir(id), "context.md"),
        `# ${folderName}\n\nנוצר אוטומטית מ-${body.path}.\n\nתוכל להעשיר את ההקשר הזה (מוצרים, טון, קהל יעד) דרך כרטיס הפרויקט בדשבורד.\n`,
        "utf8"
      );
      return sendJson(res, 200, { ok: true, id, existed: false, project: loadBusinessProject(id) });
    }
    if (req.method === "GET" && path === "/api/business-project") {
      const id = url.searchParams.get("id");
      const p = loadBusinessProject(id);
      if (!p) return sendJson(res, 404, { error: "not found" });
      let context = "";
      const ctxPath = resolve(businessProjectDir(id), "context.md");
      if (existsSync(ctxPath)) context = readFileSync(ctxPath, "utf8");
      return sendJson(res, 200, { ...p, context });
    }
    if (req.method === "POST" && path === "/api/business-project") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      if (!body.id || !/^[a-z0-9][a-z0-9-_]*$/i.test(body.id)) {
        return sendJson(res, 400, { error: "invalid id" });
      }
      const saved = saveBusinessProject(body.id, body);
      if (typeof body.context === "string") {
        writeFileSync(resolve(businessProjectDir(body.id), "context.md"), body.context, "utf8");
      }
      // Logo upload (base64)
      if (body.logoData) {
        const b64 = body.logoData.replace(/^data:[^;]+;base64,/, "");
        const dir = resolve(businessProjectDir(body.id), "branding");
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, "logo.png"), Buffer.from(b64, "base64"));
      }
      return sendJson(res, 200, { ok: true, project: loadBusinessProject(body.id) });
    }
    if (req.method === "DELETE" && path === "/api/business-project") {
      const id = url.searchParams.get("id");
      if (!id) return sendJson(res, 400, { error: "id required" });
      rmSync(businessProjectDir(id), { recursive: true, force: true });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && path === "/api/business-project/logo") {
      const id = url.searchParams.get("id");
      if (!id) return send404(res);
      const p = resolve(businessProjectDir(id), "branding", "logo.png");
      return sendFile(res, p, "image/png");
    }

    // --- API: AI (Claude) — autonomous video generation
    //
    // Flow:
    //   1. POST /api/ai/estimate    → returns cost estimate (no API call)
    //   2. User sees cost + approves in UI
    //   3. POST /api/ai/generate-video { ...body, approved: true }
    //       → calls Claude, scaffolds project, applies draft, returns video name
    //
    // Budget cap lives in .ai/config.json. Every call is logged to
    // .ai/usage-log.jsonl and must pass the per-call approval flag.

    if (req.method === "GET" && path === "/api/ai/budget") {
      return sendJson(res, 200, { ...checkAiBudget(), hasKey: Boolean(process.env.ANTHROPIC_API_KEY) });
    }
    if (req.method === "POST" && path === "/api/ai/estimate") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const bp = loadBusinessProject(body.businessProjectId);
      if (!bp) return sendJson(res, 400, { error: "business project not found" });
      const ctxPath = resolve(businessProjectDir(body.businessProjectId), "context.md");
      const contextMd = existsSync(ctxPath) ? readFileSync(ctxPath, "utf8") : "";
      const tplDir = resolve(TEMPLATES_DIR, safeName(body.template || bp.defaultTemplate || "kikkaboo-4step"));
      const tplManifestPath = resolve(tplDir, "texts-manifest.json");
      if (!existsSync(tplManifestPath)) return sendJson(res, 400, { error: "template manifest missing" });
      const template = JSON.parse(readFileSync(tplManifestPath, "utf8"));
      const est = estimateDraft({ projectMeta: bp, contextMd, template, userPrompt: body.prompt || "" });
      const budget = checkAiBudget();
      return sendJson(res, 200, { ...est, budget });
    }
    if (req.method === "POST" && path === "/api/ai/generate-video") {
      if (!process.env.ANTHROPIC_API_KEY) {
        return sendJson(res, 400, { error: "ANTHROPIC_API_KEY not set on server" });
      }
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      if (!body.approved) return sendJson(res, 400, { error: "missing approval flag" });
      if (!body.businessProjectId) return sendJson(res, 400, { error: "businessProjectId required" });
      if (!body.videoName) return sendJson(res, 400, { error: "videoName required" });
      const bp = loadBusinessProject(body.businessProjectId);
      if (!bp) return sendJson(res, 400, { error: "business project not found" });
      const ctxPath = resolve(businessProjectDir(body.businessProjectId), "context.md");
      const contextMd = existsSync(ctxPath) ? readFileSync(ctxPath, "utf8") : "";
      const tplId = body.template || bp.defaultTemplate || "kikkaboo-4step";
      const tplManifestPath = resolve(TEMPLATES_DIR, safeName(tplId), "texts-manifest.json");
      if (!existsSync(tplManifestPath)) return sendJson(res, 400, { error: "template manifest missing" });
      const template = JSON.parse(readFileSync(tplManifestPath, "utf8"));

      // Run the full quality pipeline: 3 drafts → judge → editor → fact-check
      let pipeline;
      try {
        pipeline = await generateVideoPipeline({
          projectMeta: bp,
          contextMd,
          template,
          userPrompt: body.prompt || ""
        });
      } catch (e) {
        return sendJson(res, 500, { error: String(e.message || e) });
      }

      // Scaffold the new video project using the existing scaffolder.
      let scaffolded;
      try {
        scaffolded = scaffoldProject({
          from: tplId,
          to: body.videoName,
          brand: bp.id,
          businessProject: bp.id
        });
      } catch (e) {
        return sendJson(res, 500, {
          error: `scaffold failed: ${e.message}`,
          pipeline: pipeline.pipeline
        });
      }

      // Apply final item values on top of the scaffold.
      const manifest = loadManifest(scaffolded.name);
      const byId = new Map(manifest.items.map(it => [it.id, it]));
      const applied = [];
      for (const d of pipeline.finalItems) {
        const item = byId.get(d.id);
        if (!item || typeof d.value !== "string") continue;
        item.value = d.value;
        applied.push(d.id);
      }
      if (pipeline.ttsVoice && typeof pipeline.ttsVoice === "string") {
        manifest.ttsVoice = pipeline.ttsVoice;
      }
      manifest.aiDraft = {
        at: new Date().toISOString(),
        model: pipeline.pipeline.model,
        prompt: body.prompt || "",
        notes: pipeline.notes,
        estCostUsd: pipeline.estCostUsd,
        pipeline: pipeline.pipeline,
        sourceMarkdownsSeen: (pipeline.sourceMarkdowns?.files || []).map(f => f.rel),
        wordBudget: pipeline.wordBudget
      };
      saveManifest(scaffolded.name, manifest);

      // Also apply screen text into index.html so editor preview is accurate.
      try {
        const htmlPath = resolve(scaffolded.dir, "index.html");
        let html = readFileSync(htmlPath, "utf8");
        for (const item of manifest.items) {
          if (item.kind !== "screen" || !item.elementId) continue;
          try { html = replaceScreenText(html, item.elementId, item.value); } catch {}
        }
        writeFileSync(htmlPath, html, "utf8");
      } catch (e) { console.warn("html apply failed:", e.message); }

      return sendJson(res, 200, {
        ok: true,
        videoName: scaffolded.name,
        itemsApplied: applied.length,
        totalItems: manifest.items.length,
        estCostUsd: pipeline.estCostUsd,
        model: pipeline.pipeline.model,
        notes: pipeline.notes,
        sourceMarkdownsSeen: (pipeline.sourceMarkdowns?.files || []).map(f => f.rel),
        wordBudget: pipeline.wordBudget,
        pipeline: pipeline.pipeline
      });
    }

    // --- API: project CRUD
    if (req.method === "POST" && path === "/api/project") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      if (!body.name || !body.template) {
        return sendJson(res, 400, { error: "name and template are required" });
      }
      const r = scaffoldProject({
        from: body.template,
        to: body.name,
        brand: body.brand,
        businessProject: body.businessProject
      });
      return sendJson(res, 200, { ok: true, name: r.name });
    }
    if (req.method === "DELETE" && path === "/api/project") {
      const name = url.searchParams.get("name");
      const dir = projectDir(name);
      rmSync(dir, { recursive: true, force: true });
      return sendJson(res, 200, { ok: true });
    }

    // --- API: texts + save
    if (req.method === "GET" && path === "/api/texts") {
      return sendJson(res, 200, loadManifest(url.searchParams.get("project")));
    }
    if (req.method === "POST" && path === "/api/save") {
      const name = url.searchParams.get("project");
      const payload = JSON.parse((await readBody(req)).toString("utf8"));
      const manifest = loadManifest(name);
      if (payload.voice) manifest.ttsVoice = payload.voice;

      // Snapshot BEFORE changes (pre-save), keep last 10
      try {
        const snapDir = resolve(projectDir(name), ".studio", "snapshots");
        mkdirSync(snapDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const snapPath = resolve(snapDir, ts);
        mkdirSync(snapPath, { recursive: true });
        writeFileSync(resolve(snapPath, "texts-manifest.json"), readFileSync(resolve(projectDir(name), "texts-manifest.json"), "utf8"));
        writeFileSync(resolve(snapPath, "index.html"), readFileSync(resolve(projectDir(name), "index.html"), "utf8"));
        const all = readdirSync(snapDir).filter(e => statSync(resolve(snapDir, e)).isDirectory()).sort();
        while (all.length > 10) {
          rmSync(resolve(snapDir, all.shift()), { recursive: true, force: true });
        }
      } catch (e) { console.warn("snapshot failed:", e.message); }
      const byId = new Map(manifest.items.map(it => [it.id, it]));
      const screenChanges = [];
      const voChanges = [];
      for (const [id, newValue] of Object.entries(payload.values || {})) {
        const item = byId.get(id);
        if (!item) continue;
        if (item.value === newValue) continue;
        item.value = newValue;
        (item.kind === "voiceover" ? voChanges : screenChanges).push(item);
      }
      // If voice changed and user opted to re-voice everything, queue all VO items
      if (payload.revoiceAll) {
        for (const item of manifest.items) {
          if (item.kind === "voiceover" && !voChanges.includes(item)) voChanges.push(item);
        }
      }
      saveManifest(name, manifest);
      if (screenChanges.length) {
        const htmlPath = resolve(projectDir(name), "index.html");
        let html = readFileSync(htmlPath, "utf8");
        for (const item of screenChanges) html = replaceScreenText(html, item.elementId, item.value);
        writeFileSync(htmlPath, html, "utf8");
      }
      const regenResults = [];
      for (const item of voChanges) {
        try {
          await regenerateAudio(name, item, manifest.ttsVoice || "Charon");
          regenResults.push({ id: item.id, status: "ok" });
        } catch (e) {
          regenResults.push({ id: item.id, status: "error", error: String(e.message || e) });
        }
      }
      return sendJson(res, 200, {
        ok: true,
        screenChanged: screenChanges.map(i => i.id),
        voiceoverChanged: voChanges.map(i => i.id),
        regenResults
      });
    }

    // --- API: scenes (for side panel)
    if (req.method === "GET" && path === "/api/scenes") {
      const name = url.searchParams.get("project");
      return sendJson(res, 200, readScenes(name));
    }

    // --- API: snapshots (history)
    if (req.method === "GET" && path === "/api/snapshots") {
      const name = url.searchParams.get("project");
      const snapDir = resolve(projectDir(name), ".studio", "snapshots");
      if (!existsSync(snapDir)) return sendJson(res, 200, { snapshots: [] });
      const snaps = readdirSync(snapDir)
        .filter(e => statSync(resolve(snapDir, e)).isDirectory())
        .sort()
        .reverse()
        .map(id => ({ id, mtime: statSync(resolve(snapDir, id)).mtimeMs }));
      return sendJson(res, 200, { snapshots: snaps });
    }
    if (req.method === "POST" && path === "/api/snapshot/restore") {
      const name = url.searchParams.get("project");
      const id = url.searchParams.get("id");
      if (!name || !id) return sendJson(res, 400, { error: "project and id required" });
      const snapPath = resolve(projectDir(name), ".studio", "snapshots", id);
      if (!existsSync(snapPath)) return sendJson(res, 404, { error: "snapshot not found" });
      // Snapshot the CURRENT state first (so the restore is itself reversible)
      const pDir = projectDir(name);
      const ts = "before-restore-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const beforeDir = resolve(pDir, ".studio", "snapshots", ts);
      mkdirSync(beforeDir, { recursive: true });
      writeFileSync(resolve(beforeDir, "texts-manifest.json"), readFileSync(resolve(pDir, "texts-manifest.json"), "utf8"));
      writeFileSync(resolve(beforeDir, "index.html"), readFileSync(resolve(pDir, "index.html"), "utf8"));
      // Restore
      writeFileSync(resolve(pDir, "texts-manifest.json"), readFileSync(resolve(snapPath, "texts-manifest.json"), "utf8"));
      writeFileSync(resolve(pDir, "index.html"), readFileSync(resolve(snapPath, "index.html"), "utf8"));
      return sendJson(res, 200, { ok: true });
    }

    // --- API: create template from existing project
    if (req.method === "POST" && path === "/api/template") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const result = createTemplateFromProject(body);
      return sendJson(res, 200, { ok: true, ...result });
    }
    if (req.method === "DELETE" && path === "/api/template") {
      const id = url.searchParams.get("id");
      if (!id) return sendJson(res, 400, { error: "id required" });
      const dir = resolve(TEMPLATES_DIR, safeName(id));
      if (!existsSync(dir)) return sendJson(res, 404, { error: "template not found" });
      rmSync(dir, { recursive: true, force: true });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && path === "/api/template/thumbnail") {
      const id = url.searchParams.get("id");
      if (!id) return send404(res);
      const p = resolve(TEMPLATES_DIR, safeName(id), ".studio", "thumbnails", "poster.jpg");
      if (!existsSync(p)) return send404(res);
      return sendFile(res, p, "image/jpeg");
    }

    // --- API: assets
    if (req.method === "GET" && path === "/api/assets") {
      const name = url.searchParams.get("project");
      const aDir = resolve(projectDir(name), "assets");
      if (!existsSync(aDir)) return sendJson(res, 200, { assets: [] });
      const assets = [];
      for (const entry of readdirSync(aDir)) {
        const p = resolve(aDir, entry);
        if (statSync(p).isDirectory()) continue;
        assets.push({
          name: entry,
          size: statSync(p).size,
          mime: mimeFor(p)
        });
      }
      return sendJson(res, 200, { assets });
    }
    if (req.method === "POST" && path === "/api/asset") {
      const name = url.searchParams.get("project");
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      if (!body.name || !body.data) return sendJson(res, 400, { error: "name and data required" });
      if (body.name.includes("/") || body.name.includes("\\") || body.name.includes("..")) {
        return sendJson(res, 400, { error: "invalid filename" });
      }
      const aDir = resolve(projectDir(name), "assets");
      mkdirSync(aDir, { recursive: true });
      // data is base64-encoded (may have `data:...;base64,` prefix)
      const b64 = body.data.replace(/^data:[^;]+;base64,/, "");
      writeFileSync(resolve(aDir, body.name), Buffer.from(b64, "base64"));
      return sendJson(res, 200, { ok: true, name: body.name });
    }
    if (req.method === "DELETE" && path === "/api/asset") {
      const name = url.searchParams.get("project");
      const asset = url.searchParams.get("name");
      if (!asset || asset.includes("/") || asset.includes("..")) {
        return sendJson(res, 400, { error: "invalid filename" });
      }
      const p = resolve(projectDir(name), "assets", asset);
      if (existsSync(p)) rmSync(p);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && path === "/api/asset/preview") {
      const name = url.searchParams.get("project");
      const asset = url.searchParams.get("name");
      const p = resolve(projectDir(name), "assets", basename(asset));
      return sendFile(res, p, mimeFor(p));
    }

    // --- API: thumbnails
    if (req.method === "GET" && path === "/api/thumbnail") {
      const name = url.searchParams.get("project");
      const scene = url.searchParams.get("scene") || "poster";
      // Generate on demand if missing but render exists
      if (!thumbnailsFresh(name)) {
        try { extractThumbnails(name); } catch {}
      }
      const p = resolve(projectDir(name), ".studio", "thumbnails", `${scene}.jpg`);
      if (!existsSync(p)) return send404(res, "no thumbnail");
      return sendFile(res, p, "image/jpeg");
    }

    // --- API: render
    if (req.method === "POST" && path === "/api/render") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const project = body.project || url.searchParams.get("project");
      const quality = body.quality || "draft";
      const fps = body.fps || 30;
      if (!project) return sendJson(res, 400, { error: "project required" });
      const jobId = startRender({ project, quality, fps });
      return sendJson(res, 200, { jobId });
    }
    if (req.method === "GET" && path === "/api/render/status") {
      const jobId = url.searchParams.get("jobId");
      const job = renderJobs.get(jobId);
      if (!job) return send404(res, "job not found");
      return sendJson(res, 200, job);
    }
    if (req.method === "GET" && path === "/api/render/download") {
      const name = url.searchParams.get("project");
      const file = url.searchParams.get("file");
      if (!file) {
        const render = latestRender(name);
        if (!render) return send404(res, "no render");
        return sendFile(res, render.path, "video/mp4", {
          "Content-Disposition": `attachment; filename="${render.file}"`
        });
      }
      const p = resolve(projectDir(name), "renders", basename(file));
      return sendFile(res, p, "video/mp4", {
        "Content-Disposition": `attachment; filename="${basename(p)}"`
      });
    }
    if (req.method === "GET" && path === "/api/render/stream") {
      const name = url.searchParams.get("project");
      const render = latestRender(name);
      if (!render) return send404(res, "no render");
      return sendFile(res, render.path, "video/mp4");
    }

    // --- API: Claude chat (uses the user's local Claude Code CLI)
    if (req.method === "POST" && path === "/api/chat") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const project = body.project;
      const message = (body.message || "").trim();
      if (!message) return sendJson(res, 400, { error: "message required" });
      safeName(project);
      const pDir = projectDir(project);
      const manifest = loadManifest(project);
      const bpContext = manifest.businessProject
        ? (() => { try { return readFileSync(resolve(businessProjectDir(manifest.businessProject), "context.md"), "utf8"); } catch { return ""; } })()
        : "";
      const scriptSummary = (manifest.items || [])
        .map(i => `  [${i.id}] (scene ${i.scene}, ${i.kind}) "${(i.value || "").slice(0, 120)}"`)
        .join("\n");
      const contextPrompt = `הינך עוזר למשתמש לערוך סרטון ב-Video Studio (פרויקט ב-C:\\hf-projects\\video-studio).

הסרטון הנוכחי: "${project}"
פרויקט עסקי: ${manifest.businessProject || "—"}
קול קריינות: ${manifest.ttsVoice || "Charon"}

הסקריפט הנוכחי (id, סצנה, סוג, ערך מקוצר):
${scriptSummary}

${bpContext ? `הקשר הפרויקט העסקי:\n${bpContext}\n` : ""}
שאלת המשתמש:
${message}

ענה קצר, ממוקד ובעברית. אם אתה מציע שינוי טקסט — ציין את ה-id של השדה ואת הטקסט החדש בדיוק.`;

      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      const isWin = process.platform === "win32";
      const cmd = isWin ? "claude.cmd" : "claude";
      const child = spawn(cmd, ["-p", contextPrompt], { cwd: pDir, shell: isWin });
      child.stdout.on("data", d => res.write(d));
      child.stderr.on("data", d => console.error("[chat-stderr]", d.toString()));
      child.on("close", code => {
        if (code !== 0) res.write(`\n\n[שגיאה: claude CLI יצא עם קוד ${code}]`);
        res.end();
      });
      child.on("error", e => { res.write(`\n\n[שגיאה: ${e.message}]`); res.end(); });
      return;
    }

    // --- API: audio playback
    if (req.method === "GET" && path === "/api/audio") {
      const name = url.searchParams.get("project");
      const file = url.searchParams.get("file");
      if (!file) return send404(res);
      const p = resolve(projectDir(name), "audio", basename(file));
      return sendFile(res, p, mimeFor(p));
    }

    send404(res);
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { ok: false, error: String(e.message || e) });
  }
});

// One-time seed: if running on a persistent volume and user data is empty,
// copy shipped videos/projects into the volume so the dashboard isn't empty
// on first Railway deploy.
function seedDataRootIfEmpty() {
  if (DATA_ROOT === STUDIO_ROOT) return;  // local dev — nothing to do
  try {
    mkdirSync(DATA_ROOT, { recursive: true });
    const seedPairs = [
      [resolve(STUDIO_ROOT, "videos"),   VIDEOS_DIR],
      [resolve(STUDIO_ROOT, "projects"), BUSINESS_PROJECTS_DIR]
    ];
    for (const [from, to] of seedPairs) {
      if (!existsSync(from)) continue;
      if (existsSync(to) && readdirSync(to).length > 0) continue;
      mkdirSync(to, { recursive: true });
      for (const entry of readdirSync(from)) {
        const src = resolve(from, entry);
        const dst = resolve(to, entry);
        if (statSync(src).isDirectory()) copyRecursive(src, dst);
      }
      console.log(`  🌱 seeded ${to} from ${from}`);
    }
  } catch (e) {
    console.warn("  ⚠ seed failed:", e.message);
  }
}

seedDataRootIfEmpty();

server.listen(PORT, () => {
  console.log(`\n  Video Studio: http://localhost:${PORT}`);
  console.log(`  Code root:    ${STUDIO_ROOT}`);
  console.log(`  Data root:    ${DATA_ROOT}${DATA_ROOT !== STUDIO_ROOT ? " (persistent volume)" : ""}`);
  console.log(`  Videos:       ${listVideos().length}`);
  console.log(`  Templates:    ${listTemplates().length}\n`);
});
