// Extract verification frames from a video clip or render.
// Usage:
//   node tools/frames.mjs <project> <relpath.mp4> [--n 5] [--at 1,3,5] [--out assets/_frames]
// Examples:
//   node tools/frames.mjs lavi-pilot clips/takeoff.mp4 --n 4
//   node tools/frames.mjs kikkaboo-babyland renders/foo.mp4 --at 2,11,30,57

import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIDEOS_DIR = resolve(__dirname, "..", "videos");

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const project = process.argv[2];
const rel = process.argv[3];
if (!project || !rel) {
  console.error("Usage: node tools/frames.mjs <project> <relpath.mp4> [--n 5] [--at 1,3,5] [--out dir]");
  process.exit(1);
}
const projectDir = resolve(VIDEOS_DIR, project);
const videoPath = resolve(projectDir, rel);
if (!existsSync(videoPath)) { console.error(`Not found: ${videoPath}`); process.exit(1); }

const outDir = resolve(projectDir, arg("out", "assets/_frames"));
mkdirSync(outDir, { recursive: true });

function duration() {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
      "-of", "default=nw=1:nokey=1", videoPath], { encoding: "utf8" });
    return parseFloat(out.trim()) || 0;
  } catch { return 0; }
}

let times;
const atArg = arg("at");
if (atArg) {
  times = atArg.split(",").map(s => parseFloat(s.trim())).filter(t => !isNaN(t));
} else {
  const n = parseInt(arg("n", "5"), 10);
  const dur = duration();
  // evenly spaced, avoiding the very start/end
  times = Array.from({ length: n }, (_, i) => +((dur * (i + 0.5) / n)).toFixed(2));
}

const base = rel.split(/[\\/]/).pop().replace(/\.\w+$/, "");
const made = [];
for (const t of times) {
  const out = resolve(outDir, `${base}_${t}s.png`);
  try {
    execFileSync("ffmpeg", ["-y", "-ss", String(t), "-i", videoPath, "-vframes", "1", out],
      { stdio: ["ignore", "ignore", "ignore"] });
    made.push(out);
  } catch { console.error(`  ✗ frame @${t}s failed`); }
}
console.log(`\n  ✓ ${made.length} frame(s) → ${outDir}`);
for (const m of made) console.log("    " + m);
